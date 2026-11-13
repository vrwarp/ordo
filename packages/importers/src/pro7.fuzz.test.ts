/**
 * Fuzzing of the ProPresenter 7 importer (design/25 "Fuzzing"): random bytes, mutated encodings and
 * protobuf messages built with the real schema from randomized fields (NaN and infinite doubles, huge
 * strings, missing parts, dangling references) must never throw, and every imported entity must pass the
 * domain schema with finite, bounded numbers.
 */
import { Playlist as PlaylistSchema, Presentation as PresentationSchema } from '@ordo/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { importPro7 } from './pro7.ts';
import { pro7Type } from './proto.ts';
import { REAL_RTF } from './fuzz-fixtures.test-util.ts';
import { IMPORT_LIMITS } from './sanitize.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const enc = new TextEncoder();
const dbl = fc.oneof(
  { weight: 3, arbitrary: fc.double({ min: -5000, max: 5000, noNaN: true }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      -999,
      9999,
      1e9,
      -1e9,
      1e308,
      -1e308,
    ),
  },
);
const UUIDS = ['A', 'B', 'C', 'D', 'G1', 'G2', 'ARR', 'X'];
const uuid = fc.constantFrom(...UUIDS).map((s) => ({ string: s }));
const str = fc.oneof(
  { weight: 4, arbitrary: fc.string({ maxLength: 20 }) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 20 }) },
  { weight: 1, arbitrary: fc.nat({ max: 20_000 }).map((n) => 'L'.repeat(n)) },
  { weight: 1, arbitrary: fc.constantFrom('Verse 1', 'Chorus', 'Bridge x2', '') },
);
const color = fc.record({ red: dbl, green: dbl, blue: dbl, alpha: dbl }, { requiredKeys: [] });
const multiRunRtf = fc
  .tuple(
    fc.array(
      fc.record({
        text: fc.string({ minLength: 1, maxLength: 12 }).map((s) => s.replace(/[{}\\;]/g, 'a')),
        bold: fc.boolean(),
        italic: fc.boolean(),
        underline: fc.boolean(),
        strike: fc.boolean(),
        sup: fc.boolean(),
        sub: fc.boolean(),
        scaps: fc.boolean(),
        size: fc.integer({ min: -5, max: 80 }),
        colorIdx: fc.integer({ min: -1, max: 3 }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    fc.boolean(),
  )
  .map(([runs, hasBullets]) => {
    let rtf =
      '{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}{\\colortbl;\\red255\\green0\\blue0;\\red0\\green255\\blue0;\\red0\\green0\\blue255;}';
    for (const r of runs) {
      if (hasBullets) rtf += '{\\listtext •\\tab}';
      if (r.bold) rtf += '\\b ';
      if (r.italic) rtf += '\\i ';
      if (r.underline) rtf += '\\ul ';
      if (r.strike) rtf += '\\strike ';
      if (r.sup) rtf += '\\super ';
      if (r.sub) rtf += '\\sub ';
      if (r.scaps) rtf += '\\scaps ';
      if (r.size > 0) rtf += `\\fs${r.size} `;
      if (r.colorIdx >= 0) rtf += `\\cf${r.colorIdx} `;
      rtf += r.text;
      rtf += '\\plain ';
      if (hasBullets) rtf += '\\par ';
    }
    rtf += '}';
    return enc.encode(rtf);
  });
const rtfData = fc.oneof(
  fc.constant(enc.encode(REAL_RTF)),
  fc.uint8Array({ maxLength: 60 }),
  multiRunRtf,
  str.map((t) => enc.encode(`{\\rtf1{\\fonttbl\\f0 X;}\\f0\\fs${t.length * 7} ${t}}`)),
);
const url = fc.oneof(
  fc.record({
    absoluteString: fc.constantFrom('file:///m/a.mp4', 'file:///x/%E0%A4%A.png', 'file:///m/b.jpg'),
  }),
  fc.record({ local: fc.record({ path: str }) }),
  fc.record({ relativePath: str }),
);

const gradientStop = fc.record(
  {
    color,
    position: dbl,
    blendPoint: dbl,
  },
  { requiredKeys: [] },
);

const gradient = fc.record(
  {
    type: fc.oneof(
      fc.constantFrom('TYPE_LINEAR', 'TYPE_RADIAL', 'GRADIENT_TYPE_RADIAL', 0, 1, 2, -1, 99),
      str,
    ),
    angle: dbl,
    length: dbl,
    stops: fc.oneof(
      fc.constant([]),
      fc.array(gradientStop, { minLength: 1, maxLength: 1 }),
      fc.array(gradientStop, { minLength: 2, maxLength: 6 }),
      fc.array(gradientStop, { minLength: 50, maxLength: 52 }),
    ),
  },
  { requiredKeys: [] },
);

const textLineMask = fc.record(
  {
    enabled: fc.boolean(),
    maskStyle: fc.oneof(
      fc.constantFrom(
        'LINE_MASK_STYLE_FULL_WIDTH',
        'LINE_MASK_STYLE_LINE_WIDTH',
        'LINE_MASK_STYLE_MAX_LINE_WIDTH',
        0,
        1,
        2,
        3,
        -1,
        999,
      ),
      fc.integer({ min: -10, max: 100 }),
    ),
    heightOffset: dbl,
    verticalOffset: dbl,
    widthOffset: dbl,
    horizontalOffset: dbl,
  },
  { requiredKeys: [] },
);

const bezierPoint = fc.record(
  {
    point: fc.record({ x: dbl, y: dbl }, { requiredKeys: [] }),
    q0: fc.record({ x: dbl, y: dbl }, { requiredKeys: [] }),
    q1: fc.record({ x: dbl, y: dbl }, { requiredKeys: [] }),
    curved: fc.boolean(),
  },
  { requiredKeys: [] },
);

const pathMsg = fc.record(
  {
    closed: fc.boolean(),
    shape: fc.record(
      {
        type: fc.oneof(
          fc.constantFrom(
            'TYPE_RECTANGLE',
            'TYPE_ELLIPSE',
            'TYPE_ROUNDED_RECTANGLE',
            'TYPE_ISOSCELES_TRIANGLE',
            'TYPE_RIGHT_TRIANGLE',
            'TYPE_RHOMBUS',
            'TYPE_RIGHT_ARROW',
            'TYPE_DOUBLE_ARROW',
            'TYPE_POLYGON',
            'TYPE_STAR',
            'TYPE_CUSTOM',
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            -1,
            999,
          ),
          str,
        ),
        roundedRectangle: fc.record(
          { roundness: fc.oneof(dbl, fc.double({ min: -5, max: 50 })) },
          { requiredKeys: [] },
        ),
        polygon: fc.record(
          {
            numberSides: fc.oneof(
              fc.integer({ min: -10, max: 100 }),
              fc.constantFrom(0, -3, 500, Number.NaN),
            ),
          },
          { requiredKeys: [] },
        ),
        star: fc.record(
          {
            numberPoints: fc.oneof(
              fc.integer({ min: -10, max: 100 }),
              fc.constantFrom(0, -3, 500, Number.NaN),
            ),
            innerRadius: dbl,
          },
          { requiredKeys: [] },
        ),
      },
      { requiredKeys: [] },
    ),
    points: fc.oneof(
      fc.constant([]),
      fc.array(bezierPoint, { minLength: 1, maxLength: 1 }),
      fc.array(bezierPoint, { minLength: 2, maxLength: 4 }),
      fc.array(bezierPoint, { minLength: 50, maxLength: 52 }),
    ),
  },
  { requiredKeys: [] },
);

const shadowMsg = fc.record(
  {
    enable: fc.boolean(),
    angle: dbl,
    offset: dbl,
    radius: dbl,
    opacity: dbl,
    color,
  },
  { requiredKeys: [] },
);

const featherMsg = fc.record(
  {
    enable: fc.boolean(),
    radius: fc.oneof(dbl, fc.constantFrom(Number.NaN, -10, 0, 100)),
  },
  { requiredKeys: [] },
);

const drawingMsg = fc.record(
  {
    scaleBehavior: fc.oneof(
      fc.constantFrom(
        'SCALE_BEHAVIOR_FIT',
        'SCALE_BEHAVIOR_FILL',
        'SCALE_BEHAVIOR_STRETCH',
        'SCALE_BEHAVIOR_CUSTOM',
        0,
        1,
        2,
        3,
        99,
      ),
      str,
    ),
    cropEnable: fc.boolean(),
    cropInsets: fc.record({ left: dbl, top: dbl, right: dbl, bottom: dbl }, { requiredKeys: [] }),
    naturalSize: fc.record({ width: dbl, height: dbl }, { requiredKeys: [] }),
    customImageBounds: fc.record(
      {
        origin: fc.record({ x: dbl, y: dbl }, { requiredKeys: [] }),
        size: fc.record({ width: dbl, height: dbl }, { requiredKeys: [] }),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);

const element = fc.record(
  {
    uuid,
    name: str,
    bounds: fc.record(
      { origin: fc.record({ x: dbl, y: dbl }), size: fc.record({ width: dbl, height: dbl }) },
      { requiredKeys: [] },
    ),
    opacity: dbl,
    rotation: dbl,
    hidden: fc.boolean(),
    textLineMask,
    path: pathMsg,
    feather: featherMsg,
    shadow: shadowMsg,
    text: fc.record(
      {
        rtfData,
        verticalAlignment: fc.constantFrom(
          'VERTICAL_ALIGNMENT_TOP',
          'VERTICAL_ALIGNMENT_BOTTOM',
          'VERTICAL_ALIGNMENT_MIDDLE',
        ),
        margins: fc.record({ left: dbl, right: dbl, top: dbl, bottom: dbl }, { requiredKeys: [] }),
        shadow: shadowMsg,
        attributes: fc.record(
          {
            font: fc.record(
              { name: str, size: dbl, family: str, bold: fc.boolean(), italic: fc.boolean() },
              { requiredKeys: [] },
            ),
            strokeWidth: dbl,
            strokeColor: color,
            textSolidFill: color,
            capitalization: fc.constantFrom(
              'CAPITALIZATION_NONE',
              'CAPITALIZATION_ALL_CAPS',
              'CAPITALIZATION_SMALL_CAPS',
            ),
          },
          { requiredKeys: [] },
        ),
      },
      { requiredKeys: [] },
    ),
    fill: fc.record(
      {
        enable: fc.boolean(),
        color,
        gradient,
        media: fc.record(
          {
            url,
            image: fc.record({ drawing: drawingMsg }, { requiredKeys: [] }),
            video: fc.record({ drawing: drawingMsg }, { requiredKeys: [] }),
          },
          { requiredKeys: [] },
        ),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);
const action = fc.oneof(
  fc.record({
    uuid,
    type: fc.constant('ACTION_TYPE_PRESENTATION_SLIDE'),
    slide: fc.record({
      presentation: fc.record(
        {
          baseSlide: fc.record(
            {
              size: fc.record({ width: dbl, height: dbl }, { requiredKeys: [] }),
              elements: fc.array(fc.record({ element }), { maxLength: 3 }),
            },
            { requiredKeys: [] },
          ),
          notes: fc.record({ rtfData }),
        },
        { requiredKeys: [] },
      ),
    }),
  }),
  fc.record(
    {
      uuid,
      type: fc.constantFrom(
        'ACTION_TYPE_MEDIA',
        'ACTION_TYPE_MACRO',
        'ACTION_TYPE_TIMER',
        'ACTION_TYPE_UNKNOWN',
      ),
      media: fc.record(
        {
          element: fc.record({ url }),
          layerType: fc.constantFrom('LAYER_TYPE_BACKGROUND', 'LAYER_TYPE_FOREGROUND'),
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: ['type'] },
  ),
);
const cue = fc.record(
  {
    uuid,
    actions: fc.array(action, { maxLength: 3 }),
    completionTime: dbl,
    completionActionType: fc.constantFrom(
      'COMPLETION_ACTION_TYPE_AFTER_TIME',
      'COMPLETION_ACTION_TYPE_FIRST',
    ),
  },
  { requiredKeys: [] },
);
const presentationObj = fc.record(
  {
    uuid,
    name: str,
    category: str,
    selectedArrangement: uuid,
    cues: fc.array(cue, { maxLength: 5 }),
    cueGroups: fc.array(
      fc.record(
        {
          group: fc.record({ uuid, name: str }, { requiredKeys: [] }),
          cueIdentifiers: fc.array(uuid, { maxLength: 5 }),
        },
        { requiredKeys: [] },
      ),
      { maxLength: 4 },
    ),
    arrangements: fc.array(
      fc.record(
        { uuid, name: str, groupIdentifiers: fc.array(uuid, { maxLength: 6 }) },
        { requiredKeys: [] },
      ),
      { maxLength: 3 },
    ),
    ccli: fc.record(
      { author: str, songTitle: str, publisher: str, copyrightYear: fc.nat(), songNumber: fc.nat() },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);

function encodeAs(type: string, obj: unknown): Uint8Array {
  const T = pro7Type(type);
  return T.encode(T.fromObject(obj as Record<string, unknown>)).finish();
}

const playlistNode: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  node: fc.record(
    {
      name: str,
      type: fc.constantFrom('TYPE_PLAYLIST', 'TYPE_GROUP', 'TYPE_ROOT', 'TYPE_SMART'),
      playlists: fc.record({ playlists: fc.array(tie('node'), { maxLength: 2 }) }),
      items: fc.record({
        items: fc.array(
          fc.oneof(
            fc.record({
              name: str,
              presentation: fc.record({ documentPath: url, arrangement: uuid }, { requiredKeys: [] }),
            }),
            fc.record({ name: str, cue }),
            fc.record({ name: str, header: fc.record({ color }) }),
          ),
          { maxLength: 4 },
        ),
      }),
    },
    { requiredKeys: [] },
  ),
})).node;

function checkResult(r: ReturnType<typeof importPro7>) {
  const ids = new Set<string>();
  for (const p of r.presentations) {
    const parsed = PresentationSchema.safeParse(p);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    const hasNonFinite = JSON.stringify(p, (_, v) =>
      typeof v === 'number' && !Number.isFinite(v) ? '__NON_FINITE__' : v,
    ).includes('__NON_FINITE__');
    expect(hasNonFinite).toBe(false);

    ids.add(p.id);
    expect(p.title.length).toBeLessThanOrEqual(IMPORT_LIMITS.title);
    const secIds = new Set(p.sections.map((s) => s.id));
    for (const a of p.arrangements) for (const id of a.sectionIds) expect(secIds.has(id)).toBe(true);
    for (const s of p.sections) {
      expect(s.label.length).toBeLessThanOrEqual(IMPORT_LIMITS.label);
      for (const sl of s.slides) {
        if (sl.durationMs !== undefined)
          expect(sl.durationMs).toBeLessThanOrEqual(IMPORT_LIMITS.durationMaxMs);
        for (const o of sl.objects) {
          for (const v of Object.values(o.box)) expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(o.box.x)).toBeLessThanOrEqual(3840);
          expect(o.opacity).toBeGreaterThanOrEqual(0);
          expect(o.opacity).toBeLessThanOrEqual(1);
          if (o.type === 'text') {
            expect(o.style.fontSizePx).toBeGreaterThanOrEqual(IMPORT_LIMITS.fontSizeMin);
            expect(o.style.fontSizePx).toBeLessThanOrEqual(IMPORT_LIMITS.fontSizeMax);
            expect(o.text.length).toBeLessThanOrEqual(IMPORT_LIMITS.text);
            expect(JSON.stringify(o.style)).not.toMatch(/null|NaN|Infinity/);
            if (o.style.lineMask) {
              const lm = o.style.lineMask;
              if (lm.heightOffsetPx !== undefined) {
                expect(Number.isFinite(lm.heightOffsetPx)).toBe(true);
                expect(lm.heightOffsetPx).toBeGreaterThanOrEqual(-2000);
                expect(lm.heightOffsetPx).toBeLessThanOrEqual(2000);
              }
              if (lm.vOffsetPx !== undefined) {
                expect(Number.isFinite(lm.vOffsetPx)).toBe(true);
                expect(lm.vOffsetPx).toBeGreaterThanOrEqual(-2000);
                expect(lm.vOffsetPx).toBeLessThanOrEqual(2000);
              }
              if (lm.widthOffsetPx !== undefined) {
                expect(Number.isFinite(lm.widthOffsetPx)).toBe(true);
                expect(lm.widthOffsetPx).toBeGreaterThanOrEqual(-4000);
                expect(lm.widthOffsetPx).toBeLessThanOrEqual(4000);
              }
              if (lm.hOffsetPx !== undefined) {
                expect(Number.isFinite(lm.hOffsetPx)).toBe(true);
                expect(lm.hOffsetPx).toBeGreaterThanOrEqual(-4000);
                expect(lm.hOffsetPx).toBeLessThanOrEqual(4000);
              }
              if (lm.fill) {
                expect(lm.fill.r).toBeGreaterThanOrEqual(0);
                expect(lm.fill.r).toBeLessThanOrEqual(255);
                expect(lm.fill.a).toBeGreaterThanOrEqual(0);
                expect(lm.fill.a).toBeLessThanOrEqual(1);
              }
              if (lm.gradient) {
                expect(lm.gradient.stops.length).toBeGreaterThanOrEqual(2);
                expect(lm.gradient.stops.length).toBeLessThanOrEqual(16);
                for (const st of lm.gradient.stops) {
                  expect(st.at).toBeGreaterThanOrEqual(0);
                  expect(st.at).toBeLessThanOrEqual(1);
                }
              }
            }
          }
          if (o.type === 'image') {
            if (o.crop) {
              expect(o.crop.l).toBeGreaterThanOrEqual(-1);
              expect(o.crop.l).toBeLessThanOrEqual(1);
              expect(o.crop.t).toBeGreaterThanOrEqual(-1);
              expect(o.crop.t).toBeLessThanOrEqual(1);
              expect(o.crop.r).toBeGreaterThanOrEqual(-1);
              expect(o.crop.r).toBeLessThanOrEqual(1);
              expect(o.crop.b).toBeGreaterThanOrEqual(-1);
              expect(o.crop.b).toBeLessThanOrEqual(1);
            }
            if (o.softEdge !== undefined) {
              expect(Number.isFinite(o.softEdge)).toBe(true);
              expect(o.softEdge).toBeGreaterThan(0);
              expect(o.softEdge).toBeLessThanOrEqual(500);
            }
            if (o.shadow) {
              expect(Math.abs(o.shadow.dx)).toBeLessThanOrEqual(500);
              expect(Math.abs(o.shadow.dy)).toBeLessThanOrEqual(500);
              expect(o.shadow.blur).toBeGreaterThanOrEqual(0);
              expect(o.shadow.blur).toBeLessThanOrEqual(500);
            }
          }
          if (o.type === 'shape') {
            if (o.softEdge !== undefined) {
              expect(Number.isFinite(o.softEdge)).toBe(true);
              expect(o.softEdge).toBeGreaterThanOrEqual(0);
              expect(o.softEdge).toBeLessThanOrEqual(500);
            }
            if (o.gradient) {
              expect(o.gradient.stops.length).toBeGreaterThanOrEqual(2);
              expect(o.gradient.stops.length).toBeLessThanOrEqual(16);
            }
            if (o.shadow) {
              expect(Math.abs(o.shadow.dx)).toBeLessThanOrEqual(500);
              expect(Math.abs(o.shadow.dy)).toBeLessThanOrEqual(500);
              expect(o.shadow.blur).toBeGreaterThanOrEqual(0);
              expect(o.shadow.blur).toBeLessThanOrEqual(500);
            }
          }
        }
      }
    }
  }
  const mediaKeys = new Set(r.media.map((m) => m.key));
  for (const pl of r.playlists) {
    expect(PlaylistSchema.safeParse(pl).success).toBe(true);
    for (const it of pl.items) {
      if (it.kind === 'presentation') expect(ids.has(it.presentationId)).toBe(true);
      if (it.kind === 'media') expect(mediaKeys.has(it.mediaId)).toBe(true);
    }
  }
}

const files = (entries: [string, Uint8Array][]) => new Map(entries);
const mediaFiles: [string, Uint8Array][] = [
  ['m/a.mp4', new Uint8Array(1)],
  ['Media/b.jpg', new Uint8Array(1)],
];

describe('importPro7 (fuzz)', () => {
  it('random bytes as .pro and playlist documents never throw', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), fc.uint8Array({ maxLength: 200 }), (a, b) => {
        checkResult(importPro7(files([['x/Song.pro', a], ['Lib/Playlists/Sunday', b], ...mediaFiles])));
      }),
      { numRuns: 1500 },
    );
  });

  it('schema-built presentations with randomized fields import within bounds', () => {
    fc.assert(
      fc.property(fc.array(presentationObj, { minLength: 1, maxLength: 3 }), (docs) => {
        const entries: [string, Uint8Array][] = docs.map((d, i) => [
          `lib/Doc ${i}.pro`,
          encodeAs('rv.data.Presentation', d),
        ]);
        const f = files([...entries, ...mediaFiles]);
        checkResult(importPro7(f));
        checkResult(importPro7(f, { exportCompat: true }));
      }),
      { numRuns: 300 },
    );
  });

  it('newly supported ProPresenter 7 structures with hostile inputs never throw and pass schema with exportCompat true and false', () => {
    fc.assert(
      fc.property(fc.array(presentationObj, { minLength: 1, maxLength: 2 }), (docs) => {
        const entries: [string, Uint8Array][] = docs.map((d, i) => [
          `lib/HostileDoc ${i}.pro`,
          encodeAs('rv.data.Presentation', d),
        ]);
        const f = files([...entries, ...mediaFiles]);
        checkResult(importPro7(f));
        checkResult(importPro7(f, { exportCompat: true }));
      }),
      { numRuns: 300 },
    );
  });

  it('schema-built playlists referencing missing documents and media import within bounds', () => {
    fc.assert(
      fc.property(presentationObj, playlistNode, (doc, root) => {
        const pl = encodeAs('rv.data.PlaylistDocument', { rootNode: root, type: 'TYPE_PRESENTATION' });
        checkResult(
          importPro7(
            files([
              ['lib/Doc.pro', encodeAs('rv.data.Presentation', doc)],
              ['x.proPlaylist/data', pl],
              ...mediaFiles,
            ]),
          ),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('mutated (truncated, bit-flipped) encodings never throw', () => {
    fc.assert(
      fc.property(
        presentationObj,
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }),
        fc.nat(),
        (doc, flips, cut) => {
          const bytes = encodeAs('rv.data.Presentation', doc).slice();
          for (const [i, v] of flips) if (bytes.length) bytes[i % bytes.length] = v;
          const truncated = bytes.subarray(0, bytes.length ? cut % (bytes.length + 1) : 0);
          checkResult(
            importPro7(
              files([
                ['a.pro', bytes],
                ['b.pro', truncated],
              ]),
            ),
          );
        },
      ),
      { numRuns: 600 },
    );
  });
});

describe('importPro7 regressions found by fuzzing', () => {
  it('NaN and infinite geometry, opacity and sizes are clamped', () => {
    const doc = {
      name: 'Bad numbers',
      cues: [
        {
          uuid: { string: 'C' },
          completionTime: Number.POSITIVE_INFINITY,
          completionActionType: 'COMPLETION_ACTION_TYPE_AFTER_TIME',
          actions: [
            {
              type: 'ACTION_TYPE_PRESENTATION_SLIDE',
              slide: {
                presentation: {
                  baseSlide: {
                    size: { width: Number.POSITIVE_INFINITY, height: 1080 },
                    elements: [
                      {
                        element: {
                          bounds: {
                            origin: { x: Number.NaN, y: 1e300 },
                            size: { width: -5, height: Number.NaN },
                          },
                          opacity: Number.NaN,
                          rotation: Number.POSITIVE_INFINITY,
                          text: {
                            rtfData: enc.encode('{\\rtf1 hello}'),
                            margins: { left: Number.POSITIVE_INFINITY },
                            attributes: { strokeWidth: Number.NaN, font: { size: Number.POSITIVE_INFINITY } },
                            shadow: { enable: true, angle: Number.NaN, offset: 1e308 },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    };
    const r = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]));
    checkResult(r);
    const slide = r.presentations[0]!.sections[0]!.slides[0]!;
    expect(slide.durationMs).toBeUndefined();
    expect(slide.objects[0]!.opacity).toBe(1);
  });

  it('a 20,000-character group name becomes a bounded label', () => {
    const doc = {
      name: 'x',
      cues: [
        {
          uuid: { string: 'C' },
          actions: [{ type: 'ACTION_TYPE_PRESENTATION_SLIDE', slide: { presentation: { baseSlide: {} } } }],
        },
      ],
      cueGroups: [{ group: { name: 'Q'.repeat(20_000) }, cueIdentifiers: [{ string: 'C' }] }],
    };
    const r = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]));
    checkResult(r);
    expect(r.presentations[0]!.sections[0]!.label.length).toBeLessThanOrEqual(IMPORT_LIMITS.label);
  });

  it('a playlist nested 2,000 levels deep is rejected with a log entry, not a stack overflow', () => {
    // Hand-encoded: Playlist.children (field 9) nested 2,000 times inside PlaylistDocument.rootNode (field 3).
    const varint = (n: number) => {
      const out: number[] = [];
      while (n > 127) {
        out.push((n & 127) | 128);
        n >>>= 7;
      }
      out.push(n);
      return out;
    };
    let node: number[] = [0x12, 1, 0x41]; // name: "A"
    for (let i = 0; i < 2000; i++) node = [0x4a, ...varint(node.length), ...node];
    const doc = new Uint8Array([0x1a, ...varint(node.length), ...node]);
    const r = importPro7(files([['x.proPlaylist/data', doc]]));
    checkResult(r);
    expect(r.log.some((l) => l.level !== 'info')).toBe(true);
  });

  it('media lookup is bounded for absurdly deep paths', () => {
    const deep = `file:///${'d/'.repeat(5000)}a.mp4`;
    const doc = {
      name: 'deep',
      cues: [
        {
          uuid: { string: 'C' },
          actions: [{ type: 'ACTION_TYPE_MEDIA', media: { element: { url: { absoluteString: deep } } } }],
        },
      ],
    };
    const many = Array.from({ length: 3000 }, (_, i): [string, Uint8Array] => [
      `lib/f${i}/x.jpg`,
      new Uint8Array(1),
    ]);
    const t0 = Date.now();
    checkResult(importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)], ...many])));
    expect(Date.now() - t0).toBeLessThan(budgetMs(3000));
  });

  it('textLineMask with hostile offsets, styles, and fill/gradient combinations never throws and passes schema', () => {
    const makeDoc = (mask: Record<string, unknown>, fill?: Record<string, unknown>) => ({
      name: 'textLineMask hostile',
      cues: [
        {
          uuid: { string: 'C' },
          actions: [
            {
              type: 'ACTION_TYPE_PRESENTATION_SLIDE',
              slide: {
                presentation: {
                  baseSlide: {
                    elements: [
                      {
                        element: {
                          bounds: { origin: { x: 0, y: 0 }, size: { width: 400, height: 200 } },
                          textLineMask: mask,
                          fill: fill ?? { enable: false },
                          text: {
                            rtfData: enc.encode('{\\rtf1 masked text}'),
                            verticalAlignment: 'VERTICAL_ALIGNMENT_MIDDLE',
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    });

    for (const [mask, fill] of [
      // Enabled with NaN and infinite offsets, out-of-range maskStyle, and solid fill
      [
        {
          enabled: true,
          maskStyle: 999,
          heightOffset: Number.NaN,
          verticalOffset: Number.POSITIVE_INFINITY,
          widthOffset: 1e9,
          horizontalOffset: Number.NEGATIVE_INFINITY,
        },
        { enable: true, color: { red: 1, green: 0, blue: 0, alpha: 1 } },
      ],
      // Enabled with negative offsets, LINE_MASK_STYLE_LINE_WIDTH, and gradient fill
      [
        {
          enabled: true,
          maskStyle: 'LINE_MASK_STYLE_LINE_WIDTH',
          heightOffset: -5000,
          verticalOffset: -1e9,
          widthOffset: -10000,
          horizontalOffset: -1e9,
        },
        {
          enable: true,
          gradient: {
            type: 'TYPE_LINEAR',
            angle: 45,
            stops: [
              { position: 0, color: { red: 1, green: 0, blue: 0, alpha: 1 } },
              { position: 1, color: { red: 0, green: 0, blue: 1, alpha: 1 } },
            ],
          },
        },
      ],
      // Enabled but fill disabled (no fill or gradient left -> lineMask dropped)
      [
        {
          enabled: true,
          maskStyle: 'LINE_MASK_STYLE_MAX_LINE_WIDTH',
          heightOffset: 50,
        },
        { enable: false },
      ],
      // Disabled mask
      [
        {
          enabled: false,
          heightOffset: 100,
        },
        { enable: true, color: { red: 1, green: 1, blue: 1, alpha: 1 } },
      ],
    ]) {
      const doc = makeDoc(mask as Record<string, unknown>, fill as Record<string, unknown>);
      const rNormal = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]));
      checkResult(rNormal);
      const rCompat = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]), {
        exportCompat: true,
      });
      checkResult(rCompat);
    }
  });

  it('fill.gradient with hostile types, angles, and stops never throws and stays bounded', () => {
    const makeGradientDoc = (gradient: Record<string, unknown>) => ({
      name: 'gradient hostile',
      cues: [
        {
          uuid: { string: 'C' },
          actions: [
            {
              type: 'ACTION_TYPE_PRESENTATION_SLIDE',
              slide: {
                presentation: {
                  baseSlide: {
                    elements: [
                      {
                        element: {
                          bounds: { origin: { x: 0, y: 0 }, size: { width: 500, height: 300 } },
                          fill: { enable: true, gradient },
                          path: { shape: { type: 'TYPE_RECTANGLE' } },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    });

    const hostileGradients: Record<string, unknown>[] = [
      // 0 stops
      { type: 'TYPE_LINEAR', angle: Number.NaN, stops: [] },
      // 1 stop (auto-duplicated to 2 stops)
      {
        type: 'TYPE_RADIAL',
        angle: -999,
        stops: [{ position: 0.5, color: { red: Number.NaN, green: 1, blue: 0, alpha: 1 } }],
      },
      // 50 stops with unsorted and out-of-range positions and hostile angles
      {
        type: 'GRADIENT_TYPE_RADIAL',
        angle: 9999,
        stops: [
          { position: 5, color: { red: 1, green: 0, blue: 0, alpha: 1 } },
          { position: -10, color: { red: 0, green: 1, blue: 0, alpha: Number.NaN } },
          { position: Number.NaN, color: { red: 0, green: 0, blue: 1, alpha: 1 } },
          ...Array.from({ length: 47 }, (_, i) => ({
            position: 1 - i * 0.05,
            color: { red: i / 50, green: 0, blue: 0, alpha: 1 },
          })),
        ],
      },
    ];

    for (const g of hostileGradients) {
      const doc = makeGradientDoc(g);
      const r = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]));
      checkResult(r);
      const rCompat = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]), {
        exportCompat: true,
      });
      checkResult(rCompat);
    }
  });

  it('paths with hostile shapes, roundness, numberOfSides, and bezier points never throw', () => {
    const makePathDoc = (path: Record<string, unknown>) => ({
      name: 'path hostile',
      cues: [
        {
          uuid: { string: 'C' },
          actions: [
            {
              type: 'ACTION_TYPE_PRESENTATION_SLIDE',
              slide: {
                presentation: {
                  baseSlide: {
                    elements: [
                      {
                        element: {
                          bounds: { origin: { x: 0, y: 0 }, size: { width: 300, height: 200 } },
                          fill: { enable: true, color: { red: 1, green: 0, blue: 0, alpha: 1 } },
                          path,
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    });

    const hostilePaths: Record<string, unknown>[] = [
      // Ellipse
      { shape: { type: 'TYPE_ELLIPSE' } },
      // Rounded rectangle with negative roundness
      { shape: { type: 'TYPE_ROUNDED_RECTANGLE', roundedRectangle: { roundness: -5 } } },
      // Rounded rectangle with huge roundness
      { shape: { type: 'TYPE_ROUNDED_RECTANGLE', roundedRectangle: { roundness: 50 } } },
      // Rounded rectangle with NaN roundness
      { shape: { type: 'TYPE_ROUNDED_RECTANGLE', roundedRectangle: { roundness: Number.NaN } } },
      // Polygon with 0, negative, and 500 sides
      { shape: { type: 'TYPE_POLYGON', polygon: { numberSides: 0 } } },
      { shape: { type: 'TYPE_POLYGON', polygon: { numberSides: -3 } } },
      { shape: { type: 'TYPE_POLYGON', polygon: { numberSides: 500 } } },
      // Star with 0, negative, and 500 points
      { shape: { type: 'TYPE_STAR', star: { numberPoints: 0 } } },
      { shape: { type: 'TYPE_STAR', star: { numberPoints: -3 } } },
      { shape: { type: 'TYPE_STAR', star: { numberPoints: 500 } } },
      // Custom path with 0 points
      { shape: { type: 'TYPE_CUSTOM' }, points: [] },
      // Custom path with 1 point
      { shape: { type: 'TYPE_CUSTOM' }, points: [{ point: { x: 0, y: 0 } }] },
      // Custom path with 2 points containing NaN and Infinity
      {
        shape: { type: 'TYPE_CUSTOM' },
        closed: false,
        points: [
          { point: { x: Number.NaN, y: 0 }, q0: { x: 1e9, y: 0 }, q1: { x: 0, y: Number.POSITIVE_INFINITY } },
          { point: { x: 1, y: 1 }, q0: { x: Number.NaN, y: Number.NaN }, q1: { x: 1, y: 1 } },
        ],
      },
      // Custom path with 50 points
      {
        shape: { type: 'TYPE_CUSTOM' },
        closed: true,
        points: Array.from({ length: 50 }, (_, i) => ({
          point: { x: Math.cos((i / 50) * Math.PI * 2), y: Math.sin((i / 50) * Math.PI * 2) },
          q0: { x: 0, y: 0 },
          q1: { x: 0, y: 0 },
        })),
      },
    ];

    for (const p of hostilePaths) {
      const doc = makePathDoc(p);
      const r = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]));
      checkResult(r);
      const rCompat = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]), {
        exportCompat: true,
      });
      checkResult(rCompat);
    }
  });

  it('fill.media and drawing with hostile crops, customImageBounds, shadow and feather never throws', () => {
    const makeMediaDoc = (
      drawing: Record<string, unknown>,
      shadow?: Record<string, unknown>,
      feather?: Record<string, unknown>,
    ) => ({
      name: 'media hostile',
      cues: [
        {
          uuid: { string: 'C' },
          actions: [
            {
              type: 'ACTION_TYPE_PRESENTATION_SLIDE',
              slide: {
                presentation: {
                  baseSlide: {
                    elements: [
                      {
                        element: {
                          bounds: { origin: { x: 10, y: 10 }, size: { width: 640, height: 360 } },
                          shadow: shadow ?? { enable: false },
                          feather: feather ?? { enable: false },
                          fill: {
                            enable: true,
                            media: {
                              url: { absoluteString: 'file:///m/a.mp4' },
                              video: { drawing },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    });

    const hostileDrawings: [Record<string, unknown>, Record<string, unknown>?, Record<string, unknown>?][] = [
      // Negative / inverted / > 1 cropInsets
      [
        {
          scaleBehavior: 'SCALE_BEHAVIOR_FIT',
          cropEnable: true,
          cropInsets: { left: -5, top: 2.5, right: 0.9, bottom: -1 },
          naturalSize: { width: 1920, height: 1080 },
        },
        { enable: true, angle: Number.NaN, offset: 1e9, radius: Number.NaN, opacity: Number.NaN },
        { enable: true, radius: Number.NaN },
      ],
      // Inverted crops (left + right > 0.99)
      [
        {
          scaleBehavior: 'SCALE_BEHAVIOR_FIT',
          cropEnable: true,
          cropInsets: { left: 0.6, top: 0.6, right: 0.6, bottom: 0.6 },
        },
        { enable: true, angle: 9999, offset: -50, radius: -10, opacity: 5 },
        { enable: true, radius: -10 },
      ],
      // SCALE_BEHAVIOR_CUSTOM with zero / negative / NaN customImageBounds
      [
        {
          scaleBehavior: 'SCALE_BEHAVIOR_CUSTOM',
          customImageBounds: {
            origin: { x: Number.NaN, y: -50 },
            size: { width: 0, height: -100 },
          },
        },
        { enable: true, angle: 180, offset: 10, radius: 20, opacity: 0.8 },
        { enable: true, radius: 100 },
      ],
      // SCALE_BEHAVIOR_CUSTOM with valid customImageBounds
      [
        {
          scaleBehavior: 'SCALE_BEHAVIOR_CUSTOM',
          customImageBounds: {
            origin: { x: -20, y: -10 },
            size: { width: 700, height: 400 },
          },
        },
      ],
    ];

    for (const [drawing, shadow, feather] of hostileDrawings) {
      const doc = makeMediaDoc(drawing, shadow, feather);
      const r = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)], ...mediaFiles]));
      checkResult(r);
      const rCompat = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)], ...mediaFiles]), {
        exportCompat: true,
      });
      checkResult(rCompat);
    }
  });

  it('multi-run and bullet RTF inside text.rtfData imports cleanly and passes schema', () => {
    const rtf =
      '{\\rtf1\\ansi{\\fonttbl\\f0 Arial;\\f1 Georgia;}{\\colortbl;\\red255\\green0\\blue0;\\red0\\green0\\blue255;}' +
      '{\\listtext •\\tab}\\f0\\b\\fs60 \\cf1 Bullet one with bold red text\\par ' +
      '{\\listtext •\\tab}\\f1\\i\\fs40 \\cf2 Bullet two with italic blue text\\par ' +
      'Plain third line without bullets}';

    const doc = {
      name: 'rich rtf doc',
      cues: [
        {
          uuid: { string: 'C' },
          actions: [
            {
              type: 'ACTION_TYPE_PRESENTATION_SLIDE',
              slide: {
                presentation: {
                  baseSlide: {
                    elements: [
                      {
                        element: {
                          bounds: { origin: { x: 50, y: 50 }, size: { width: 800, height: 400 } },
                          text: {
                            rtfData: enc.encode(rtf),
                            verticalAlignment: 'VERTICAL_ALIGNMENT_TOP',
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    };

    const r = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]));
    checkResult(r);
    const pres = r.presentations[0]!;
    const obj = pres.sections[0]!.slides[0]!.objects[0]!;
    expect(obj.type).toBe('text');
    if (obj.type === 'text') {
      expect(obj.runs).toBeDefined();
      expect(obj.paras).toBeDefined();
      expect(obj.paras!.length).toBe(3);
      expect(obj.paras![0]!.bullet?.char).toBe('•');
      expect(obj.paras![1]!.bullet?.char).toBe('•');
      expect(obj.paras![2]!.bullet?.char).toBe('•');
    }
    const rCompat = importPro7(files([['a.pro', encodeAs('rv.data.Presentation', doc)]]), {
      exportCompat: true,
    });
    checkResult(rCompat);
  });
});

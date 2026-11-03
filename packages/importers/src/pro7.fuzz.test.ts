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

const enc = new TextEncoder();
const dbl = fc.oneof(
  { weight: 3, arbitrary: fc.double({ min: -5000, max: 5000, noNaN: true }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1e308),
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
const rtfData = fc.oneof(
  fc.constant(enc.encode(REAL_RTF)),
  fc.uint8Array({ maxLength: 60 }),
  str.map((t) => enc.encode(`{\\rtf1{\\fonttbl\\f0 X;}\\f0\\fs${t.length * 7} ${t}}`)),
);
const url = fc.oneof(
  fc.record({
    absoluteString: fc.constantFrom('file:///m/a.mp4', 'file:///x/%E0%A4%A.png', 'file:///m/b.jpg'),
  }),
  fc.record({ local: fc.record({ path: str }) }),
  fc.record({ relativePath: str }),
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
    text: fc.record(
      {
        rtfData,
        verticalAlignment: fc.constantFrom('VERTICAL_ALIGNMENT_TOP', 'VERTICAL_ALIGNMENT_BOTTOM'),
        margins: fc.record({ left: dbl, right: dbl, top: dbl, bottom: dbl }, { requiredKeys: [] }),
        shadow: fc.record(
          { enable: fc.boolean(), angle: dbl, offset: dbl, radius: dbl, opacity: dbl, color },
          { requiredKeys: [] },
        ),
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
      { enable: fc.boolean(), color, media: fc.record({ url }, { requiredKeys: [] }) },
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
        checkResult(importPro7(files([...entries, ...mediaFiles])));
      }),
      { numRuns: 400 },
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
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

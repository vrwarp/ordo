/**
 * Fuzzing of cue expansion, arrangement resolution and the colour helpers (design/25 "Fuzzing"): random
 * playlists that reference missing presentations, sections, arrangements and media must expand to a
 * consistent cue list; colour helpers must always return valid CSS / channel values.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hexToRgba, nearColor, rgbaCss, rgbaHex } from './color.ts';
import { arrangedSections, expandCues, itemStarts, sectionsOfItem } from './cues.ts';
import type { Media, Playlist, Presentation } from './schemas.ts';

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = (s: string) => !LONE.test(s);

const ID = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'missing');
const num = fc.oneof(
  fc.double(),
  fc.integer({ min: -10, max: 100_000 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -1, 0),
);

const slideArb = fc.record({
  id: ID,
  objects: fc.array(
    fc.oneof(
      fc.record({
        id: ID,
        type: fc.constant('text'),
        text: fc.string({ unit: 'binary', maxLength: 120 }),
      }),
      fc.record({ id: ID, type: fc.constant('image'), mediaId: ID }),
    ),
    { maxLength: 3 },
  ),
  lyricObjectId: fc.option(ID, { nil: undefined }),
  durationMs: fc.option(num, { nil: undefined }),
  backgroundMediaId: fc.option(ID, { nil: undefined }),
});

const presentationArb = (id: string) =>
  fc
    .record({
      kind: fc.constantFrom('song', 'slides', 'loop'),
      sections: fc.array(
        fc.record({
          id: ID,
          label: fc.string({ maxLength: 12 }),
          short: fc.string({ maxLength: 4 }),
          slides: fc.array(slideArb, { maxLength: 4 }),
        }),
        { maxLength: 5 },
      ),
      arrangements: fc.array(
        fc.record({ id: ID, name: fc.string({ maxLength: 5 }), sectionIds: fc.array(ID, { maxLength: 8 }) }),
        { maxLength: 3 },
      ),
      loop: fc.option(fc.record({ defaultSlideMs: num }), { nil: undefined }),
    })
    .map((p) => ({
      ...p,
      id,
      rev: 1,
      title: id,
      meta: { tags: [] },
      source: { kind: 'paste' },
      archived: false,
    }));

const itemArb = fc.oneof(
  fc.record({
    id: ID,
    kind: fc.constant('presentation'),
    presentationId: ID,
    arrangementId: fc.option(ID, { nil: undefined }),
  }),
  fc.record({ id: ID, kind: fc.constant('media'), mediaId: ID }),
  fc.record({
    id: ID,
    kind: fc.constant('timer'),
    timer: fc.oneof(
      fc.record({ kind: fc.constant('elapsed'), label: fc.option(fc.string(), { nil: undefined }) }),
      fc.record({ kind: fc.constant('countdownTo'), timeOfDay: fc.string({ maxLength: 6 }) }),
    ),
  }),
  fc.record({ id: ID, kind: fc.constant('action'), action: fc.constantFrom('clearAll', 'logo') }),
);

const resolvedArb = fc
  .record({
    items: fc.array(itemArb, { maxLength: 8 }),
    a: presentationArb('a'),
    b: presentationArb('b'),
    present: fc.subarray(['a', 'b']),
    mediaKinds: fc.subarray(['c', 'd']),
  })
  .map(({ items, a, b, present, mediaKinds }) => {
    const presentations: Record<string, Presentation> = {};
    if (present.includes('a')) presentations.a = a as unknown as Presentation;
    if (present.includes('b')) presentations.b = b as unknown as Presentation;
    const media: Record<string, Media> = {};
    for (const id of mediaKinds)
      media[id] = {
        id,
        name: `m-${id}`,
        kind: id === 'c' ? 'video' : 'image',
        loop: false,
      } as unknown as Media;
    const playlist = { id: 'pl', rev: 1, name: 'p', items } as unknown as Playlist;
    return { playlist, presentations, media };
  });

describe('expandCues / arrangedSections (fuzz)', () => {
  it('never throws; cues are dense, ordered and reference what exists', () => {
    fc.assert(
      fc.property(resolvedArb, (r) => {
        const cues = expandCues(r);
        let lastItem = -1;
        cues.forEach((c, i) => {
          expect(c.index).toBe(i);
          expect(c.itemIndex).toBeGreaterThanOrEqual(lastItem);
          lastItem = c.itemIndex;
          expect(c.itemIndex).toBeLessThan(r.playlist.items.length);
          expect(c.label.length).toBeLessThanOrEqual(80);
          expect(wellFormed(c.label)).toBe(true);
          if (c.kind === 'slide') {
            const p = r.presentations[c.presentationId!]!;
            expect(p).toBeDefined();
            const secs = arrangedSections(
              p,
              (r.playlist.items[c.itemIndex] as { arrangementId?: string }).arrangementId,
            );
            expect(c.arrangementPos).toBeLessThan(secs.length);
            expect(secs[c.arrangementPos!]!.slides[c.slideIndexInSection!]!.id).toBe(c.slideId);
            if (c.autoAdvanceMs !== undefined) {
              expect(Number.isFinite(c.autoAdvanceMs)).toBe(true);
              expect(c.autoAdvanceMs).toBeGreaterThanOrEqual(500);
            }
          }
          if (c.kind === 'media') expect(r.media[c.mediaId!]).toBeDefined();
        });
        const starts = itemStarts(cues);
        for (const s of starts) expect(cues[s]).toBeDefined();
        for (let i = 0; i < Math.min(cues.length, 5); i++)
          for (const s of sectionsOfItem(cues, i)) expect(cues[s.first]!.arrangementPos).toBe(s.pos);
        expect(sectionsOfItem(cues, cues.length + 3)).toEqual([]);
      }),
      { numRuns: 1500 },
    );
  });

  it('arrangedSections only returns sections of the presentation', () => {
    fc.assert(
      fc.property(presentationArb('a'), fc.option(ID, { nil: undefined }), (p, arr) => {
        const pres = p as unknown as Presentation;
        const ids = new Set(pres.sections.map((s) => s));
        for (const s of arrangedSections(pres, arr)) expect(ids.has(s)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('regression: a loop slide with a NaN, zero or negative duration auto-advances after a sane delay', () => {
    for (const durationMs of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const p = {
        id: 'p',
        kind: 'loop',
        sections: [{ id: 's', label: 'S', short: 'S', slides: [{ id: 'x', objects: [], durationMs }] }],
        arrangements: [],
      } as unknown as Presentation;
      const cues = expandCues({
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'p',
          items: [{ id: 'i', kind: 'presentation', presentationId: 'p' }],
        },
        presentations: { p },
        media: {},
      });
      expect(cues[0]!.autoAdvanceMs).toBeGreaterThanOrEqual(500);
      expect(Number.isFinite(cues[0]!.autoAdvanceMs)).toBe(true);
    }
  });

  it('regression: a cue label never splits a surrogate pair', () => {
    const text = `${'a'.repeat(58)}😀😀`;
    const p = {
      id: 'p',
      kind: 'slides',
      sections: [
        {
          id: 's',
          label: 'S',
          short: 'S',
          slides: [{ id: 'x', objects: [{ id: 'o', type: 'text', text }] }],
        },
      ],
      arrangements: [],
    } as unknown as Presentation;
    const cues = expandCues({
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'p',
        items: [{ id: 'i', kind: 'presentation', presentationId: 'p' }],
      },
      presentations: { p },
      media: {},
    });
    expect(wellFormed(cues[0]!.label)).toBe(true);
  });
});

const CSS_RGBA = /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(0|1|0?\.\d+)\)$/;
const rgbaArb = fc.record({ r: num, g: num, b: num, a: num });

describe('colour helpers (fuzz)', () => {
  it('hexToRgba always yields channels in range for any string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 12 }), num, (hex, a) => {
        const c = hexToRgba(hex, a);
        for (const v of [c.r, c.g, c.b]) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
        expect(c.a).toBeGreaterThanOrEqual(0);
        expect(c.a).toBeLessThanOrEqual(1);
      }),
      { numRuns: 3000 },
    );
  });

  it('rgbaHex round-trips through hexToRgba and is always #rrggbb', () => {
    fc.assert(
      fc.property(rgbaArb, (c) => {
        const hex = rgbaHex(c);
        expect(hex).toMatch(/^#[0-9a-f]{6}$/);
        expect(rgbaHex(hexToRgba(hex))).toBe(hex);
      }),
      { numRuns: 3000 },
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const hex = `#${n.toString(16).padStart(6, '0')}`;
        expect(rgbaHex(hexToRgba(hex))).toBe(hex);
      }),
    );
  });

  it('rgbaCss is always valid CSS', () => {
    fc.assert(
      fc.property(fc.option(rgbaArb, { nil: undefined }), (c) => {
        const css = rgbaCss(c as never);
        if (c === undefined) expect(css).toBe('transparent');
        else expect(css).toMatch(CSS_RGBA);
      }),
      { numRuns: 3000 },
    );
  });

  it('nearColor never throws and is symmetric', () => {
    fc.assert(
      fc.property(rgbaArb, rgbaArb, (x, y) => {
        expect(nearColor(x, y)).toBe(nearColor(y, x));
      }),
    );
  });

  it('regressions: garbage hex and NaN channels', () => {
    expect(hexToRgba('zz')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(hexToRgba('#fff', Number.NaN)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(hexToRgba('#11223380')).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 1 });
    expect(rgbaHex({ r: Number.NaN, g: 300, b: -4, a: 1 })).toBe('#00ff00');
    expect(rgbaCss({ r: Number.NaN, g: 1e9, b: 2.6, a: 7 })).toBe('rgba(0,255,3,1)');
  });
});

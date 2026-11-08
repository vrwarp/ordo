import { type ShapeObject, Slide, type SlideObject, slideBytes } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  type EmitResult,
  GEOM_FILE_CHARS,
  GEOM_PREFIX,
  MAX_SLIDE_BYTES,
  SLIDE_BYTES_NOTE,
  storedSlideBytes,
} from './emit.ts';
import { convertDeck, emitSlides, parseDeck } from './index.ts';
import { body, buildDeck, custGeom, inlineGeoms, para, run, solid, sp } from './test-util.ts';

/**
 * Geometry files (design/27 §3.1 `ShapeGeom.ref`, §3.4, §15 M6 round 2): a geometry whose paths are large on
 * its slide is written once in a geometry file, not in every slide and object that draws it, and the slide is
 * measured as the hub stores it, so the converter's class is the hub's.
 */

const IN = 914_400;
const pt = (x: number, y: number) => `<a:pt x="${x}" y="${y}"/>`;
/** A closed polygon of `n` points in 7-digit EMU, as a traced decoration's (different for each `k`). */
function polygon(n: number, k = 0): string {
  let s = `<a:moveTo>${pt(1_000_000 + k, 1_000_000)}</a:moveTo>`;
  for (let i = 1; i < n; i++)
    s += `<a:lnTo>${pt(1_000_000 + ((i * 7_919 + k * 31) % 9_000_000), 1_000_000 + ((i * 104_729) % 5_000_000))}</a:lnTo>`;
  return `${s}<a:close/>`;
}
/** A filled custom-geometry shape drawing `polygon(n, k)` at `w` x `w / 2` inches. */
function deco(id: number, n: number, k = 0, w = 2): string {
  return sp({
    id,
    x: id * 10_000,
    y: 0,
    cx: w * IN,
    cy: (w * IN) / 2,
    geom: 'none',
    fill: custGeom({ paths: `<a:path w="10000000" h="6000000">${polygon(n, k)}</a:path>` }) + solid('FF0000'),
  });
}

const emit = (slides: string[], opts = {}) =>
  emitSlides(parseDeck(buildDeck({ slides: slides.map((shapes) => ({ shapes })) })), opts);
/** The slide's shapes with a geometry (the background rect has none). */
const shapesOf = (s: EmitResult['slides'][number]) =>
  s.slide.objects.filter((o): o is ShapeObject => o.type === 'shape' && o.geom !== undefined);
const pathChars = (o: ShapeObject) => JSON.stringify({ paths: o.geom?.paths ?? [] }).length;

describe('geometry files (ShapeGeom.ref)', () => {
  it('writes a large geometry once, named on every object and slide that draws it, at any size', () => {
    const slides = [deco(2, 400) + deco(3, 400, 0, 1), deco(2, 400, 0, 3)];
    const out = emit(slides);
    for (const s of out.slides) expect(Slide.parse(s.slide)).toEqual(s.slide);
    const geoms = out.slides.flatMap((s) => shapesOf(s).map((o) => o.geom));
    expect(geoms).toEqual([
      { ref: `${GEOM_PREFIX}1` },
      { ref: `${GEOM_PREFIX}1` },
      { ref: `${GEOM_PREFIX}1` },
    ]);
    expect(out.geoms.map((g) => g.id)).toEqual([`${GEOM_PREFIX}1`]);
    // The file holds exactly what the slide would hold inline.
    const inline = emit(slides, { geomFiles: false });
    const paths = shapesOf(inline.slides[0]!)[0]!.geom!.paths!;
    expect(JSON.stringify({ paths }).length).toBeGreaterThan(GEOM_FILE_CHARS);
    expect(out.geoms[0]!.file.paths).toEqual(paths);
    expect(inline.geoms).toEqual([]);
    expect(inlineGeoms(out).slides.map((s) => s.slide)).toEqual(inline.slides.map((s) => s.slide));
    // Slide by slide on the pool (`convertDeck`): one placeholder per file over the call.
    const parts = buildDeck({ slides: slides.map((shapes) => ({ shapes })) });
    const conv = convertDeck(parts);
    expect(conv.geoms).toEqual(out.geoms);
    expect(conv.slides.map((s) => s.slide)).toEqual(out.slides.map((s) => s.slide));
  });

  it('keeps a small geometry inline, unless the slide draws it often enough to pass GEOM_FILE_CHARS', () => {
    const once = emit([deco(2, 12)]);
    const o = shapesOf(once.slides[0]!)[0]!;
    expect(o.geom?.paths).toBeDefined();
    expect(o.geom?.ref).toBeUndefined();
    expect(once.geoms).toEqual([]);
    const times = Math.floor(GEOM_FILE_CHARS / pathChars(o)) + 1;
    const often = emit([Array.from({ length: times }, (_, i) => deco(i + 2, 12)).join('')]);
    expect(shapesOf(often.slides[0]!).every((x) => x.geom?.ref === `${GEOM_PREFIX}1`)).toBe(true);
    expect(often.geoms).toHaveLength(1);
  });

  it('moves the largest smaller geometries to files while the slide as stored passes the budget', () => {
    // 70 different geometries of about 1.4 KB each: about 100 KB of path text, none large on its own.
    const shapes = Array.from({ length: 70 }, (_, i) => deco(i + 2, 70 + (i % 7), i)).join('');
    const inline = emit([shapes], { geomFiles: false }).slides[0]!;
    expect(storedSlideBytes(inline.slide, inline.notes)).toBeGreaterThan(MAX_SLIDE_BYTES);
    // Over the budget, flagged for the importer's ladder; its class stays (M9: never a picture).
    expect(inline.classification.class).toBe('native');
    expect(inline.overBudget).toBe(true);
    for (const o of shapesOf(inline)) expect(pathChars(o)).toBeLessThan(GEOM_FILE_CHARS);
    const out = emit([shapes]);
    const s = out.slides[0]!;
    expect(s.classification.class).toBe('native');
    expect(s.overBudget).toBeUndefined();
    const stored = storedSlideBytes(s.slide, s.notes);
    expect(stored).toBeLessThanOrEqual(MAX_SLIDE_BYTES - 4 * 1024);
    const moved = shapesOf(s).filter((o) => o.geom?.ref);
    const kept = shapesOf(s).filter((o) => o.geom?.paths);
    expect(moved.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);
    expect(out.geoms).toHaveLength(moved.length);
    // The largest went first: every geometry kept inline is no larger than any one in a file.
    const files = new Map(out.geoms.map((g) => [g.id, JSON.stringify({ paths: g.file.paths }).length]));
    const smallestMoved = Math.min(...moved.map((o) => files.get(o.geom!.ref!)!));
    expect(Math.max(...kept.map(pathChars))).toBeLessThanOrEqual(smallestMoved);
  });

  it('flags a slide past the budget as stored with its paths in files, keeping its class (M9)', () => {
    // Formatted text within its own budget, and many plain shapes: together past 64 KB.
    const colors = ['FF0000', '00FF00'];
    const runs = Array.from({ length: 300 }, (_, i) => run(`w${i} `, '', solid(colors[i % 2]!))).join('');
    const text = Array.from({ length: 5 }, (_, i) =>
      sp({ id: i + 2, x: 0, y: 0, cx: IN, cy: IN, txBody: body(para(runs)) }),
    ).join('');
    const rects = Array.from({ length: 140 }, (_, i) =>
      sp({
        id: i + 10,
        x: i * 1_000,
        y: 0,
        cx: IN / 4,
        cy: IN / 4,
        fill: solid('0000FF'),
        ln: solid('000000'),
      }),
    ).join('');
    const s = emit([text + rects]).slides[0]!;
    expect(s.notes).not.toContain('the slide has more than 64 KB of text formatting');
    expect(storedSlideBytes(s.slide, s.notes)).toBeGreaterThan(MAX_SLIDE_BYTES);
    expect(s.classification.class).toBe('native');
    expect(s.classification.reasons.join(' ')).not.toMatch(/KB/);
    expect(s.notes).toContain(SLIDE_BYTES_NOTE);
    expect(s.overBudget).toBe(true);
  });

  it('estimates the slide as the hub stores it, a little over it and never under', () => {
    const out = emit([deco(2, 400) + Array.from({ length: 40 }, (_, i) => deco(i + 3, 20, i)).join('')]);
    const s = out.slides[0]!;
    // nativeJob's record(): ULID ids, files named by SHA-256, an origin on every object, the provenance.
    let n = 0;
    const objects = s.slide.objects.map((o): SlideObject => {
      const c = {
        ...o,
        id: `${'0'.repeat(20)}${String(++n).padStart(6, '0')}`,
        origin: o.origin ?? { src: 'pptx' },
      };
      if (c.type === 'shape' && c.geom?.ref) c.geom = { ...c.geom, ref: 'f'.repeat(64) };
      return c;
    });
    const record = {
      ...s.slide,
      id: '1'.repeat(26),
      objects,
      pptx: {
        fileId: 'f'.repeat(64),
        index: 1_999,
        shown: 1_999,
        class: 'hybrid' as const,
        version: 99,
        pending: true,
        digest: 'x'.repeat(16),
        ...(s.notes.length ? { notes: s.notes } : {}),
      },
    };
    const est = storedSlideBytes(s.slide, s.notes);
    expect(est).toBeGreaterThanOrEqual(slideBytes(record));
    expect(est - slideBytes(record)).toBeLessThan(512);
  });
});

import { type ImageObject, Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  applySheet,
  type BakeRaster,
  cellSourceSize,
  checkSheet,
  SHEET_LIMITS,
  type SheetBake,
  type SheetCell,
  sheetKey,
} from './bake.ts';
import { MAX_SLIDE_PICTURES } from './classify.ts';
import { frameOf } from './frame.ts';
import { convertDeck, emitSlides, parseDeck } from './index.ts';
import type { Element, PictureElement } from './ir.ts';
import { atlasParts, compositable, pictureRuns, SHEET_DENSITY, SHEET_PREFIX } from './sheet.ts';
import { buildDeck, grpSp, imageRel, pic } from './test-util.ts';

const IN = 914_400;
const FRAME = frameOf(12_192_000, 6_858_000);

/** A raster of `w` x `h` pixels, every pixel `px(x, y)`. */
function raster(w: number, h: number, px: (x: number, y: number) => number[]): BakeRaster {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const at = (r: BakeRaster, x: number, y: number) => [
  ...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4),
];

/** A picture element at (x, y) inches, `w` x `h` inches, of `part`, turned by `rot` degrees. */
function picEl(x: number, y: number, part = 'ppt/media/a.png', extra: Partial<PictureElement> = {}, rot = 0) {
  const r = (rot * Math.PI) / 180;
  const w = IN;
  const h = IN;
  const cx = x * IN + w / 2;
  const cy = y * IN + h / 2;
  const a = w * Math.cos(r);
  const b = w * Math.sin(r);
  const c = -h * Math.sin(r);
  const d = h * Math.cos(r);
  return {
    kind: 'picture',
    shapeId: 1,
    name: '',
    xf: [a, b, c, d, cx - (a + c) / 2, cy - (b + d) / 2],
    from: 'slide',
    support: 'native',
    geom: 'rect',
    picture: { part },
    ...extra,
  } as Element;
}

/** `n` one-inch pictures of `parts` in turn, in rows of 12 a third of an inch apart, in one group. */
function pictures(n: number, parts: string[], opts: { rot?: (i: number) => number; first?: number } = {}) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const o = pic({
      id: (opts.first ?? 10) + i,
      x: (i % 12) * (IN / 3),
      y: Math.floor(i / 12) * (IN / 3),
      cx: IN / 3,
      cy: IN / 3,
      rId: `rId${2 + (i % parts.length)}`,
    });
    const rot = opts.rot?.(i);
    out += rot ? o.replace('<a:xfrm>', `<a:xfrm rot="${rot * 60_000}">`) : o;
  }
  return out;
}
const rels = (parts: string[]) => parts.map((p, i) => imageRel(`rId${2 + i}`, p));

describe('picture sheets: composites (M9, decor-conv)', () => {
  it('runs z-adjacent plain pictures, at least two, ended by anything else', () => {
    const els = [picEl(0, 0), picEl(1, 0), picEl(2, 0, 'ppt/media/b.png')];
    expect(pictureRuns(els, FRAME)).toEqual([[0, 1, 2]]);
    // A clip's poster, an outline, a clip geometry, a tile, a hidden one (skipped), an excluded one (ends).
    const media = picEl(1, 0, 'ppt/media/a.png', { media: { kind: 'video' } as never });
    expect(pictureRuns([picEl(0, 0), media, picEl(2, 0), picEl(3, 0)], FRAME)).toEqual([[2, 3]]);
    const line = picEl(1, 0, 'ppt/media/a.png', { line: { width: 1, fill: { kind: 'none' } } as never });
    expect(pictureRuns([picEl(0, 0), line, picEl(2, 0)], FRAME)).toEqual([]);
    expect(compositable(picEl(0, 0, 'a', { geom: 'ellipse' }), FRAME)).toBe(false);
    expect(compositable(picEl(0, 0, 'a', { picture: { part: 'a', tile: {} as never } }), FRAME)).toBe(false);
    expect(pictureRuns([picEl(0, 0), picEl(1, 0, 'a', { hidden: true }), picEl(2, 0)], FRAME)).toEqual([
      [0, 2],
    ]);
    expect(pictureRuns([picEl(0, 0), picEl(1, 0), picEl(2, 0)], FRAME, new Set([1]))).toEqual([]);
    // Any turn joins (a sheared group child does not); past the render clamp's bounds, never.
    expect(compositable(picEl(0, 0, 'a', {}, 33), FRAME)).toBe(true);
    expect(compositable(picEl(1e3, 0), FRAME)).toBe(false);
    // At most SHEET_LIMITS.cells a run.
    const many = Array.from({ length: SHEET_LIMITS.cells + 3 }, (_, i) => picEl(i % 10, 0));
    expect(pictureRuns(many, FRAME).map((r) => r.length)).toEqual([SHEET_LIMITS.cells, 3]);
  });

  it('draws 160 pictures in one group as composites, cells at 2 px per logical px, the slide native', () => {
    const parts = ['photo-a.png', 'photo-b.png'];
    const deck = buildDeck({
      slides: [
        {
          rels: rels(parts),
          shapes: grpSp({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: 4 * IN }, pictures(160, parts)),
        },
      ],
    });
    const out = emitSlides(parseDeck(deck));
    const s = out.slides[0]!;
    expect(Slide.safeParse(s.slide).success).toBe(true);
    expect(s.classification.class).toBe('native');
    const images = s.slide.objects.filter((o): o is ImageObject => o.type === 'image');
    // 160 pictures in runs of at most 64: the first composite brings the slide within the budget (161 - 63).
    const sheets = images.filter((o) => o.mediaId.startsWith(SHEET_PREFIX));
    expect(sheets.map((o) => o.mediaId)).toEqual([`${SHEET_PREFIX}1`]);
    expect(images).toHaveLength(97);
    expect(sheets.every((o) => o.locked && o.fit === 'stretch' && !o.crop && o.box.rotation === 0)).toBe(
      true,
    );
    expect(out.sheets).toHaveLength(1);
    const first = out.sheets[0]!.bake;
    expect(first.layout).toBe('composite');
    expect(first.cells).toHaveLength(64);
    // A third of an inch is 48 logical px: 96 px cells at the 3840 density, laid at their place.
    expect(first.cells[0]).toMatchObject({ part: 'ppt/media/photo-a.png', x: 0, y: 0, w: 96, h: 96 });
    expect(first.cells[1]).toMatchObject({ part: 'ppt/media/photo-b.png', x: 96, y: 0, w: 96, h: 96 });
    expect(first.w).toBe(Math.round(sheets[0]!.box.w * SHEET_DENSITY));
    checkSheet(first);
    // The objects as they are without it, to put back when the sheet cannot be made.
    expect(s.sheets).toHaveLength(1);
    expect(s.sheets![0]!.uses).toEqual([sheets[0]!.id]);
    expect(s.sheets![0]!.objects).toHaveLength(64);
    expect(s.sheets![0]!.objects[0]).toMatchObject({
      type: 'image',
      mediaId: 'pptxmedia:1',
      box: { w: 48, h: 48 },
    });
    expect(s.sheets![0]!.objects.every((o) => o.origin?.src === 'pptx')).toBe(true);
    expect(s.notes).toContain("64 pictures are drawn as 1 picture(s) (the slide's object budget)");
    // The cells' parts stay in the deck's media: the sheet is made of them, and they come back on failure.
    expect(out.media.map((m) => m.part)).toEqual(['ppt/media/photo-a.png', 'ppt/media/photo-b.png']);
    // An importer that cannot make sheets asks for none: every picture its own object.
    const apart = emitSlides(parseDeck(deck), { sheets: false });
    expect(apart.sheets).toEqual([]);
    expect(apart.slides[0]!.slide.objects.filter((o) => o.type === 'image')).toHaveLength(160);
    // Within the budget nothing is composited.
    const small = emitSlides(
      parseDeck(
        buildDeck({
          slides: [
            { rels: rels(parts), shapes: grpSp({ id: 2, x: 0, y: 0, cx: IN, cy: IN }, pictures(40, parts)) },
          ],
        }),
      ),
    );
    expect(small.sheets).toEqual([]);
    expect(small.slides[0]!.sheets).toBeUndefined();
  });

  it('keeps turns: quarter turns and flips by index, any other angle as a turned cell with its source size', () => {
    const parts = ['p.png'];
    const deck = buildDeck({
      slides: [
        {
          rels: rels(parts),
          shapes: grpSp(
            { id: 2, x: 0, y: 0, cx: 4 * IN, cy: 4 * IN },
            pictures(160, parts, { rot: (i) => (i % 3 === 0 ? 90 : i % 3 === 1 ? 30 : 0) }),
          ),
        },
      ],
    });
    const out = emitSlides(parseDeck(deck));
    const cells = out.sheets[0]!.bake.cells;
    expect(cells[0]).toMatchObject({ quarter: 1, w: 96, h: 96 });
    expect(cells[0]!.rotation).toBeUndefined();
    // A 30° turn: the cell is the turned box's bounds; the source is decoded unturned at 96 px.
    expect(cells[1]).toMatchObject({ rotation: 30, src: { w: 96, h: 96 } });
    expect(cells[1]!.w).toBe(Math.round(96 * (Math.cos(Math.PI / 6) + Math.sin(Math.PI / 6))));
    expect(cellSourceSize(cells[1]!)).toEqual({ width: 96, height: 96 });
    expect(cells[2]!.quarter).toBeUndefined();
    expect(cells[2]!.rotation).toBeUndefined();
    checkSheet(out.sheets[0]!.bake);
  });

  it('keeps one recipe a deck: slides repeating a pattern share one sheet (the key is stable)', () => {
    const parts = ['p.png', 'q.png'];
    const slide = {
      rels: rels(parts),
      shapes: grpSp({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: 4 * IN }, pictures(152, parts)),
    };
    const out = convertDeck(buildDeck({ slides: [slide, slide] }));
    const ids = out.slides.map((s) =>
      s.slide.objects.filter((o) => o.type === 'image').map((o) => (o as ImageObject).mediaId),
    );
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]!.filter((id) => id.startsWith(SHEET_PREFIX))).toEqual([`${SHEET_PREFIX}1`]);
    expect(out.sheets).toHaveLength(1);
    const b = out.sheets[0]!.bake;
    expect(sheetKey(JSON.parse(JSON.stringify(b)))).toBe(sheetKey(b));
  });
});

describe('picture sheets: atlas (M9, decor-conv)', () => {
  it('packs the fewest smallest pictures past 12 distinct ones', () => {
    // 14 distinct parts, of growing size: the 3 smallest bring the slide to 12.
    const els = Array.from({ length: 14 }, (_, i) => {
      const e = picEl(i % 5, Math.floor(i / 5), `ppt/media/${i}.png`) as PictureElement;
      e.xf = [IN * (1 + i / 10), 0, 0, IN * (1 + i / 10), (i % 5) * 2 * IN, Math.floor(i / 5) * 2 * IN];
      return e as Element;
    });
    expect(atlasParts(els, FRAME, 14, MAX_SLIDE_PICTURES)).toEqual([
      'ppt/media/0.png',
      'ppt/media/1.png',
      'ppt/media/2.png',
    ]);
    expect(atlasParts(els, FRAME, 12, MAX_SLIDE_PICTURES)).toEqual([]);
    // A part a clip's poster uses, or the background's, stays out of it.
    const poster = { ...(els[0] as PictureElement), media: { kind: 'video' } } as Element;
    expect(atlasParts([poster, ...els.slice(1)], FRAME, 14, MAX_SLIDE_PICTURES)).not.toContain(
      'ppt/media/0.png',
    );
    expect(atlasParts(els, FRAME, 14, MAX_SLIDE_PICTURES, new Set(['ppt/media/1.png']))).not.toContain(
      'ppt/media/1.png',
    );
  });

  it('shows each packed picture through its crop into the atlas, its box kept', () => {
    const parts = Array.from({ length: 14 }, (_, i) => `p${i}.png`);
    let shapes = '';
    parts.forEach((_, i) => {
      const size = IN * (0.5 + i / 10);
      shapes += pic({
        id: 2 + i,
        x: (i % 5) * 2 * IN,
        y: Math.floor(i / 5) * 2 * IN,
        cx: size,
        cy: size,
        rId: `rId${2 + i}`,
        ...(i === 0 ? { srcRect: 'l="25000"' } : {}),
      });
    });
    const out = emitSlides(parseDeck(buildDeck({ slides: [{ rels: rels(parts), shapes }] })));
    const s = out.slides[0]!;
    expect(s.classification).toMatchObject({
      class: 'native',
      atlas: ['ppt/media/p0.png', 'ppt/media/p1.png', 'ppt/media/p2.png'],
    });
    expect(s.classification.reasons).not.toContain('budget:pictures');
    const images = s.slide.objects.filter((o): o is ImageObject => o.type === 'image');
    expect(new Set(images.map((o) => o.mediaId)).size).toBe(MAX_SLIDE_PICTURES);
    const atlas = out.sheets[0]!.bake;
    expect(atlas.layout).toBe('atlas');
    expect(atlas.cells).toHaveLength(3);
    // The cell holds the picture's visible region (its own crop) at its box's size times 2.
    const c0 = atlas.cells.find((c) => c.part === 'ppt/media/p0.png')!;
    expect(c0.crop).toEqual({ l: 0.25, t: 0, r: 0, b: 0 });
    expect(c0.w).toBe(Math.round(0.5 * 144 * SHEET_DENSITY));
    const o0 = images.find((o) => o.mediaId === s.sheets![0]!.id && o.box.w === 72)!;
    expect(o0.crop!.l).toBeCloseTo(c0.x / atlas.w, 6);
    expect(o0.crop!.r).toBeCloseTo(1 - (c0.x + c0.w) / atlas.w, 6);
    expect(o0.crop!.t).toBeCloseTo(c0.y / atlas.h, 6);
    expect(o0.box).toMatchObject({ w: 72, h: 72 });
    // Put back as they were if the atlas cannot be made.
    const back = s.sheets![0]!.objects.find((o) => o.id === o0.id)!;
    expect(back).toMatchObject({ mediaId: 'pptxmedia:1', crop: { l: 0.25 } });
    expect(s.sheets![0]!.uses).toContain(o0.id);
    checkSheet(atlas);
    expect(Slide.safeParse(s.slide).success).toBe(true);
    expect(s.notes).toContain("3 pictures are drawn from one picture (the slide's picture budget)");
  });
});

describe('applySheet (the pixels of a sheet)', () => {
  const red = [255, 0, 0, 255];
  const half = [0, 0, 255, 128];
  const cell = (c: Partial<SheetCell>): SheetCell => ({ part: 'a', x: 0, y: 0, w: 2, h: 2, ...c });

  it('lays cells over each other in order, straight alpha "over", transparent elsewhere', () => {
    const bake: SheetBake = { w: 3, h: 2, layout: 'composite', cells: [cell({}), cell({ x: 1, w: 2 })] };
    const out = applySheet(bake, [
      { cell: bake.cells[0]!, raster: raster(2, 2, () => red) },
      { cell: bake.cells[1]!, raster: raster(2, 2, () => half) },
    ]);
    expect(at(out, 0, 0)).toEqual(red);
    // Blue at alpha 0.5 over opaque red.
    expect(at(out, 1, 0)).toEqual([127, 0, 128, 255]);
    // Blue at alpha 0.5 over nothing.
    expect(at(out, 2, 1)).toEqual([0, 0, 255, 128]);
    // A cell's alpha (alphaModFix) scales it.
    const faded: SheetBake = { w: 1, h: 1, layout: 'composite', cells: [cell({ w: 1, h: 1, alpha: 0.5 })] };
    expect(at(applySheet(faded, [{ cell: faded.cells[0]!, raster: raster(1, 1, () => red) }]), 0, 0)).toEqual(
      [255, 0, 0, 128],
    );
  });

  it('turns and mirrors by index arithmetic, and samples any other turn as Canvas draws it', () => {
    // A 3 x 2 source, each pixel its own value.
    const src = () => raster(3, 2, (x, y) => [x * 80, y * 200, 0, 255]);
    const q1: SheetBake = { w: 2, h: 3, layout: 'composite', cells: [cell({ w: 2, h: 3, quarter: 1 })] };
    const out = applySheet(q1, [{ cell: q1.cells[0]!, raster: src() }]);
    // A quarter turn clockwise: the source's top-left lands at the cell's top-right.
    expect(at(out, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(at(out, 0, 0)).toEqual([0, 200, 0, 255]);
    expect(at(out, 1, 2)).toEqual([160, 0, 0, 255]);
    const flip: SheetBake = { w: 3, h: 2, layout: 'composite', cells: [cell({ w: 3, h: 2, flipH: true })] };
    expect(at(applySheet(flip, [{ cell: flip.cells[0]!, raster: src() }]), 0, 0)).toEqual([160, 0, 0, 255]);
    // A turned cell at 0° is the source itself; at 90° it is the quarter turn (bilinear at pixel centres).
    const t0: SheetBake = {
      w: 3,
      h: 2,
      layout: 'composite',
      cells: [cell({ w: 3, h: 2, rotation: 0, src: { w: 3, h: 2 } })],
    };
    expect(applySheet(t0, [{ cell: t0.cells[0]!, raster: src() }]).data).toEqual(src().data);
    const t90: SheetBake = {
      w: 2,
      h: 3,
      layout: 'composite',
      cells: [cell({ w: 2, h: 3, rotation: 90, src: { w: 3, h: 2 } })],
    };
    expect(applySheet(t90, [{ cell: t90.cells[0]!, raster: src() }]).data).toEqual(out.data);
    // At 45° a pixel of the corners is outside the turned picture: transparent.
    const t45: SheetBake = {
      w: 4,
      h: 4,
      layout: 'composite',
      cells: [cell({ w: 4, h: 4, rotation: 45, src: { w: 3, h: 2 } })],
    };
    expect(at(applySheet(t45, [{ cell: t45.cells[0]!, raster: src() }]), 0, 0)[3]).toBe(0);
  });

  it('refuses a sheet past its limits, a cell outside it, and a cell decoded at the wrong size', () => {
    const ok: SheetBake = { w: 2, h: 2, layout: 'atlas', cells: [cell({})] };
    expect(() => checkSheet(ok)).not.toThrow();
    expect(() => checkSheet({ ...ok, cells: [] })).toThrow(/cells/);
    expect(() => checkSheet({ ...ok, cells: Array.from({ length: 65 }, () => cell({})) })).toThrow(/cells/);
    expect(() => checkSheet({ ...ok, cells: [cell({ x: 1 })] })).toThrow(/outside/);
    expect(() => checkSheet({ ...ok, w: 9_000 })).toThrow(/larger/);
    expect(() => checkSheet({ ...ok, cells: [cell({ rotation: 30 })] })).toThrow(/source size/);
    const big = Array.from({ length: 3 }, () => cell({ w: 8_000, h: 2_000 }));
    expect(() => checkSheet({ w: 8_000, h: 2_000, layout: 'composite', cells: big })).toThrow(/decodes/);
    expect(() => applySheet(ok, [{ cell: ok.cells[0]!, raster: raster(3, 2, () => red) }])).toThrow(
      /wrong size/,
    );
  });
});

describe('without sheets (the M9 rollout: the hub and the client store none yet)', () => {
  /** One slide of `n` distinct pictures, of growing size. */
  function distinct(n: number) {
    const parts = Array.from({ length: n }, (_, i) => `q${i}.png`);
    let shapes = '';
    parts.forEach((_, i) => {
      const size = IN * (0.4 + i / 20);
      shapes += pic({
        id: 2 + i,
        x: (i % 6) * 1.6 * IN,
        y: Math.floor(i / 6) * 1.6 * IN,
        cx: size,
        cy: size,
        rId: `rId${2 + i}`,
      });
    });
    return buildDeck({ slides: [{ rels: rels(parts), shapes }] });
  }

  it('draws more than 12 distinct pictures each as itself: no atlas, no sheet placeholder, nothing missing', () => {
    const parts = distinct(14);
    // With sheets (the default) the three smallest go into an atlas.
    expect(convertDeck(parts).slides[0]!.classification.atlas).toHaveLength(3);
    const out = convertDeck(parts, { sheets: false });
    const s = out.slides[0]!;
    expect(s.classification).toMatchObject({ class: 'native' });
    expect(s.classification.atlas).toBeUndefined();
    expect(out.sheets).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(SHEET_PREFIX);
    const images = s.slide.objects.filter((o): o is ImageObject => o.type === 'image');
    expect(new Set(images.map((o) => o.mediaId)).size).toBe(14);
    expect(s.missing).toBeUndefined();
    // Parsed alone the same way (`ParseOptions.sheets`).
    expect(parseDeck(parts, { sheets: false }).slides[0]!.classification.atlas).toBeUndefined();
  });

  it('keeps the 16 the render clamp draws, and lists the topmost past them as missing', () => {
    const s = convertDeck(distinct(20), { sheets: false }).slides[0]!;
    const images = s.slide.objects.filter((o): o is ImageObject => o.type === 'image');
    expect(new Set(images.map((o) => o.mediaId)).size).toBe(16);
    // The four topmost (the last written) are left out, listed (a left-out picture is a 'decoration'), and
    // the slide is hybrid.
    expect(images.map((o) => o.mediaId)).not.toContain('pptxmedia:20');
    expect(s.classification).toMatchObject({ class: 'hybrid', missing: ['decoration'] });
    expect(s.missing).toEqual(['decoration']);
    expect(s.notes).toContain("4 element(s) past the slide's budgets are not drawn");
    expect(Slide.safeParse(s.slide).success).toBe(true);
  });
});

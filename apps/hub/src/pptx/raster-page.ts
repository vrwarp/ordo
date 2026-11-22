import type { ShapeObject } from '@ordo/domain';
import { type BakeEnv, createBakeEnv } from '@ordo/renderer/bake.ts';
import { clampObject } from '@ordo/renderer/clamp.ts';
import { drawShapeWide } from '@ordo/renderer/geom/wide.ts';
import type { BuiltGeom, GeomPath } from '@ordo/renderer/geom/path.ts';
import { drawObject } from '@ordo/renderer/text2d.ts';
import { shippedStack } from '@ordo/renderer/text/coverage.ts';
import type { FontHost } from '@ordo/renderer/text/fonts.ts';
import { checkRecipe, type RasterFont, type RecipeMemberWire, type RecipeWire } from './raster-recipe.ts';

/*
 * The picture page (the owner's Q53 and Q56.d: the hub uses the browser where it can). The hub's own headless
 * Chromium loads this file, built by apps/hub/build.mjs as a browser iife (dist/raster-page.js), and draws the
 * recipe (raster-recipe.ts, C-RM1) it is handed as a FILE with ordo's own renderer: a shape by `drawShapeWide`
 * (geom/wide.ts: the geometry the hub built, no 8-path x 4,096-point clamp), a text-bearing member's words by
 * the screens' own `drawObject`, so the line breaks and the glyph positions are the screens' by construction.
 * The picture is returned as a PNG with straight alpha (`convertToBlob`), in chunks the driver reassembles.
 *
 * Never trusted input: the recipe is checked again here (`checkRecipe`); the page loads only the recipe file and
 * the font files the driver names, has no network (the driver starts Chromium with every host unresolvable) and
 * exposes `window.__raster` and nothing else. Fonts are the library's and the bundled faces only: a text member
 * whose font string holds no registered face, or a character no registered face covers, fails the WHOLE run
 * with reason 'font' (never a picture in another face, never a computer's own font).
 *
 * Never imported by the hub's own code (the driver reads its built file), never in a service, never on a GO path.
 */

export type PageDraw =
  | { ok: true; w: number; h: number; bytes: number; chunks: number; ms: number }
  | { ok: false; reason: 'recipe' | 'font' | 'empty' | 'page'; detail: string };

/** Raw bytes of one chunk of the PNG (the DevTools pipe carries it as base64: a third more). */
const CHUNK_BYTES = 2 * 1024 * 1024;

/** The bytes of a file the driver names, by XMLHttpRequest (the file: scheme is not fetchable). */
function readBytes(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () =>
      x.response ? resolve(x.response as ArrayBuffer) : reject(new Error(`no data from ${x.status}`));
    x.onerror = () => reject(new Error('could not read a file'));
    x.send();
  });
}

const fontUrls = new Map<string, string>();

// The font set-up is the bake's (sub-wave 3, design 29 section 1.2): `createBakeEnv` makes a resolver in the bake
// profile (the library's and the bundled faces only, never a face of the computer), the blank face, the coverage
// probe and the wrap that feeds it. A new environment is made for every font list, so a picture never depends on
// what an earlier recipe registered.
const host: FontHost = {
  // The hub's tsconfig has no DOM.Iterable, where FontFaceSet gets add and delete: the page has them.
  set: document.fonts as unknown as FontHost['set'],
  async data(f) {
    const url = fontUrls.get(f.hash);
    if (!url) throw new Error('no such font file');
    return await readBytes(url);
  },
};
let env: BakeEnv = createBakeEnv(host);

let png: Uint8Array | undefined;

function bytesOf(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The built geometry of a member: its paths' commands and float32 points, `cont` paths joined to the one before. */
function builtOf(m: RecipeMemberWire): BuiltGeom {
  const box = m.shape.box as { w: number; h: number };
  const paths: { cmds: number[]; pts: number[]; fill: GeomPath['fill']; stroke: boolean }[] = [];
  for (const p of m.geom.paths) {
    const cmds = Array.from(bytesOf(p.cmds));
    const raw = bytesOf(p.pts);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const pts: number[] = [];
    for (let i = 0; i < raw.length; i += 4) pts.push(view.getFloat32(i, true));
    const prev = paths[paths.length - 1];
    if (p.cont === true && prev) {
      for (const c of cmds) prev.cmds.push(c);
      for (const v of pts) prev.pts.push(v);
    } else paths.push({ cmds, pts, fill: p.fill as GeomPath['fill'], stroke: p.stroke });
  }
  return { w: box.w, h: box.h, paths, text: { l: 0, t: 0, r: box.w, b: box.h }, sites: [] };
}

/** Whether any pixel has alpha (read back in bands of 64 rows: never the whole frame at once). */
function anyAlpha(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): boolean {
  for (let y = 0; y < h; y += 64) {
    const data = ctx.getImageData(0, y, w, Math.min(64, h - y)).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
  }
  return false;
}

async function drawRecipe(r: RecipeWire): Promise<PageDraw> {
  const t0 = performance.now();
  const canvas = new OffscreenCanvas(r.w, r.h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, reason: 'page', detail: '2D context unavailable' };
  const unshipped = new Set<string>();
  // Every text call is noted for the coverage probe by the environment's wrap of the context prototype, and a font
  // string with no registered face at all is a run that would draw in the computer's own font: refused.
  for (const name of ['fillText', 'strokeText'] as const) {
    const orig = ctx[name].bind(ctx) as (text: string, x: number, y: number, maxWidth?: number) => void;
    ctx[name] = ((text: string, x: number, y: number, maxWidth?: number) => {
      if (!shippedStack(ctx.font)) unshipped.add(ctx.font.slice(0, 60));
      if (maxWidth === undefined) orig(text, x, y);
      else orig(text, x, y, maxWidth);
    }) as typeof ctx.fillText;
  }
  if (!(await env.ready())) return { ok: false, reason: 'page', detail: 'the coverage probe is not ready' };
  env.fonts.bakeReset();
  env.coverage.begin();
  const D = r.density;
  for (const m of r.members) {
    ctx.setTransform(D, 0, 0, D, -r.box.x * D, -r.box.y * D);
    drawShapeWide(ctx, m.shape as unknown as ShapeObject, builtOf(m));
    if (m.text) {
      const o = clampObject(m.text);
      if (o) {
        // The words are drawn at density D in device px, translated by the run's box.
        ctx.setTransform(1, 0, 0, 1, -r.box.x * D, -r.box.y * D);
        drawObject(ctx, o, D);
      }
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const drawn = env.coverage.end();
  if (unshipped.size > 0)
    return { ok: false, reason: 'font', detail: 'text drawn in a font no registered face provides' };
  // Complete or nothing (the bake profile's report): a family with no face of its own would be drawn in ordo's
  // default face, and a face that failed to load in none; the picture of a shape never stands in for a face.
  const report = env.fonts.bakeReport();
  if (report.empty.size > 0 || report.standIns.size > 0 || env.fonts.failedFamilies().length > 0)
    return { ok: false, reason: 'font', detail: 'text in a family no loaded face provides' };
  const missing = env.coverage.misses(drawn, 8);
  if (missing.length > 0)
    return {
      ok: false,
      reason: 'font',
      detail: `${[...missing].length} character(s) no registered face covers`,
    };
  if (!anyAlpha(ctx, r.w, r.h)) return { ok: false, reason: 'empty', detail: 'every pixel is transparent' };
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  png = new Uint8Array(await blob.arrayBuffer());
  // The backing store is released now, not when the collector gets to it (33 MB a 4K picture).
  canvas.width = 0;
  canvas.height = 0;
  return {
    ok: true,
    w: r.w,
    h: r.h,
    bytes: png.length,
    chunks: Math.ceil(png.length / CHUNK_BYTES),
    ms: Math.round(performance.now() - t0),
  };
}

const api = {
  /** Registers the faces (a whole list, as `FontResolver.sync` takes it); resolves when loading has settled. */
  async setFonts(list: RasterFont[]): Promise<{ loaded: number; failed: string[] }> {
    // A new environment for this list: the faces of an earlier list are dropped with the old one.
    env.dispose();
    env = createBakeEnv(host);
    fontUrls.clear();
    for (const f of list) fontUrls.set(f.hash, f.url);
    const r = await env.fonts.sync(list.map(({ url: _url, ...file }) => file));
    return { loaded: r.loaded, failed: r.failed };
  },
  /** Reads the recipe file, checks it and draws it; the PNG waits in the page for `take`. */
  async draw(recipeUrl: string): Promise<PageDraw> {
    try {
      png = undefined;
      const checked = checkRecipe(new Uint8Array(await readBytes(recipeUrl)));
      if (!checked.ok) return { ok: false, reason: 'recipe', detail: checked.reason };
      return await drawRecipe(checked.recipe);
    } catch (e) {
      return { ok: false, reason: 'page', detail: String(e instanceof Error ? e.message : e).slice(0, 200) };
    }
  },
  /** Chunk `i` of the PNG as base64. */
  take(i: number): string {
    if (!png) return '';
    const part = png.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    let s = '';
    for (let k = 0; k < part.length; k += 0x8000) s += String.fromCharCode(...part.subarray(k, k + 0x8000));
    return btoa(s);
  },
  /** Drops the PNG. */
  release(): void {
    png = undefined;
  },
};

(window as unknown as { __raster: typeof api }).__raster = api;

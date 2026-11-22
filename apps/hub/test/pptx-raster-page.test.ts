import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium } from '../../../tools/find-chromium.ts';
import { RasterBrowser, type RasterReason } from '../src/pptx/rasterPage.ts';
import { drawRasters, fontsFor, renderRecipe, type RasterSession } from '../src/pptx/rasters.ts';
import { builtOf, colour, memberWire, ngon, recipeWire, source, square } from './raster.recipes.test-util.ts';

/*
 * The picture page and its driver in a REAL headless Chromium (RM-D1, RM-D2, RM-D7). Skipped, and said so, when no
 * Chromium is found (ORDO_CHROMIUM, ORDO_TEST_CHROMIUM or Playwright's); under CI a missing one fails (find-chromium.ts).
 */

const exe = await findChromium({ system: true });
const skipped = exe === undefined;
if (skipped)
  console.warn(
    'pptx-raster-page.test.ts SKIPPED: no Chromium found (ORDO_CHROMIUM, ORDO_TEST_CHROMIUM, Playwright)',
  );

let scratch = '';
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ordo-raster-pagetest-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The RGBA pixels of an 8-bit, non-interlaced RGBA PNG (the page's PNG). */
function decode(png: Uint8Array): { w: number; h: number; type: number; rgba: Uint8Array } {
  const buf = Buffer.from(png);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const type = buf[25]!;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    if (buf.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      let v = line[x]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, type, rgba: out };
}

/** A library face for a text member: a family's regular face from the Debian package, as the bundled faces are. */
function faceOf(
  family: string,
): { family: string; weight: number; style: 'normal'; hash: string; url: string } | undefined {
  try {
    const file = execSync(`fc-match -f '%{file}' '${family}:style=Regular'`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    if (!file.toLowerCase().includes(family.toLowerCase()) || !existsSync(file)) return undefined;
    return {
      family,
      weight: 400,
      style: 'normal',
      hash: createHash('sha256').update(readFileSync(file)).digest('hex'),
      url: `file://${file}`,
    };
  } catch {
    return undefined;
  }
}
const carlito = () => faceOf('Carlito');

const groupAlive = (pgid: number): boolean => {
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      if (Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[2]) === pgid) return true;
    } catch {
      // gone
    }
  }
  return false;
};

describe.skipIf(skipped)('the picture page in a real Chromium', () => {
  it("RM-D1: draws a shape with a hole, a gradient and a text member: RGBA PNG of exactly the recipe's size, no matte", async () => {
    const run = { x: 0, y: 0, w: 200, h: 120 };
    const ringBox = { x: 10, y: 10, w: 80, h: 80 };
    const ring = memberWire(ringBox, builtOf(source([[...square(0, 1000), ...square(250, 750)]]), ringBox), {
      fill: colour(30, 120, 200),
    });
    const circleBox = { x: 100, y: 10, w: 80, h: 80 };
    const circle = memberWire(circleBox, builtOf(source([ngon(200, 480)]), circleBox), {
      fill: undefined,
      gradient: {
        kind: 'linear',
        angle: 0,
        stops: [
          { at: 0, color: colour(255, 0, 0) },
          { at: 1, color: colour(0, 0, 255) },
        ],
      },
    });
    const font = carlito();
    const textBox = { x: 20, y: 95, w: 160, h: 20 };
    const words = memberWire(
      textBox,
      builtOf(source([square(0, 1000)]), textBox),
      { fill: colour(0, 0, 0, 0) },
      {
        text: {
          type: 'text',
          box: { ...textBox, rotation: 0 },
          text: 'Amen',
          style: {
            fontFamily: 'Carlito',
            fontWeight: 400,
            fontStyle: 'normal',
            fontSizePx: 16,
            color: colour(0, 0, 0),
            align: 'center',
            valign: 'middle',
            lineHeight: 1.2,
            letterSpacing: 0,
            padding: 0,
          },
          opacity: 1,
        },
        families: ['Carlito'],
      },
    );
    const recipe = recipeWire(run, font ? [ring, circle, words] : [ring, circle]);
    if (!font) console.warn('RM-D1: no Carlito face here, the text member was left out of this run');
    const file = join(scratch, 'd1.json');
    writeFileSync(file, JSON.stringify(recipe));
    const b = await RasterBrowser.launch(exe!, scratch, { signal: new AbortController().signal });
    try {
      const r = await b.draw(file, font ? fontsFor(recipe, [font]) : []);
      expect(r).toMatchObject({ ok: true, w: 400, h: 240 });
      if (!r.ok) return;
      const img = decode(r.png);
      expect(img.type).toBe(6);
      expect([img.w, img.h]).toEqual([400, 240]);
      const px = (x: number, y: number) => [
        ...img.rgba.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4),
      ];
      // the hole is transparent, the ring is its fill, outside is transparent
      expect(px(100, 100)[3]).toBe(0);
      expect(px(30, 100)).toEqual([30, 120, 200, 255]);
      expect(px(300, 230)[3]).toBe(0);
      // the gradient runs red to blue across the circle
      const left = px(215, 100);
      const right = px(345, 100);
      expect(left[0]!).toBeGreaterThan(left[2]!);
      expect(right[2]!).toBeGreaterThan(right[0]!);
      // an opaque edge carries no matte: every opaque pixel of the ring row has the ring's own colour
      for (let x = 20; x < 180; x++) {
        const p = px(x, 100);
        if (p[3] === 255) expect(p.slice(0, 3)).toEqual([30, 120, 200]);
      }
      // the words are drawn (dark pixels in the text box)
      if (font) {
        let dark = 0;
        for (let y = 190; y < 230; y++) for (let x = 40; x < 360; x++) if (px(x, y)[3]! > 128) dark++;
        expect(dark).toBeGreaterThan(50);
      }
    } finally {
      await b.close();
    }
  }, 60_000);

  it("RM-D8: text in a family no loaded face provides, or a character no face covers, is reason 'font' and no picture; a list's faces never serve the next list", async () => {
    const font = carlito();
    if (!font) {
      console.warn('RM-D8: no Carlito face here, skipped');
      return;
    }
    const run = { x: 0, y: 0, w: 200, h: 40 };
    const textBox = { x: 10, y: 5, w: 180, h: 30 };
    const words = (text: string, family: string) =>
      memberWire(
        textBox,
        builtOf(source([square(0, 1000)]), textBox),
        { fill: colour(0, 0, 0, 0) },
        {
          text: {
            type: 'text',
            box: { ...textBox, rotation: 0 },
            text,
            style: {
              fontFamily: family,
              fontWeight: 400,
              fontStyle: 'normal',
              fontSizePx: 18,
              color: colour(0, 0, 0),
              align: 'center',
              valign: 'middle',
              lineHeight: 1.2,
              letterSpacing: 0,
              padding: 0,
            },
            opacity: 1,
          },
          families: [family],
        },
      );
    const inter = faceOf('Inter');
    const draw = async (b: RasterBrowser, name: string, text: string, family: string, faces: boolean) => {
      const recipe = recipeWire(run, [words(text, family)]);
      const file = join(scratch, `${name}.json`);
      writeFileSync(file, JSON.stringify(recipe));
      return await b.draw(file, faces ? fontsFor(recipe, [font]) : []);
    };
    // The library's default face is loaded too: a family with no face of its own then has a stand-in to be drawn
    // in, which a picture of a shape never accepts.
    const drawWithDefault = async (b: RasterBrowser, name: string, family: string) => {
      const recipe = recipeWire(run, [words('Amen', family)]);
      const file = join(scratch, `${name}.json`);
      writeFileSync(file, JSON.stringify(recipe));
      return await b.draw(file, fontsFor(recipe, [font, inter!], ['Inter']));
    };
    const b = await RasterBrowser.launch(exe!, scratch, { signal: new AbortController().signal });
    try {
      // the face is loaded: drawn
      expect(await draw(b, 'd8a', 'Amen', 'Carlito', true)).toMatchObject({ ok: true });
      // the same words after the face list changed to none: the old list's face does not serve (a fresh set-up per list)
      expect(await draw(b, 'd8b', 'Amen', 'Carlito', false)).toMatchObject({ ok: false, reason: 'font' });
      // a family nothing provides: never drawn in another face
      expect(await draw(b, 'd8c', 'Amen', 'No Such Family', true)).toMatchObject({
        ok: false,
        reason: 'font',
      });
      // a character no loaded face covers (Carlito has no Han): the whole run fails
      expect(await draw(b, 'd8d', 'Amen \u6f22', 'Carlito', true)).toMatchObject({
        ok: false,
        reason: 'font',
      });
      // a family with no face of its own, the default face loaded: not drawn in the default face
      if (inter) {
        expect(await drawWithDefault(b, 'd8f', 'No Such Family')).toMatchObject({
          ok: false,
          reason: 'font',
        });
      }
      // and the browser is still good for the next picture
      expect(await draw(b, 'd8e', 'Amen', 'Carlito', true)).toMatchObject({ ok: true });
    } finally {
      await b.close();
    }
  }, 90_000);

  it('RM-D2: an abort kills the whole group and leaves no process, profile folder or temp file', async () => {
    const run = { x: 0, y: 0, w: 1920, h: 1080 };
    const members = Array.from({ length: 600 }, (_, i) =>
      memberWire(
        { x: (i * 53) % 1800, y: (i * 97) % 1000, w: 100, h: 80 },
        builtOf(source([ngon(130, 480)]), { x: 0, y: 0, w: 100, h: 80 }),
        { fill: colour(i % 255, 90, 60) },
      ),
    );
    const file = join(scratch, 'd2.json');
    writeFileSync(file, JSON.stringify(recipeWire(run, members)));
    const work = join(scratch, 'd2work');
    const controller = new AbortController();
    const b = await RasterBrowser.launch(exe!, work, { signal: new AbortController().signal });
    const pgid = b.pid!;
    expect(groupAlive(pgid)).toBe(true);
    const drawing = b.draw(file, [], { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const r = await drawing;
    // either the abort won, or the picture was already done: both leave a browser to close
    expect(['aborted', undefined]).toContain(r.ok ? undefined : r.reason);
    await b.close();
    const t0 = Date.now();
    while (groupAlive(pgid) && Date.now() - t0 < 5000) await new Promise((res) => setTimeout(res, 50));
    expect(groupAlive(pgid)).toBe(false);
    expect(readdirSync(work).filter((n) => n.startsWith('profile-'))).toEqual([]);
  }, 60_000);

  it('RM-D7: a hostile recipe is refused before any process starts', async () => {
    let spawned = 0;
    const spy = ((...a: Parameters<typeof spawn>) => {
      spawned++;
      return spawn(...a);
    }) as typeof spawn;
    const hostile = {
      v: 1,
      w: 20,
      h: 20,
      box: { x: 0, y: 0, w: 10, h: 10 },
      density: 2,
      members: [
        {
          shape: { type: 'shape', box: { x: 0, y: 0, w: 1, h: 1 } },
          geom: {
            paths: [{ cmds: Buffer.from([0, 9]).toString('base64'), pts: '', fill: 'norm', stroke: true }],
          },
        },
      ],
    };
    const out = await drawRasters(
      {
        jobs: {},
        launch: (dir, signal) =>
          RasterBrowser.launch(exe!, dir, { signal, spawnFn: spy }) as Promise<RasterSession>,
      },
      [{ hash: 'bad00000', recipe: hostile as never }],
      {
        workDir: scratch,
        signal: new AbortController().signal,
        fonts: async () => [],
        accept: async () => ({ ok: true }),
      },
    );
    expect(out.failed.get('bad00000')).toBe('recipe');
    expect(spawned).toBe(0);
    // and renderRecipe refuses it too, without touching the session
    const session: RasterSession = {
      draw: () => Promise.reject(new Error('must not be asked')),
      close: async () => undefined,
    };
    const r = await renderRecipe({ jobs: {} }, session, hostile as never, { workDir: scratch, fonts: [] });
    expect(r).toMatchObject({ ok: false, reason: 'recipe' satisfies RasterReason });
  });
});

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium } from '../../../tools/find-chromium.ts';
import type { ScenarioName } from './bake.page.test-util.ts';

/**
 * The bake in headless Chromium (bake-render, sub-wave 3): bundles bake.page.test-util.ts and runs its scenarios on
 * software canvases with faces built in memory. T1 exactness, T2 the live whole draw, T3 only registered faces,
 * T4 the aborts (complete or nothing), T5 one picture at a time, T6 the slide's own picture, T7 the live set,
 * T8 no cache across bakes, and the encoders (E1 to E8). Chromium is tools/find-chromium.ts's: skipped when none
 * is found, and a failure under CI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

type Esbuild = { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };

async function loadEsbuild(): Promise<Esbuild> {
  const name = 'esbuild';
  try {
    return (await import(name)) as Esbuild;
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    return (await import(createRequire(fromOutput.resolve('vite')).resolve(name))) as Esbuild;
  }
}

const executablePath = await findChromium();

type Diff = { maxDiff: number; over1: number; over2: number; painted: number; pixels: number };
type Aborted = {
  ok: boolean;
  reason?: string;
  detail?: string;
  text?: string;
  standIns?: string[];
  leftovers: { inProgress: number; workBytes: number; cacheBytes: number };
  held: number;
  acquired: number;
};
type Head = { format: string; width: number; height: number; alpha: boolean; colorType?: number } | undefined;
type Pic = { size: number; type: string; bytes: number; head: Head; mime: string };

describe.skipIf(!executablePath)('the bake in headless Chromium', () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'bake.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: built.outputFiles[0]!.text });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  const run = <T>(name: ScenarioName, args?: unknown): Promise<T> =>
    page.evaluate(
      ([n, a]) =>
        (window as unknown as { __bake: (n: string, a?: unknown) => Promise<unknown> }).__bake(
          n as string,
          a,
        ),
      [name, args] as const,
    ) as Promise<T>;

  describe('T1 exactness: the picture is the objects drawn one after the other', () => {
    for (const [subject, scale] of [
      ['p1', 1],
      ['p3', 1],
      ['p4', 1],
      ['p5', 1],
      ['p1', 2],
      ['p3', 2],
    ] as const)
      it(`${subject} at scale ${scale}: 0 levels`, async () => {
        const r = await run<{ ok: boolean; reason?: string; detail?: string } & Diff>('exactness', {
          subject,
          scale,
        });
        expect(r.ok, `${r.reason} ${r.detail}`).toBe(true);
        expect(r.painted, 'the picture paints something').toBeGreaterThan(1000);
        expect(r.maxDiff).toBe(0);
      }, 240_000);

    for (const scale of [1, 2] as const)
      it(`p2 (units inside) at scale ${scale}: under 0.05 % of the pixels over 2 levels`, async () => {
        const r = await run<{ ok: boolean } & Diff>('exactness', { subject: 'p2', scale });
        expect(r.ok).toBe(true);
        expect(r.painted).toBeGreaterThan(1000);
        console.log(`bake p2 at scale ${scale}: max diff ${r.maxDiff}, ${r.over2} px over 2 of ${r.pixels}`);
        expect(r.over2 / r.pixels).toBeLessThan(0.0005);
      }, 240_000);
  });

  describe('T2 and T6: against the production live whole draw', () => {
    for (const [subject, scale] of [
      ['p1', 1],
      ['p1', 2],
      ['p3', 1],
      ['p4', 1],
    ] as const)
      it(`${subject} at scale ${scale}`, async () => {
        const r = await run<{ ok: boolean; split?: boolean } & Diff>('liveWhole', { subject, scale });
        expect(r.ok).toBe(true);
        console.log(
          `bake ${subject} at ${scale}: against the live whole draw max diff ${r.maxDiff}, ${r.over1} px over 1, ${r.over2} px over 2 (frame ${r.split ? 'split' : 'not split'})`,
        );
        expect(r.maxDiff).toBe(0);
      }, 240_000);
  });

  it('T3 only registered faces: every font string names an internal face or the blank face, inside the key chain', async () => {
    const r = await run<{
      ok: boolean;
      reason?: string;
      detail?: string;
      strings: number;
      stray: string[];
      libraryFamilies: string[];
      chainKeys: string[];
      reportChain: string[];
      liveFamilies: string[];
    }>('onlyRegistered');
    expect(r.ok, `${r.reason} ${r.detail}`).toBe(true);
    expect(r.strings, 'the recording saw text').toBeGreaterThan(3);
    expect(r.stray, 'a family that is neither an internal face nor the blank face').toEqual([]);
    expect(r.libraryFamilies.length).toBeGreaterThan(1);
    for (const f of r.libraryFamilies) expect(r.chainKeys, `the key chain lists ${f}`).toContain(f);
    for (const f of r.reportChain)
      expect(r.chainKeys, `the key chain lists ${f} (looked at by a font string)`).toContain(f);
    // the control: the live profile puts the legacy chain in a font string, which the recording sees
    expect(r.liveFamilies).toContain('Segoe UI');
  }, 240_000);

  describe('T4 complete or nothing: each abort leaves nothing behind', () => {
    const cases: [string, string, RegExp?][] = [
      ['coverage-plain', 'coverage', /€/],
      ['coverage-shadow-glow', 'coverage', /€/],
      ['coverage-table', 'coverage', /€/],
      ['coverage-gradient', 'coverage', /€/],
      ['font-failed', 'font', /acme/],
      ['font-empty', 'font', /acme/],
      ['standin-abort', 'font', /garamond/],
      ['media', 'media', /photo2/],
      ['files', 'files'],
      ['draw', 'draw', /pic1/],
      ['cut', 'cut', /20001/],
      ['animated-play', 'animated', /vid/],
      ['animated-hidden', 'animated', /hidden/],
      ['cancelled', 'cancelled'],
      ['time', 'time'],
      ['fonts', 'fonts'],
      ['blank', 'blank'],
      ['frame', 'frame'],
    ];
    for (const [name, reason, detail] of cases)
      it(`${name}: ${reason}`, async () => {
        const r = await run<Aborted>('abort', { name });
        expect(r.ok, `${name} must not make a picture`).toBe(false);
        expect(r.reason).toBe(reason);
        if (detail) expect(r.detail).toMatch(detail);
        expect(r.text!.length).toBeLessThanOrEqual(200);
        expect(r.leftovers, 'no frame in progress, no work bytes, no unit-cache entry').toEqual({
          inProgress: 0,
          workBytes: 0,
          cacheBytes: 0,
        });
        expect(r.held, 'every picture held was released').toBe(0);
      }, 120_000);

    it('a family with no face of its own is drawn in the default face and listed (Q31.c, the default)', async () => {
      const r = await run<Aborted>('abort', { name: 'standin' });
      expect(r.ok).toBe(true);
      expect(r.standIns).toEqual(['garamond']);
    }, 120_000);

    it('an animated object whose id is in the live set is allowed (the Q24.a hook)', async () => {
      const r = await run<Aborted>('abort', { name: 'animated-live' });
      expect(r.ok).toBe(true);
    }, 120_000);

    it('the stand-in list is complete when the same slide is baked again (layouts are not cached across bakes)', async () => {
      const r = await run<{ first: string[]; second: string[] }>('reportAfterCache');
      expect(r.first).toEqual(['garamond']);
      expect(r.second).toEqual(['garamond']);
    }, 120_000);

    it('profile: a live or legacy font environment is refused before anything is drawn', async () => {
      const r = await run<Record<string, Aborted>>('profileRefusal');
      for (const k of ['legacy', 'live']) {
        expect(r[k]!.ok).toBe(false);
        expect(r[k]!.reason).toBe('profile');
        expect(r[k]!.acquired, 'nothing was drawn').toBe(0);
        expect(r[k]!.leftovers.cacheBytes).toBe(0);
      }
    }, 120_000);

    it('busy: a second concurrent call is refused and the first is not disturbed', async () => {
      const r = await run<{ first: Aborted; second: Aborted; after: boolean }>('busy');
      expect(r.first.ok).toBe(true);
      expect(r.second.ok).toBe(false);
      expect(r.second.reason).toBe('busy');
      expect(r.after, 'a bake after them is fine').toBe(true);
    }, 120_000);
  });

  it('T5 one picture at a time: a 300-picture slide never holds more than one', async () => {
    const r = await run<{ ok: boolean; maxHeld: number; acquired: number; held: number }>('oneAtATime');
    expect(r.ok).toBe(true);
    expect(r.acquired).toBeGreaterThanOrEqual(300);
    expect(r.maxHeld).toBeLessThanOrEqual(1);
    expect(r.held).toBe(0);
  }, 240_000);

  it('T7 the live set: a bake without objects is pixel-equal to a bake of the slide without them', async () => {
    const r = await run<{
      ok: boolean;
      maxDiff: number;
      drawn: number;
      under: number;
      recordMaxDiff: number;
    }>('liveSet');
    expect(r.ok).toBe(true);
    expect(r.maxDiff).toBe(0);
    expect(r.under).toBe(r.drawn);
    expect(r.recordMaxDiff, "the raw slide's record is the default").toBe(0);
  }, 240_000);

  it('T8 no cache across bakes: the frame is made twice for two bakes and the two pictures are equal', async () => {
    const r = await run<{ ok: boolean; made: number; cacheAfterFirst: number; maxDiff: number }>('noCache');
    expect(r.ok).toBe(true);
    expect(r.made).toBe(2);
    expect(r.cacheAfterFirst).toBe(0);
    expect(r.maxDiff).toBe(0);
  }, 240_000);

  it("E8 the slide's own background is not baked: the picture and the key ignore backgroundMediaId", async () => {
    const r = await run<{ same: boolean; opaque: boolean[]; sameKey: boolean }>('ownBackground');
    expect(r.same).toBe(true);
    expect(new Set(r.opaque).size).toBe(1);
    expect(r.sameKey).toBe(true);
  }, 240_000);

  describe('encoders', () => {
    type Encoded = {
      ok: boolean;
      reason?: string;
      detail?: string;
      opaque: boolean;
      madeOpaque: boolean;
      pics: (Pic & { riff: string; webpFlags?: number; png?: number })[];
      hygiene: number[];
    };

    it('E1 sizes and types: 1920, 3840, 640 in upload order, exact dimensions', async () => {
      const r = await run<Encoded>('encode', { subject: 'p1' });
      expect(r.ok, `${r.reason} ${r.detail}`).toBe(true);
      expect(r.pics.map((p) => p.size)).toEqual([1920, 3840, 640]);
      expect(r.pics.map((p) => p.type)).toEqual(['image/png', 'image/png', 'image/webp']);
      expect(r.pics.map((p) => `${p.head?.width}x${p.head?.height}`)).toEqual([
        '1920x1080',
        '3840x2160',
        '640x360',
      ]);
      expect(r.pics.map((p) => p.head?.format)).toEqual(['png', 'png', 'webp']);
      expect(r.pics[2]!.riff).toBe('WEBP');
      for (const p of r.pics) expect(p.bytes).toBeGreaterThan(100);
      console.log(`bytes of p1: ${r.pics.map((p) => `${p.size} ${p.bytes}`).join(', ')}`);
    }, 300_000);

    it('E2 an opaque slide is an RGB PNG (colour type 2) and says opaque; one with transparency is RGBA (6)', async () => {
      const o = await run<Encoded>('encode', { subject: 'opaque' });
      expect(o.ok, `${o.reason} ${o.detail}`).toBe(true);
      expect(o.madeOpaque).toBe(true);
      expect(o.opaque).toBe(true);
      expect(o.pics.filter((p) => p.type === 'image/png').map((p) => p.head?.colorType)).toEqual([2, 2]);
      expect(o.pics[2]!.head?.alpha).toBe(false);
      const t = await run<Encoded>('encode', { subject: 'translucent', translucent: true });
      expect(t.ok, `${t.reason} ${t.detail}`).toBe(true);
      expect(t.madeOpaque).toBe(false);
      expect(t.opaque).toBe(false);
      expect(t.pics.filter((p) => p.type === 'image/png').map((p) => p.head?.colorType)).toEqual([6, 6]);
      expect(t.pics[2]!.head?.alpha, 'the WebP carries alpha too').toBe(true);
    }, 300_000);

    it('E3 the 1920 copy against a live 1080p draw: mean SSIM over the text boxes at least 0.99', async () => {
      const r = await run<{ ok: boolean; mean: number; scores: number[] }>('copySsim');
      expect(r.ok).toBe(true);
      console.log(
        `1920 copy SSIM over the text boxes: ${r.scores.map((x) => x.toFixed(4)).join(', ')} (mean ${r.mean.toFixed(4)})`,
      );
      expect(r.mean).toBeGreaterThanOrEqual(0.99);
    }, 300_000);

    it('E4 the round trip passes a fresh picture and fails a truncated one, a foreign one and a changed row', async () => {
      const r = await run<{
        fresh: { ok: boolean; tiles?: number };
        truncated: { ok: boolean };
        foreign: { ok: boolean };
        changedRow: { ok: boolean };
        tiles: number;
      }>('roundTrip');
      expect(r.fresh.ok).toBe(true);
      expect(r.tiles).toBe(64);
      expect(r.truncated.ok).toBe(false);
      expect(r.foreign.ok).toBe(false);
      expect(r.changedRow.ok).toBe(false);
    }, 300_000);

    it('E5 a picture over the bound is `size`', async () => {
      const r = await run<Encoded>('encode', { subject: 'p5', maxBytes: 1000 });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('size');
      expect(r.detail).toMatch(/3840 PNG/);
      expect(r.hygiene.every((w) => w === 0)).toBe(true);
    }, 300_000);

    it('E6 determinism (G17): two bakes in one browser give identical bytes for all three pictures', async () => {
      const r = await run<Record<string, number[][]>>('determinism');
      for (const [name, runs] of Object.entries(r)) expect(runs[0], name).toEqual(runs[1]);
    }, 600_000);

    it('E7 hygiene: every canvas the encoder made is zeroed, and the decoded bitmap is closed', async () => {
      const r = await run<Encoded>('encode', { subject: 'p5' });
      expect(r.ok).toBe(true);
      expect(r.hygiene.length).toBeGreaterThanOrEqual(3);
      expect(r.hygiene.every((w) => w === 0)).toBe(true);
      const b = await run<{ ok: boolean; decoded: number; closed: number }>('bitmapClosed');
      expect(b.ok).toBe(true);
      expect(b.decoded).toBeGreaterThanOrEqual(1);
      expect(b.closed).toBe(b.decoded);
    }, 300_000);
  });

  it("bakeSlides: the picture-only slide and the frame's objects cut into slides of the live counts", async () => {
    const r = await run<{ objects: number; under: number[] }>('prepareSlides');
    expect(r.objects).toBe(0);
    expect(r.under.reduce((a, b) => a + b, 0)).toBe(310);
    expect(Math.max(...r.under)).toBeLessThanOrEqual(200);
  });

  it('threw nothing in the page', () => {
    expect(errors).toEqual([]);
  });
});

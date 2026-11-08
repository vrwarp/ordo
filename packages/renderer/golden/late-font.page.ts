import { LOOK_MAIN, type Slide, type TextObject } from '@ordo/domain';
import { rasterSlide } from '../src/raster.ts';
import { layoutText } from '../src/text2d.ts';
import { FontResolver, currentFontEnv, installFontEnv } from '../src/text/fonts.ts';
import { measurerFor } from '../src/text/measure.ts';
import { clampTextObject, layoutRich } from '../src/text/rich.ts';

/**
 * Browser side of the late-font check (design/27 §10, M2 exit "a late-loaded font takes effect without a
 * worker restart"). The same script runs in a dedicated worker (the asset and thumbnail workers) and on the
 * page (the editor). In each it installs a FontResolver over the context's face set, draws a slide whose
 * text uses families that have not loaded yet, lets them load (one after a failed first read and a retry,
 * one listed by a later sync, as a font added during a service), draws again, and compares widths and
 * pixels with the same face registered directly under a name never resolved before.
 */

const W = 960;
const H = 540;
const SCALE = W / 1920;
const SAMPLE = 'Amazing grace, how sweet the sound';

export type Measured = { legacy: number; rich: number; pixels: Uint8ClampedArray };
export type Scenario = {
  name: string;
  before: { legacy: number; rich: number };
  after: { legacy: number; rich: number };
  reference: { legacy: number; rich: number };
  /** Pixels over 8/255 between before and after, and between after and the reference. */
  changed: number;
  offReference: number;
  maxDeltaToReference: number;
};
export type Report = {
  context: 'worker' | 'page';
  /** The probe that motivates internal names: does a family measured before its face was added change? */
  naive: { fallback: number; afterAdd: number; fresh: number };
  scenarios: Scenario[];
  generation: number;
  log: string[];
};

function bytesOf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function textObjects(family: string): TextObject[] {
  const style = {
    fontFamily: family,
    fontWeight: 400,
    fontStyle: 'normal' as const,
    fontSizePx: 64,
    color: { r: 255, g: 255, b: 255, a: 1 },
    align: 'left' as const,
    valign: 'top' as const,
    lineHeight: 1.2,
    letterSpacing: 0,
    padding: 0,
    transform: 'none' as const,
  };
  return [
    {
      id: 'legacy',
      type: 'text',
      box: { x: 80, y: 80, w: 1760, h: 300, rotation: 0 },
      text: SAMPLE,
      style,
      opacity: 1,
    },
    {
      id: 'rich',
      type: 'text',
      box: { x: 80, y: 500, w: 1760, h: 300, rotation: 0 },
      text: SAMPLE,
      style: { ...style, lineModel: 'office' },
      opacity: 1,
      runs: [{ start: 0, end: 7, color: { r: 255, g: 200, b: 0, a: 1 } }],
    },
  ];
}

function measure(family: string): Measured {
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const [legacy, rich] = textObjects(family) as [TextObject, TextObject];
  const slide: Slide = { id: `s-${family}`, objects: [legacy, rich] };
  rasterSlide(ctx, slide, LOOK_MAIN, SCALE, () => undefined);
  const pixels = ctx.getImageData(0, 0, W, H).data;
  // Widths in logical px: the legacy layout at scale 1, the rich layout as the engine lays it out.
  const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
  const l = layoutText(probe, legacy.text, legacy.style, legacy.box, 1);
  const r = layoutRich(measurerFor(probe), clampTextObject(rich), currentFontEnv());
  return { legacy: l.lines[0]!.width, rich: r.lines[0]!.w, pixels };
}

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): { over: number; max: number } {
  let over = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[i + k]! - b[i + k]!));
    if (d > max) max = d;
    if (d > 8) over++;
  }
  return { over, max };
}

const widths = (m: Measured) => ({ legacy: m.legacy, rich: m.rich });

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

export async function check(set: FontFaceSet, context: Report['context'], b64: string): Promise<Report> {
  const log: string[] = [];
  const font = bytesOf(b64);
  const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
  const width = (f: string) => {
    probe.font = f;
    return probe.measureText(SAMPLE).width;
  };

  // The probe: a family string measured before its face is added, and a family never resolved before.
  const fallback = width('40px "Naive Probe", sans-serif');
  const naiveFace = new FontFace('Naive Probe', font.slice(0));
  await naiveFace.load();
  set.add(naiveFace);
  const afterAdd = width('40px "Naive Probe", sans-serif');
  const freshFace = new FontFace('Fresh Probe', font.slice(0));
  await freshFace.load();
  set.add(freshFace);
  const fresh = width('40px "Fresh Probe", sans-serif');

  // The reference: the face under its own never-resolved family name, registered before any draw.
  const refFace = new FontFace('Reference Face', font.slice(0));
  await refFace.load();
  set.add(refFace);

  // A resolver whose first read of 'late' fails (an output whose cache fill had not finished).
  let reads = 0;
  const resolver = new FontResolver({
    set,
    data: async (f) => {
      if (f.hash === 'late' && reads++ === 0) throw new Error('file unavailable');
      return font.slice(0);
    },
    retry: { firstMs: 100, maxMs: 400 },
  });
  installFontEnv(resolver);
  let late = 0;
  resolver.onChange((c) => {
    log.push(`change ${c.families.join(',')} late=${c.late} generation=${resolver.generation}`);
    if (c.late) late++;
  });
  const reference = measure('Reference Face');

  const first = await resolver.sync([{ family: 'Late Sans', weight: 400, style: 'normal', hash: 'late' }]);
  log.push(`first sync: loaded ${first.loaded}, failed ${first.failed.join('; ')}`);
  const scenarios: Scenario[] = [];
  const scenario = (name: string, before: Measured, after: Measured): Scenario => {
    const changed = diff(before.pixels, after.pixels);
    const ref = diff(after.pixels, reference.pixels);
    return {
      name,
      before: widths(before),
      after: widths(after),
      reference: widths(reference),
      changed: changed.over,
      offReference: ref.over,
      maxDeltaToReference: ref.max,
    };
  };

  // 1. Drawn while the face is missing, loaded by the retry, drawn again.
  const lateBefore = measure('Late Sans');
  if (!(await waitFor(() => late > 0, 5000))) log.push('the retry never loaded the face');
  scenarios.push(scenario('retried after a failed read', lateBefore, measure('Late Sans')));

  // 2. Drawn before the drawer was told about the family (a font added during the service).
  const addedBefore = measure('Added Sans');
  const second = await resolver.sync([
    { family: 'Late Sans', weight: 400, style: 'normal', hash: 'late' },
    { family: 'Added Sans', weight: 400, style: 'normal', hash: 'added' },
  ]);
  log.push(`second sync: loaded ${second.loaded}, ready ${second.ready.join(',')}`);
  scenarios.push(scenario('added by a later sync', addedBefore, measure('Added Sans')));

  resolver.dispose();
  return { context, naive: { fallback, afterAdd, fresh }, scenarios, generation: resolver.generation, log };
}

declare const WorkerGlobalScope: unknown;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined';

if (inWorker) {
  const scope = self as unknown as { fonts: FontFaceSet; onmessage: unknown; postMessage(m: unknown): void };
  scope.onmessage = async (e: MessageEvent<{ font: string }>) => {
    try {
      scope.postMessage({ ok: true, report: await check(scope.fonts, 'worker', e.data.font) });
    } catch (err) {
      scope.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  };
} else {
  (window as unknown as { __lateFont: unknown }).__lateFont = {
    page: (font: string) => check(document.fonts, 'page', font),
    worker: (source: string, font: string) =>
      new Promise<Report>((resolve, reject) => {
        const w = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        w.onmessage = (e: MessageEvent<{ ok: boolean; report?: Report; error?: string }>) => {
          w.terminate();
          if (e.data.ok) resolve(e.data.report!);
          else reject(new Error(e.data.error));
        };
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage({ font });
      }),
  };
}

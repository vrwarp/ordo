import { DEFAULT_LYRIC_STYLE, LOOK_MAIN, type Slide, type TextStyle } from '@ordo/domain';
import { rasterSlide } from '../raster.ts';
import { GlyphCoverage, contextMetrics } from './coverage.ts';
import { FontResolver, installFontEnv } from './fonts.ts';

/**
 * Browser side of coverage.browser.test.ts: in a dedicated worker, as the outputs' asset worker does, with
 * the font resolver installed and one face (DejaVu Sans) registered as the family 'Bench'. Slides are drawn
 * with `rasterSlide` on an instrumented, CPU-backed canvas, legacy and rich text, and the characters no face
 * covers are read back, as the asset worker reports them.
 */

export type CoverageCase = { name: string; uncovered: string; expected: string };
export type CoverageReport = { cases: CoverageCase[]; reprobedAfterReset: boolean };

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const style = (family: string, rich: boolean): TextStyle => ({
  ...DEFAULT_LYRIC_STYLE,
  fontFamily: family,
  fontSizePx: 64,
  color: WHITE,
  ...(rich ? { lineModel: 'office' as const } : {}),
});

function slide(text: string, family: string, rich: boolean): Slide {
  return {
    id: 's',
    objects: [
      {
        id: 't',
        type: 'text',
        box: { x: 100, y: 100, w: 1700, h: 800, rotation: 0 },
        text,
        style: style(family, rich),
        opacity: 1,
        ...(rich ? { runs: [{ start: 0, end: 2, fontWeight: 700 }] } : {}),
      },
    ],
  };
}

// DejaVu Sans has Latin, Greek, Cyrillic, Hebrew and the Chi Rho (U+2627), not Han, Thai or the dove (U+1F54A).
const TEXT = 'Grace אמן Ж ☧ 中文 ก 🕊';
const NOT_IN_DEJAVU = '中文ก🕊';
const sorted = (s: string) =>
  String.fromCodePoint(...[...s].map((c) => c.codePointAt(0)!).sort((a, b) => a - b));

export async function run(set: FontFaceSet, font: ArrayBuffer): Promise<CoverageReport> {
  const resolver = new FontResolver({ set, data: async () => font.slice(0) });
  await resolver.sync([
    { family: 'Bench', weight: 400, style: 'normal', hash: 'regular' },
    { family: 'Bench', weight: 700, style: 'normal', hash: 'regular' },
  ]);
  installFontEnv(resolver);
  const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
  const coverage = new GlyphCoverage(contextMetrics(probe));
  const canvas = new OffscreenCanvas(960, 540);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  coverage.instrument(ctx);
  const draw = (s: Slide) => {
    coverage.begin();
    ctx.clearRect(0, 0, 960, 540);
    rasterSlide(ctx, s, LOOK_MAIN, 0.5, () => undefined, { isSong: false });
    canvas.transferToImageBitmap().close();
    return coverage.misses(coverage.end());
  };
  const cases: CoverageCase[] = [
    {
      name: 'legacy text in a loaded family',
      uncovered: draw(slide(TEXT, 'Bench', false)),
      expected: sorted(NOT_IN_DEJAVU),
    },
    {
      name: 'rich text in a loaded family',
      uncovered: draw(slide(TEXT, 'Bench', true)),
      expected: sorted(NOT_IN_DEJAVU),
    },
    {
      name: 'text the face covers',
      uncovered: draw(slide('Amazing grace ☧ אמן', 'Bench', true)),
      expected: '',
    },
    // A family that is not loaded is reported as a font fallback, not glyph by glyph.
    {
      name: 'a family that is not loaded',
      uncovered: draw(slide(TEXT, 'Not Installed', false)),
      expected: '',
    },
  ];
  coverage.reset();
  const again = draw(slide('中', 'Bench', false));
  resolver.dispose();
  return { cases, reprobedAfterReset: again === '中' };
}

declare const WorkerGlobalScope: unknown;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined';

if (inWorker) {
  const scope = self as unknown as { fonts: FontFaceSet; onmessage: unknown; postMessage(m: unknown): void };
  scope.onmessage = async (e: MessageEvent<{ font: ArrayBuffer }>) => {
    try {
      scope.postMessage({ ok: true, report: await run(scope.fonts, e.data.font) });
    } catch (err) {
      scope.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  };
} else {
  (window as unknown as { __coverage: unknown }).__coverage = (source: string, font64: string) =>
    new Promise<CoverageReport>((resolve, reject) => {
      const bin = atob(font64);
      const font = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) font[i] = bin.charCodeAt(i);
      const w = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      w.onmessage = (e: MessageEvent<{ ok: boolean; report?: CoverageReport; error?: string }>) => {
        w.terminate();
        if (e.data.ok) resolve(e.data.report!);
        else reject(new Error(e.data.error));
      };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ font: font.buffer }, [font.buffer]);
    });
}

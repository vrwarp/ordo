import { registerBlankFace } from './blankface.ts';
import { GlyphCoverage, contextMetrics } from './coverage.ts';
import { FontResolver } from './fonts.ts';

/**
 * Browser side of coverage.fonts.browser.test.ts: the probe's own checks in a dedicated worker, as the
 * outputs' asset worker runs it, with one face (DejaVu Sans) loaded as the family 'Bench'. Characters are
 * noted as the instrumented surface notes them (`GlyphCoverage.note`) and read back with `misses`. Beside
 * the verdicts it reports what the computer's fonts answer, so the test can say which environment it ran in.
 */

export type ProbeCase = { name: string; uncovered: string; expected: string };
export type ProbeChecks = {
  /** The blank face loaded in this worker's face set. */
  blankLoaded: boolean;
  /** Metrics of characters in the blank face alone (all zero: no advance, no ink). */
  blankAlone: number[][];
  /** Metrics of a character in each of the test's generated faces (zero width where the face is absent). */
  named: Record<string, number[]>;
  /** Metrics of 中, 文 and ก in the generic serif (the same .notdef box three times where no face has them). */
  serif: number[][];
  /** The probe of a coverage whose blank face had not loaded yet, and of the same text once it had. */
  beforeReady: string;
  afterReady: string;
  cases: ProbeCase[];
};

const sorted = (s: string) =>
  String.fromCodePoint(...[...new Set([...s].map((c) => c.codePointAt(0)!))].sort((a, b) => a - b));

/** Characters DejaVu Sans lacks: Han, Thai (a letter and a mark), Hangul, Devanagari and two emoji. */
export const MISSING = '中文กั한क🕊🚀';
/** Faces the test generates for the CJK/Thai environment. */
export const PROBE_FAMILIES = ['Ordo Probe Serif', 'Ordo Probe Sans', 'Ordo Probe Mono'];

export async function checks(set: FontFaceSet, font: ArrayBuffer): Promise<ProbeChecks> {
  const resolver = new FontResolver({ set, data: async () => font.slice(0) });
  await resolver.sync([
    { family: 'Bench', weight: 400, style: 'normal', hash: 'regular' },
    { family: 'Bench', weight: 700, style: 'normal', hash: 'regular' },
  ]);
  const bench = `"${resolver.nameOf('Bench')}"`;
  const stack = `${bench}, "Inter", "Segoe UI", Arial, sans-serif`;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
  const metrics = contextMetrics(ctx);

  // Registered and probed at once: its load has not settled, so there is no verdict and no report.
  const early = registerBlankFace(set);
  const first = new GlyphCoverage(metrics, early);
  first.begin();
  first.note(`700 48px ${stack}`, 'A中');
  const firstDrawn = first.end();
  const beforeReady = first.misses(firstDrawn);
  const blankLoaded = await early.loaded;
  const afterReady = first.misses(firstDrawn);

  const blank = registerBlankFace(set);
  await blank.loaded;
  const probe = new GlyphCoverage(metrics, blank);
  const read = (font: string, text: string) => {
    probe.begin();
    probe.note(font, text);
    return probe.misses(probe.end());
  };
  const cases: ProbeCase[] = [
    {
      name: 'covered characters: Latin, Cyrillic, Hebrew, Arabic, symbols and a combining mark of no advance',
      uncovered: read(`700 48px ${stack}`, 'Grace Ж אמן ب ☧ © é'),
      expected: '',
    },
    {
      name: 'missing characters: Han, Thai, Hangul, Devanagari and emoji',
      uncovered: read(`700 48px ${stack}`, `Grace ${MISSING}`),
      expected: sorted(MISSING),
    },
    {
      name: 'the same, regular, italic and bold italic',
      uncovered: [`48px ${stack}`, `italic 48px ${stack}`, `italic bold 48px ${stack}`]
        .map((f) => read(f, `a${MISSING}`))
        .join('|'),
      expected: [sorted(MISSING), sorted(MISSING), sorted(MISSING)].join('|'),
    },
    {
      name: 'default-ignorable and zero-width characters HarfBuzz hides are never reported',
      uncovered: read(`700 48px ${stack}`, '­͏᠋​‌‍⁠⁤️\u{E0041}\u{E0100}\u{1D173}'),
      expected: '',
    },
    {
      name: 'default-ignorables a browser draws are reported when no face has them',
      uncovered: read(`700 48px ${stack}`, 'ᅟᅠㅤﾠ\u{1BCA0}'),
      expected: sorted('ᅟᅠㅤﾠ\u{1BCA0}'),
    },
    {
      name: 'mixed text: only what no face has',
      uncovered: read(`700 48px ${stack}`, 'Gra中ce͏ ☧ ก'),
      expected: 'ก中',
    },
  ];

  const m = (f: string, t: string) => Array.from(metrics(f, t));
  const blankAlone = ['A', '中', 'ก', 'ั', '🕊', '́', '\u{10FFFD}'].map((c) =>
    m(`700 100px ${blank.family}`, c),
  );
  const named: Record<string, number[]> = {};
  for (const f of PROBE_FAMILIES) named[f] = m(`100px "${f}", ${blank.family}`, '中');
  const serif = ['中', '文', 'ก'].map((c) => m('100px serif', c));
  resolver.dispose();
  return { blankLoaded, blankAlone, named, serif, beforeReady, afterReady, cases };
}

declare const WorkerGlobalScope: unknown;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof window === 'undefined';

if (inWorker) {
  const scope = self as unknown as { fonts: FontFaceSet; onmessage: unknown; postMessage(m: unknown): void };
  scope.onmessage = async (e: MessageEvent<{ font: ArrayBuffer }>) => {
    try {
      scope.postMessage({ ok: true, report: await checks(scope.fonts, e.data.font) });
    } catch (err) {
      scope.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  };
} else if (typeof window !== 'undefined') {
  // On the page (the test's node side imports the constants above and nothing else).
  (window as unknown as { __probeChecks: unknown }).__probeChecks = (source: string, font64: string) =>
    new Promise<ProbeChecks>((resolve, reject) => {
      const bin = atob(font64);
      const font = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) font[i] = bin.charCodeAt(i);
      const w = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      w.onmessage = (e: MessageEvent<{ ok: boolean; report?: ProbeChecks; error?: string }>) => {
        w.terminate();
        if (e.data.ok) resolve(e.data.report!);
        else reject(new Error(e.data.error));
      };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ font: font.buffer }, [font.buffer]);
    });
}

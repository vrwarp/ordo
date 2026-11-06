/**
 * `--baseline`: the change per deck against an earlier `summary.json` or `native-baseline.json`, like for
 * like. Native scores are compared as ordo draws the slides (a `--lo-compat` run's policy drawings, any
 * other run's pictures), so a run drawn as LibreOffice would never passes a policy gain for progress, nor
 * hides a loss behind one. With `--slides`, both sides are means over the slides the run scored.
 */
import { mean } from './report.ts';

type SlideScores = { n: number; nativeSsim?: number; policySsim?: number; ssim?: number };

/** A deck as a baseline file or the current run has it. */
export type BaselineDeck = {
  name: string;
  ssim?: number;
  nativeSsim?: number;
  /** `--lo-compat` runs: the native mean as ordo draws the slides. */
  nativePolicySsim?: number;
  perSlide?: readonly SlideScores[];
};

/** Mean of `pick` over the deck's slides in `slides`, or undefined when none of them has a score. */
function over(
  d: BaselineDeck,
  slides: ReadonlySet<number>,
  pick: (p: SlideScores) => number | undefined,
): number | undefined {
  const xs = (d.perSlide ?? []).flatMap((p) => {
    const v = slides.has(p.n) ? pick(p) : undefined;
    return v === undefined ? [] : [v];
  });
  return xs.length ? mean(xs) : undefined;
}

/** The deck's native score as ordo draws its slides, over `slides` when given. */
export function ordoScore(d: BaselineDeck, slides?: ReadonlySet<number>): number | undefined {
  if (!slides) return d.nativePolicySsim ?? d.nativeSsim;
  return over(d, slides, (p) => p.policySsim ?? p.nativeSsim);
}

/** The deck's pptx-preview score, over `slides` when given. */
export function ppvScore(d: BaselineDeck, slides?: ReadonlySet<number>): number | undefined {
  return slides ? over(d, slides, (p) => p.ssim) : d.ssim;
}

/**
 * One line per deck found in the baseline, and the decks whose native score dropped by more than
 * `maxDrop` among those `gated` says count.
 */
export function compareBaseline(
  scores: readonly BaselineDeck[],
  base: readonly BaselineDeck[],
  maxDrop: number,
  gated: (name: string) => boolean,
  slidesOf: (name: string) => ReadonlySet<number> | undefined = () => undefined,
): { lines: string[]; failed: string[] } {
  const fmt = (b: number, c: number) =>
    `${b.toFixed(3)} -> ${c.toFixed(3)} (${c >= b ? '+' : ''}${(c - b).toFixed(3)})`;
  const lines: string[] = [];
  const failed: string[] = [];
  for (const s of scores) {
    const b = base.find((d) => d.name === s.name);
    if (!b) continue;
    const slides = slidesOf(s.name);
    const parts: string[] = [];
    const bp = ppvScore(b, slides);
    const cp = ppvScore(s, slides);
    if (bp !== undefined && cp !== undefined) parts.push(`pptx-preview ${fmt(bp, cp)}`);
    const bn = ordoScore(b, slides);
    const cn = ordoScore(s, slides);
    if (bn !== undefined && cn !== undefined) {
      parts.push(`native ${fmt(bn, cn)}`);
      if (bn - cn > maxDrop && gated(s.name)) failed.push(s.name);
    }
    if (parts.length) lines.push(`${s.name.padEnd(40)} ${parts.join('  ')}`);
  }
  return { lines, failed };
}

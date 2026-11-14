/**
 * The golden-pptx census ratchet (design/23 "Fidelity ratchets"; CI's fidelity job): the census of every deck
 * of the committed public corpus (`golden-pptx/`, `census.ts`) against a committed baseline of each shown
 * slide's class, its class in the hub and its reasons (`golden-census-baseline.json`).
 *
 *   npx tsx src/census-ratchet.ts                   compare (exit 1 on a regression)
 *   npx tsx src/census-ratchet.ts --write           record the baseline from this checkout
 *   options: --corpus <dir> (default <repo>/golden-pptx), --baseline <file>, --out <census.jsonl> (default
 *   <repo>/test-results/census-golden.jsonl; the report goes next to it as census-ratchet.json)
 *
 * A regression fails the run: a slide whose class or hub class got worse (native < hybrid < picture), a shown
 * slide that is gone, a deck of the baseline that is missing from the corpus or that the converter can no
 * longer read, and (M9 leaf-legacy, baseline or not) a slide with a legacy fill over line art (`legacyFills`:
 * a filled legacy rect or ellipse over a built custom geometry that fills under half its box, the box every
 * drawer without a geometry unit would draw). Everything else is reported and passes: a better class (record
 * it with --write, so it cannot slip back), other reasons on the same class, another count of objects the slide
 * budget draws as their legacy shapes (`budgetLegacy`, version 2), a deck or slide the baseline does not have
 * yet. The census itself prints nothing of the decks; this report names decks and slide numbers only (the
 * corpus is public).
 *
 * Baseline version 2 adds each slide's `budgetLegacy` (0 when none) as a fifth entry; a version 1 baseline
 * (four entries a slide) still reads, without that comparison, and `--write` records version 2.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCensus } from './census.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

export type SlideClass = 'native' | 'hybrid' | 'picture';
/**
 * One shown slide in the baseline: its shown number, class, hub class and reasons (sorted), and since version 2
 * the objects the slide budget draws as their legacy shapes (`census.ts` `budgetLegacy`).
 */
export type BaselineSlide =
  | [n: number, cls: SlideClass, hub: SlideClass, reasons: string[]]
  | [n: number, cls: SlideClass, hub: SlideClass, reasons: string[], budgetLegacy: number];
export type Baseline = {
  version: 1 | 2;
  /** What the baseline was recorded from (for the reader; not compared). */
  note: string;
  decks: Record<string, BaselineSlide[]>;
};

/** A census line as `census.ts` writes it (the fields the ratchet reads). */
export type CensusLine = {
  name: string;
  error?: string;
  unreadable?: string;
  slides?: {
    n: number;
    class: SlideClass;
    hub: SlideClass;
    reasons: string[];
    budgetLegacy?: number;
    legacyFills?: number;
    unitsLeft?: number;
    unitsAlone?: number;
  }[];
};

const RANK: Record<SlideClass, number> = { native: 0, hybrid: 1, picture: 2 };
const rank = (c: string): number => RANK[c as SlideClass] ?? 3;

/** The baseline entries of one census line (version 2: slides in shown order, reasons sorted). */
export function baselineOf(line: CensusLine): BaselineSlide[] {
  return (line.slides ?? []).map((s) => [s.n, s.class, s.hub, [...s.reasons].sort(), s.budgetLegacy ?? 0]);
}

export type RatchetResult = {
  /** Regressions: each fails the run. */
  failures: string[];
  /** Better classes (record them with --write). */
  improved: string[];
  /** Other changes that pass: reasons on the same class, new decks or slides. */
  notes: string[];
  decks: number;
  slides: number;
};

/** Compare a census with the baseline. */
export function compareCensus(baseline: Baseline, census: readonly CensusLine[]): RatchetResult {
  const out: RatchetResult = { failures: [], improved: [], notes: [], decks: 0, slides: 0 };
  const now = new Map(census.map((l) => [l.name, l] as const));
  for (const [deck, want] of Object.entries(baseline.decks)) {
    const line = now.get(deck);
    if (!line || line.unreadable) {
      out.failures.push(`${deck}: missing from the corpus`);
      continue;
    }
    if (line.error) {
      out.failures.push(`${deck}: the converter cannot read it any more (${line.error.slice(0, 200)})`);
      continue;
    }
    out.decks++;
    const got = new Map(baselineOf(line).map((s) => [s[0], s] as const));
    for (const [n, cls, hub, reasons, legacy] of want) {
      const s = got.get(n);
      if (!s) {
        out.failures.push(`${deck} slide ${n}: no longer a shown slide`);
        continue;
      }
      out.slides++;
      const [, cls2, hub2, reasons2, legacy2] = s;
      if (rank(cls2) > rank(cls))
        out.failures.push(`${deck} slide ${n}: ${cls} -> ${cls2} (${reasons2.join(', ')})`);
      else if (rank(hub2) > rank(hub))
        out.failures.push(`${deck} slide ${n}: in the hub ${hub} -> ${hub2} (${reasons2.join(', ')})`);
      else if (rank(cls2) < rank(cls) || rank(hub2) < rank(hub))
        out.improved.push(`${deck} slide ${n}: ${cls}/${hub} -> ${cls2}/${hub2}`);
      else if (reasons2.join('\n') !== reasons.join('\n'))
        out.notes.push(
          `${deck} slide ${n}: reasons ${reasons.join(', ') || '-'} -> ${reasons2.join(', ') || '-'}`,
        );
      // Version 2: what the slide budget draws as legacy shapes (geometry units on outputs) is reported.
      if (legacy !== undefined && legacy2 !== legacy)
        out.notes.push(`${deck} slide ${n}: legacy shapes past the drawing budget ${legacy} -> ${legacy2}`);
      got.delete(n);
    }
    for (const n of got.keys()) out.notes.push(`${deck} slide ${n}: new shown slide (not in the baseline)`);
  }
  for (const line of census)
    if (!(line.name in baseline.decks)) out.notes.push(`${line.name}: new deck (not in the baseline)`);
  // A legacy fill over line art fails wherever it is, in the baseline or not; so does an object past the
  // drawing budget alone (no geometry unit: outputs draw its legacy shape, nothing for thin line art). Other
  // objects outputs draw as their legacy shapes are reported (effect-units gives them units).
  for (const line of census)
    for (const s of line.slides ?? []) {
      if (s.legacyFills)
        out.failures.push(
          `${line.name} slide ${s.n}: ${s.legacyFills} legacy fill(s) over custom geometry filling under half its box (a rect or ellipse where the legacy shape must be a line)`,
        );
      if (s.unitsAlone)
        out.failures.push(
          `${line.name} slide ${s.n}: ${s.unitsAlone} object(s) past the drawing budget alone, with no geometry unit (outputs draw the legacy shape)`,
        );
      else if (s.unitsLeft)
        out.notes.push(
          `${line.name} slide ${s.n}: ${s.unitsLeft} object(s) past the drawing budget outputs draw as legacy shapes (no unit until effect units)`,
        );
    }
  return out;
}

/** The baseline of a census (every readable deck). */
export function recordBaseline(census: readonly CensusLine[], note: string): Baseline {
  const decks: Record<string, BaselineSlide[]> = {};
  for (const line of [...census].sort((a, b) => a.name.localeCompare(b.name)))
    if (!line.error && !line.unreadable) decks[line.name] = baselineOf(line);
  return { version: 2, note, decks };
}

/** The baseline as JSON: one slide a line, so a change reads as a one-line diff. */
export function baselineJson(b: Baseline): string {
  const decks = Object.entries(b.decks).map(
    ([name, slides]) =>
      `    ${JSON.stringify(name)}: [${slides.length ? '\n' : ''}${slides.map((s) => `      ${JSON.stringify(s)}`).join(',\n')}${slides.length ? '\n    ' : ''}]`,
  );
  return `{\n  "version": ${b.version},\n  "note": ${JSON.stringify(b.note)},\n  "decks": {\n${decks.join(',\n')}\n  }\n}\n`;
}

type Args = { corpus: string; baseline: string; out: string; write: boolean };

export function parseRatchetArgs(argv: readonly string[]): Args {
  const a: Args = {
    corpus: join(root, 'golden-pptx'),
    baseline: join(here, '..', 'golden-census-baseline.json'),
    out: join(root, 'test-results', 'census-golden.jsonl'),
    write: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    const next = () => {
      const x = argv[++i];
      if (!x || x.startsWith('--')) throw new Error(`${v} needs a value`);
      return resolve(x);
    };
    if (v === '--write') a.write = true;
    else if (v === '--corpus') a.corpus = next();
    else if (v === '--baseline') a.baseline = next();
    else if (v === '--out') a.out = next();
    else if (v === '--') continue;
    else throw new Error(`unknown option ${v}`);
  }
  return a;
}

async function main(): Promise<number> {
  const a = parseRatchetArgs(process.argv.slice(2));
  mkdirSync(dirname(a.out), { recursive: true });
  const t0 = performance.now();
  const c = await runCensus([a.corpus], a.out);
  const census = readFileSync(a.out, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CensusLine);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`census: ${c.decks} deck(s), ${c.slides} shown slide(s), ${c.errors} unreadable, ${secs} s`);
  if (a.write) {
    const b = recordBaseline(census, `golden-pptx census: ${c.decks} decks, ${c.slides} shown slides`);
    writeFileSync(a.baseline, baselineJson(b));
    console.log(`census ratchet: baseline written (${Object.keys(b.decks).length} decks): ${a.baseline}`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(a.baseline, 'utf8')) as Baseline;
  const r = compareCensus(baseline, census);
  writeFileSync(join(dirname(a.out), 'census-ratchet.json'), `${JSON.stringify(r, null, 2)}\n`);
  for (const f of r.failures) console.error(`  REGRESSION ${f}`);
  for (const f of r.improved) console.log(`  improved ${f}`);
  for (const f of r.notes.slice(0, 50)) console.log(`  note ${f}`);
  if (r.notes.length > 50) console.log(`  … ${r.notes.length - 50} more notes in census-ratchet.json`);
  console.log(
    `census ratchet: ${r.decks} decks, ${r.slides} slides compared; ${r.failures.length} regression(s), ${r.improved.length} improved, ${r.notes.length} note(s)`,
  );
  if (r.improved.length)
    console.log('census ratchet: record the improvements with --write so they cannot slip back');
  return r.failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(
    await main().catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      return 2;
    }),
  );

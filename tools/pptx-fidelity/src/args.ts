/** The harness's command line (`main.ts` documents each option). */

export type Engine = 'ppv' | 'native';

/** One `--slides` value: slide numbers (1-based, as the report numbers them), for one deck or for all. */
export type SlideSpec = {
  /** Applies to decks whose run name contains this (case-insensitive); every deck when absent. */
  deck?: string;
  slides: ReadonlySet<number>;
};

export type Args = {
  out: string;
  corpus: boolean;
  raw: boolean;
  freshLo: boolean;
  engines: Set<Engine>;
  chromium?: string;
  baseline?: string;
  manifest?: string;
  maxDrop: number;
  /** Draw native slides as LibreOffice would where the policies differ (design/27 §14.1). */
  loCompat: boolean;
  /** Register fontconfig's face for a script under a missing script fallback family's name (`fonts.ts`). */
  scriptStandIns: boolean;
  /** `--before hub`: also score what a hub with LibreOffice showed before M9 (`beforehub.ts`). */
  before?: 'hub';
  /** `--slides`, in the order given; empty: every slide of every deck. */
  slides: SlideSpec[];
  decks: string[];
};

/** Slide numbers a `--slides` list may name, and how many one range may span. */
const MAX_SLIDE = 100_000;
const MAX_RANGE = 10_000;

/**
 * A `--slides` value: `3`, `1,4-6`, or `<deck>:<list>` for the decks whose run name contains `<deck>`
 * (run names never contain ':'). Throws on anything else.
 */
export function parseSlideSpec(v: string | undefined): SlideSpec {
  if (!v) throw new Error('--slides takes a list such as 3,5-7 or deck:3,5-7');
  const at = v.lastIndexOf(':');
  const deck = at >= 0 ? v.slice(0, at).trim() : undefined;
  const list = at >= 0 ? v.slice(at + 1) : v;
  if (deck === '') throw new Error(`--slides ${v}: the deck before ':' is empty`);
  const slides = new Set<number>();
  for (const item of list.split(',')) {
    const m = /^\s*(\d{1,6})\s*(?:-\s*(\d{1,6})\s*)?$/.exec(item);
    const from = Number(m?.[1]);
    const to = m?.[2] === undefined ? from : Number(m[2]);
    if (!m || from < 1 || to < from || to > MAX_SLIDE || to - from >= MAX_RANGE)
      throw new Error(`--slides ${v}: '${item}' is not a slide number or a range a-b of them`);
    for (let n = from; n <= to; n++) slides.add(n);
  }
  return { ...(deck !== undefined ? { deck } : {}), slides };
}

/**
 * The slide numbers to score in the deck named `name` (its run name), or undefined for every slide: the
 * union of the specs without a deck and of those whose deck it matches. An empty set leaves the deck out.
 */
export function slidesFor(specs: readonly SlideSpec[], name: string): Set<number> | undefined {
  if (!specs.length) return undefined;
  const lower = name.toLowerCase();
  const out = new Set<number>();
  for (const s of specs)
    if (s.deck === undefined || lower.includes(s.deck.toLowerCase())) for (const n of s.slides) out.add(n);
  return out;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    out: 'tmp/pptx-fidelity',
    corpus: false,
    raw: false,
    freshLo: false,
    engines: new Set(['ppv']),
    maxDrop: 0.02,
    loCompat: false,
    scriptStandIns: false,
    slides: [],
    decks: [],
  };
  let noPpv = false;
  const value = (i: number, name: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--out') a.out = value(++i, v);
    else if (v === '--corpus') a.corpus = true;
    else if (v === '--raw') a.raw = true;
    else if (v === '--fresh-lo') a.freshLo = true;
    else if (v === '--lo-compat') a.loCompat = true;
    else if (v === '--script-stand-ins') a.scriptStandIns = true;
    else if (v === '--chromium') a.chromium = value(++i, v);
    else if (v === '--baseline') a.baseline = value(++i, v);
    else if (v === '--manifest') a.manifest = value(++i, v);
    else if (v === '--slides') a.slides.push(parseSlideSpec(value(++i, v)));
    else if (v === '--before') {
      const b = value(++i, v);
      if (b !== 'hub') throw new Error('--before takes hub');
      a.before = b;
    } else if (v === '--no-ppv') noPpv = true;
    else if (v === '--max-drop') {
      a.maxDrop = Number(argv[++i]);
      if (!(a.maxDrop >= 0)) throw new Error('--max-drop takes a number ≥ 0');
    } else if (v === '--engine') {
      const e = argv[++i];
      if (e === 'ppv' || e === 'native') a.engines = new Set([e]);
      else if (e === 'both') a.engines = new Set(['ppv', 'native']);
      else throw new Error('--engine takes native, ppv or both');
    } else if (v === '--') continue;
    else if (v.startsWith('--')) throw new Error(`unknown option ${v}`);
    else a.decks.push(v);
  }
  if (noPpv) a.engines.delete('ppv');
  return a;
}

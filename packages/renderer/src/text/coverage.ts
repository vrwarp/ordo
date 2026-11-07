import { textScripts } from '@ordo/domain';

/*
 * Font coverage misses (design/27 §10 and §15 M7): characters a drawer drew that no face it has covers, so
 * the browser drew them with the computer's own fallback face (another shape on every machine, or a box).
 *
 * `FontFaceSet.check` cannot tell: it says whether the matching faces have loaded, not whether one has the
 * glyph. So each character is measured with the drawn stack's shipped faces (the resolver's internal names,
 * `o` + 8 hex digits) before two different generic families, and with each generic alone. Where a shipped
 * face has the glyph, the two stacks draw it with that face and at least one of them differs from its
 * generic alone (the advance and the ink box are compared). Where none has it, each stack falls through to
 * its generic, glyph for glyph, and both equal their generic exactly.
 *
 * What is drawn is noted by wrapping a context's `fillText` and `strokeText` (`instrument`), so the drawers
 * themselves are unchanged. A character is probed once per stack, style and weight (four `measureText` on a
 * 1x1 canvas), and the verdicts are kept until the faces change (`reset`): a slide drawn again costs a set
 * lookup per character. Text whose stack holds no shipped face is not probed: its family is not loaded,
 * which `fontFallbacks` reports.
 */

/** The advance width and the ink box of `text` in the CSS font `font`. */
export type GlyphMetrics = (font: string, text: string) => ArrayLike<number>;

/** A context whose drawn text can be noted. */
export type TextContext = {
  font: string;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
};

/** The shipped faces of a drawn stack, with the style and weight that pick their face. */
export type ShippedStack = { style: string; weight: string; faces: string[] };

/** What one draw drew: the characters of each stack it used. Resolved by `GlyphCoverage.misses`. */
export type DrawnText = Map<string, Set<number>>;

const INTERNAL = /^o[0-9a-f]{8}$/;
const SIZE = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?px(?:\/\S+)?$/i;
const WEIGHTS: Record<string, string> = { normal: '400', bold: '700', bolder: '700', lighter: '300' };
/** Drawn font strings whose probe stack is remembered (they differ by size as well). */
const FONT_STRINGS = 1024;
/** Probe size: coverage does not depend on it, and one size lets every size of a stack share verdicts. */
const PROBE_PX = 100;

/**
 * The shipped faces of a CSS font shorthand as a context serializes it (`italic bold 48px o1a2b3c4d,
 * Inter, "Segoe UI", sans-serif`), or null when it holds none. Families may be quoted or not.
 */
export function shippedStack(font: string): ShippedStack | null {
  const words = font.trim().split(/\s+/);
  const at = words.findIndex((w) => SIZE.test(w));
  if (at < 0) return null;
  let style = 'normal';
  let weight = '400';
  for (const w of words.slice(0, at)) {
    const k = w.toLowerCase();
    if (k === 'italic' || k === 'oblique') style = 'italic';
    else if (/^\d{1,4}$/.test(k)) weight = k;
    else if (WEIGHTS[k]) weight = WEIGHTS[k]!;
  }
  const faces = words
    .slice(at + 1)
    .join(' ')
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter((f) => INTERNAL.test(f));
  return faces.length ? { style, weight, faces } : null;
}

/** Characters that draw nothing to compare: controls, spaces, joiners, marks of direction and variation. */
function invisible(cp: number): boolean {
  return (
    cp <= 0x20 ||
    (cp >= 0x7f && cp <= 0xa0) ||
    cp === 0xad ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202f) ||
    (cp >= 0x205f && cp <= 0x206f) ||
    cp === 0x3000 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffc) ||
    (cp >= 0xe0000 && cp <= 0xe0fff) ||
    (cp >= 0xd800 && cp <= 0xdfff)
  );
}

const LATIN = /\p{Script=Latin}/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const INHERITED = /\p{Script=Inherited}/u;

/**
 * The scripts of `chars` as ISO 15924 codes: the script-fallback scripts (`textScripts`), Latn, Zsye
 * (emoji), Zinh (combining marks) and Zyyy (symbols, punctuation and everything else). Sorted.
 */
export function coverageScripts(chars: string): string[] {
  const out = new Set<string>();
  for (const ch of chars) {
    const scripts = textScripts(ch);
    if (scripts.size) for (const s of scripts) out.add(s);
    else if (LATIN.test(ch)) out.add('Latn');
    else if (EMOJI.test(ch)) out.add('Zsye');
    else if (INHERITED.test(ch)) out.add('Zinh');
    else out.add('Zyyy');
  }
  return [...out].sort();
}

export type CoverageLimits = {
  /** Probe stacks (style, weight and shipped faces) with verdicts kept; past it every verdict is dropped. */
  maxStacks: number;
  /** Verdicts kept in all; past it every verdict is dropped. */
  maxVerdicts: number;
  /** Characters one draw notes per stack (a 10,000-character text box has far fewer distinct ones). */
  maxPerDraw: number;
};

const DEFAULT_LIMITS: CoverageLimits = { maxStacks: 256, maxVerdicts: 50_000, maxPerDraw: 2_000 };

export class GlyphCoverage {
  readonly #metrics: GlyphMetrics;
  readonly #limits: CoverageLimits;
  /** Probe stacks by the drawn font string (null: no shipped face). */
  readonly #stacks = new Map<string, string | null>();
  /** Verdicts (true: a shipped face covers the character) by probe stack. */
  readonly #verdicts = new Map<string, Map<number, boolean>>();
  #count = 0;
  #open: DrawnText | null = null;

  constructor(metrics: GlyphMetrics, limits: Partial<CoverageLimits> = {}) {
    this.#metrics = metrics;
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Wrap `ctx.fillText` and `ctx.strokeText` (on the instance, once): text drawn on it between `begin`
   * and `end` is noted with the context's font. Drawing is otherwise unchanged.
   */
  instrument(ctx: TextContext): void {
    const marked = ctx as TextContext & { __ordoCoverage?: boolean };
    if (marked.__ordoCoverage) return;
    marked.__ordoCoverage = true;
    const fill = ctx.fillText;
    const stroke = ctx.strokeText;
    const note = (text: string) => {
      if (this.#open) this.note(ctx.font, text);
    };
    ctx.fillText = function (this: TextContext, text, x, y, maxWidth) {
      note(text);
      if (maxWidth === undefined) fill.call(this, text, x, y);
      else fill.call(this, text, x, y, maxWidth);
    };
    ctx.strokeText = function (this: TextContext, text, x, y, maxWidth) {
      note(text);
      if (maxWidth === undefined) stroke.call(this, text, x, y);
      else stroke.call(this, text, x, y, maxWidth);
    };
  }

  /** Start noting a draw's text (a draw that was not ended is dropped). */
  begin(): void {
    this.#open = new Map();
  }

  /** Stop noting: what the draw drew, for `misses` (after the draw's result is sent, off its path). */
  end(): DrawnText {
    const d = this.#open ?? new Map();
    this.#open = null;
    return d;
  }

  /** Note `text` drawn in the CSS font `font` (what `instrument` does on every draw call). */
  note(font: string, text: string): void {
    const d = this.#open;
    if (!d || typeof text !== 'string' || !text) return;
    const key = this.#stack(font);
    if (!key) return;
    let set = d.get(key);
    if (!set) {
      set = new Set();
      d.set(key, set);
    }
    for (const ch of text) {
      if (set.size >= this.#limits.maxPerDraw) return;
      const cp = ch.codePointAt(0)!;
      if (!invisible(cp)) set.add(cp);
    }
  }

  /**
   * The characters of `drawn` that no shipped face of their stack covers, in code point order, at most
   * `max`. Characters not probed yet are probed now.
   */
  misses(drawn: DrawnText, max = 64): string {
    const out = new Set<number>();
    for (const [key, cps] of drawn)
      for (const cp of cps) {
        let ok = this.#verdicts.get(key)?.get(cp);
        if (ok === undefined) {
          ok = this.#probe(key, cp);
          this.#keep(key, cp, ok);
        }
        if (!ok) out.add(cp);
      }
    return String.fromCodePoint(...[...out].sort((a, b) => a - b).slice(0, max));
  }

  /** Drop every verdict (the drawer's faces changed: a face loaded, a family was added). */
  reset(): void {
    this.#stacks.clear();
    this.#verdicts.clear();
    this.#count = 0;
  }

  /** The probe key of a drawn font string: `style weight` and the shipped faces, or null. */
  #stack(font: string): string | null {
    const hit = this.#stacks.get(font);
    if (hit !== undefined) return hit;
    const s = shippedStack(font);
    const key = s ? `${s.style === 'italic' ? 'italic ' : ''}${s.weight}|${s.faces.join(', ')}` : null;
    // Font strings differ by size too: past the bound they are parsed again, the verdicts stay.
    if (this.#stacks.size >= FONT_STRINGS) this.#stacks.clear();
    this.#stacks.set(font, key);
    return key;
  }

  #keep(key: string, cp: number, ok: boolean): void {
    let v = this.#verdicts.get(key);
    if (!v && this.#verdicts.size >= this.#limits.maxStacks) this.reset();
    if (this.#count >= this.#limits.maxVerdicts) this.reset();
    v = this.#verdicts.get(key);
    if (!v) {
      v = new Map();
      this.#verdicts.set(key, v);
    }
    v.set(cp, ok);
    this.#count++;
  }

  /** Whether a shipped face of the probe stack `key` has a glyph for `cp`. */
  #probe(key: string, cp: number): boolean {
    const bar = key.indexOf('|');
    const head = `${key.slice(0, bar)} ${PROBE_PX}px`;
    const faces = key.slice(bar + 1);
    const ch = String.fromCodePoint(cp);
    const m = this.#metrics;
    const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    try {
      return !(
        same(m(`${head} ${faces}, serif`, ch), m(`${head} serif`, ch)) &&
        same(m(`${head} ${faces}, monospace`, ch), m(`${head} monospace`, ch))
      );
    } catch {
      return true; // nothing to say: never report a miss the probe could not see
    }
  }
}

/**
 * Metrics from a 2D context (a 1x1 OffscreenCanvas of the drawer's own): the advance and the ink box,
 * which differ between two faces' glyphs even where the advances agree (every CJK glyph is 1 em wide).
 */
export function contextMetrics(ctx: { font: string; measureText(text: string): TextMetrics }): GlyphMetrics {
  const out = new Float64Array(5);
  return (font, text) => {
    ctx.font = font;
    const t = ctx.measureText(text);
    out[0] = t.width;
    out[1] = t.actualBoundingBoxLeft;
    out[2] = t.actualBoundingBoxRight;
    out[3] = t.actualBoundingBoxAscent;
    out[4] = t.actualBoundingBoxDescent;
    return Array.from(out);
  };
}

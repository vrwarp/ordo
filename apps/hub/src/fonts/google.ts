import type { GoogleFontFamily } from '@ordo/protocol';
import type { FetchLike } from '../config.ts';
import LIST from './google-fonts.json' with { type: 'json' };

export const GOOGLE_FONTS: GoogleFontFamily[] = LIST as GoogleFontFamily[];

export const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Case-insensitive search over the bundled list: prefix matches first, then substring matches. */
export function searchGoogleFonts(q: string, limit = 50): GoogleFontFamily[] {
  const s = q.trim().toLowerCase();
  if (!s) return GOOGLE_FONTS.slice(0, limit);
  const prefix: GoogleFontFamily[] = [];
  const inner: GoogleFontFamily[] = [];
  const category: GoogleFontFamily[] = [];
  for (const f of GOOGLE_FONTS) {
    const n = f.family.toLowerCase();
    if (n.startsWith(s)) prefix.push(f);
    else if (n.includes(s)) inner.push(f);
    else if (f.category === s) category.push(f);
  }
  return [...prefix, ...inner, ...category].slice(0, limit);
}

export function cssUrls(family: string): string[] {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  const urls: string[] = [];
  const known = GOOGLE_FONTS.find((f) => f.family.toLowerCase() === family.toLowerCase());
  if (known?.variants?.length) {
    const tuples = known.variants
      .map((v) => ({ ital: v.endsWith('i') ? 1 : 0, w: Number.parseInt(v, 10) }))
      .filter((t) => Number.isFinite(t.w))
      .sort((a, b) => a.ital - b.ital || a.w - b.w);
    const hasItalic = tuples.some((t) => t.ital);
    const axis = hasItalic
      ? `ital,wght@${tuples.map((t) => `${t.ital},${t.w}`).join(';')}`
      : `wght@${tuples.map((t) => t.w).join(';')}`;
    urls.push(`https://fonts.googleapis.com/css2?family=${fam}:${axis}&display=swap`);
  }
  urls.push(`https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,100..900;1,100..900&display=swap`);
  urls.push(`https://fonts.googleapis.com/css2?family=${fam}&display=swap`);
  return urls;
}

export type ParsedFace = {
  family: string;
  style: 'normal' | 'italic';
  weights: number[];
  url: string;
  subset?: string;
  /** CSS unicode-range of the subset (normalised, `normalizeUnicodeRange`); absent: the whole font. */
  unicodeRange?: string;
};

/** Bounds of one Google family (design/27 §10). */
export const GOOGLE_LIMITS = {
  /** Faces (subset × weight × style) stored per family; above it, fewer weights are kept. */
  faces: 400,
  /** Characters of the CSS answer parsed. */
  cssChars: 8 * 1024 * 1024,
  /** Characters of a stored unicode-range (the `Font.unicodeRange` bound). */
  rangeChars: 4000,
};

const MAX_CODE_POINT = 0x10ffff;

/**
 * A CSS `unicode-range` as ordo stores it (`Font.unicodeRange`): its ranges sorted and merged, in upper-case
 * hex, comma-separated without spaces (`U+0-FF,U+131,U+2000-206F`). Malformed tokens are dropped; wildcards
 * (`U+4??`) become ranges. Above `max` characters the closest neighbouring ranges are merged until it fits:
 * a wider range only lets the browser try the face for characters it may lack, and it then falls back to
 * the next face. Undefined (no range: the face covers everything) for nothing usable, for the whole code
 * space, or when not even one range fits `max`.
 */
export function normalizeUnicodeRange(raw: string, max = GOOGLE_LIMITS.rangeChars): string | undefined {
  const ranges: [number, number][] = [];
  for (const tok of raw.slice(0, 200_000).split(',')) {
    const m = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(tok);
    if (!m) continue;
    const a = m[1]!;
    if (a.includes('?') && m[2]) continue;
    if (/\?[0-9a-f]/i.test(a)) continue; // wildcards only at the end
    const lo = Number.parseInt(a.replace(/\?/g, '0'), 16);
    const hi = m[2] ? Number.parseInt(m[2], 16) : Number.parseInt(a.replace(/\?/g, 'f'), 16);
    if (!(lo <= hi) || lo > MAX_CODE_POINT) continue;
    ranges.push([lo, Math.min(hi, MAX_CODE_POINT)]);
  }
  if (!ranges.length) return undefined;
  ranges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  if (merged.length === 1 && merged[0]![0] === 0 && merged[0]![1] === MAX_CODE_POINT) return undefined;
  const hex = (n: number) => n.toString(16).toUpperCase();
  const token = ([lo, hi]: [number, number]) => (lo === hi ? `U+${hex(lo)}` : `U+${hex(lo)}-${hex(hi)}`);
  const text = () => merged.map(token).join(',');
  let out = text();
  while (out.length > max && merged.length > 1) {
    // Merge the neighbours with the smallest gap; a few at a time keeps this near-linear on long lists.
    const over = out.length - max;
    const gaps = merged.slice(1).map((r, i) => [r[0] - merged[i]![1], i] as const);
    gaps.sort((x, y) => x[0] - y[0]);
    const take = new Set(gaps.slice(0, Math.max(1, Math.ceil(over / 16))).map(([, i]) => i));
    for (let i = merged.length - 2; i >= 0; i--)
      if (take.has(i)) merged.splice(i, 2, [merged[i]![0], merged[i + 1]![1]]);
    out = text();
  }
  return out.length <= max ? out : undefined;
}

/**
 * Parse @font-face blocks: every unicode-range subset of every style and weight is its own face (design/27
 * §10), so a bilingual deck's Hebrew or Arabic family arrives with its script and subsets of one family,
 * weight and style do not replace each other. A weight range (variable font) gives one face per hundred.
 * Above `GOOGLE_LIMITS.faces` (CJK families come in about a hundred slices per weight) only the weights
 * nearest 400 and 700 are kept, then only the one nearest 400.
 */
export function parseFontCss(css: string): ParsedFace[] {
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  const text = css.slice(0, GOOGLE_LIMITS.cssChars);
  const out = new Map<string, ParsedFace>();
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[2]!;
    const prop = (name: string) => new RegExp(`${name}\\s*:\\s*([^;]+);?`, 'i').exec(body)?.[1]?.trim();
    const family = prop('font-family')?.replace(/^['"]|['"]$/g, '');
    const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(prop('src') ?? '')?.[1];
    if (!family || !url) continue;
    const style = /italic|oblique/i.test(prop('font-style') ?? '') ? 'italic' : 'normal';
    const wRaw = (prop('font-weight') ?? '400').split(/\s+/).map((x) => Number.parseInt(x, 10));
    let weights: number[];
    if (wRaw.length >= 2 && Number.isFinite(wRaw[0]) && Number.isFinite(wRaw[1])) {
      weights = [];
      for (let w = Math.ceil(wRaw[0]! / 100) * 100; w <= Math.min(wRaw[1]!, 1000); w += 100) weights.push(w);
    } else weights = [Number.isFinite(wRaw[0]) ? Math.min(Math.max(wRaw[0]!, 1), 1000) : 400];
    const range = prop('unicode-range');
    const unicodeRange = range ? normalizeUnicodeRange(range) : undefined;
    const subset = m[1] ?? (/^U\+0-FF(,|$)/.test(unicodeRange ?? '') ? 'latin' : undefined);
    for (const w of weights) {
      const key = `${style}:${w}:${url}`;
      if (!out.has(key)) out.set(key, { family, style, weights: [w], url, subset, unicodeRange });
    }
  }
  return limitFaces([...out.values()], GOOGLE_LIMITS.faces);
}

/** Keep at most `max` faces: fewer weights first (nearest 400 and 700 per style, then nearest 400). */
function limitFaces(faces: ParsedFace[], max: number): ParsedFace[] {
  let kept = faces;
  for (const [targets, styles] of [
    [
      [400, 700],
      ['normal', 'italic'],
    ],
    [[400, 700], ['normal']],
    [[400], ['normal']],
  ] as const) {
    if (kept.length <= max) return kept;
    const keep = new Set<string>();
    for (const style of styles) {
      const ws = [...new Set(kept.filter((f) => f.style === style).map((f) => f.weights[0]!))];
      for (const t of targets) {
        const near = ws.reduce<number | undefined>(
          (best, w) => (best === undefined || Math.abs(w - t) < Math.abs(best - t) ? w : best),
          undefined,
        );
        if (near !== undefined) keep.add(`${style}:${near}`);
      }
    }
    const next = kept.filter((f) => keep.has(`${f.style}:${f.weights[0]}`));
    if (next.length) kept = next;
  }
  return kept.slice(0, max);
}

export async function fetchFamilyCss(
  fetcher: FetchLike,
  family: string,
  log: (m: string) => void,
): Promise<string> {
  let lastErr = '';
  for (const url of cssUrls(family)) {
    const res = await fetcher(url, {
      headers: { 'User-Agent': DESKTOP_CHROME_UA, Accept: 'text/css,*/*;q=0.1' },
    });
    if (res.ok) {
      const css = await res.text();
      if (css.includes('@font-face')) return css;
      lastErr = 'no @font-face in response';
    } else lastErr = `HTTP ${res.status}`;
    log(`${url.replace(/^https:\/\/fonts\.googleapis\.com/, '')}: ${lastErr}`);
  }
  throw new Error(`Google Fonts has no family "${family}" (${lastErr})`);
}

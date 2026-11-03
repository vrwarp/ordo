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

export type ParsedFace = { family: string; style: 'normal' | 'italic'; weights: number[]; url: string; subset?: string };

/** Parse @font-face blocks; keep one block (the latin subset) per style and weight. */
export function parseFontCss(css: string): ParsedFace[] {
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  const all: ParsedFace[] = [];
  for (let m = re.exec(css); m; m = re.exec(css)) {
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
      for (let w = Math.ceil(wRaw[0]! / 100) * 100; w <= wRaw[1]!; w += 100) weights.push(w);
    } else weights = [Number.isFinite(wRaw[0]) ? wRaw[0]! : 400];
    const range = prop('unicode-range') ?? '';
    const subset = m[1] ?? (/U\+0000-00FF/i.test(range) ? 'latin' : undefined);
    all.push({ family, style, weights, url, subset });
  }
  // Choose per (style, weight): latin, else a block without unicode-range, else the first.
  const chosen = new Map<string, ParsedFace>();
  const rank = (f: ParsedFace) => (f.subset === 'latin' ? 2 : f.subset === undefined ? 1 : 0);
  for (const f of all)
    for (const w of f.weights) {
      const key = `${f.style}:${w}`;
      const cur = chosen.get(key);
      if (!cur || rank(f) > rank(cur)) chosen.set(key, { ...f, weights: [w] });
    }
  return [...chosen.values()];
}

export async function fetchFamilyCss(fetcher: FetchLike, family: string, log: (m: string) => void): Promise<string> {
  let lastErr = '';
  for (const url of cssUrls(family)) {
    const res = await fetcher(url, { headers: { 'User-Agent': DESKTOP_CHROME_UA, Accept: 'text/css,*/*;q=0.1' } });
    if (res.ok) {
      const css = await res.text();
      if (css.includes('@font-face')) return css;
      lastErr = 'no @font-face in response';
    } else lastErr = `HTTP ${res.status}`;
    log(`${url.replace(/^https:\/\/fonts\.googleapis\.com/, '')}: ${lastErr}`);
  }
  throw new Error(`Google Fonts has no family "${family}" (${lastErr})`);
}

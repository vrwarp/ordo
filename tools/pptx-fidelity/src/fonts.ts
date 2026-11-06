/**
 * The native column's fonts (design/27 §10, §14.1): the faces the page's `FontResolver` registers, the way
 * the outputs' resolver will have them, made from what this machine has.
 *
 * - Every family the slides ask for (`fontFamily` anywhere, run and bullet fonts included, and every
 *   `fallbackFonts` entry) gets fontconfig's face for it, as LibreOffice draws it: the regular face, plus the
 *   bold, italic and bold italic faces when they are separate files of that weight and slope in the same
 *   family (Chromium synthesizes the rest, as LibreOffice does).
 * - ordo's default face (`DEFAULT_FONT`, Inter) is on every output (§10 "Always on every output"), and so
 *   are the script fallbacks of `SCRIPT_FALLBACK_FONTS` (the CJK ones when the text has Han, Kana or Hangul,
 *   as goLive ships them). The page registers a script's fallback when the slides' text (bullet labels
 *   included, `readableText`) has that script, since the resolver asks for it only for text in its script,
 *   and when this machine has the family (`fc-list`). Script fallbacks carry their script's `unicodeRange`,
 *   so they never draw Latin text.
 * - A script whose fallback family is not installed is drawn as LibreOffice draws it here: each missing
 *   glyph from fontconfig's fallback for the run's own face (Chromium's system fallback; a serif run's
 *   Arabic comes from a serif face). With `standIns`, fontconfig's face for the script's language is
 *   registered under the family's name instead, closer to an output (which has the family) and further
 *   from LibreOffice (on a worship deck of Arabic set in Times New Roman, 0.02 lower, 0.06 on one slide).
 * - Faces are named by the SHA-256 of their file (`FontFile.hash`) and registered by the page's resolver
 *   under internal names it has never resolved ('o' + hash8), exactly as the drawers register library fonts.
 *   The slides keep the deck's own family names.
 * - A face fontconfig gives for another family is flagged `substitute` unless one of its family names is
 *   the requested family or a metric-compatible one (`metricCompatible` of `@ordo/renderer`: Carlito for
 *   Calibri, Liberation Serif for Times New Roman). Inter drawing Aptos is drawn under Aptos's name, as
 *   LibreOffice draws it, but the resolver knows it is not Aptos, so PowerPoint's stored autofit scale,
 *   computed with Aptos's widths, is not kept for it (design/27 §6 step 10), as an output without Aptos
 *   does not keep it either.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_FONT, readableText, SCRIPT_FALLBACK_FONTS, type Slide, textScripts } from '@ordo/domain';
import { metricCompatible } from '@ordo/renderer/text/fonts.ts';
import { run } from '../../../apps/hub/src/media/tools.ts';

/** A face file as fontconfig resolves a pattern: its first family name (`family`) and all of them. */
export type HostFace = {
  file: string;
  index: number;
  family: string;
  names: string[];
  bold: boolean;
  italic: boolean;
};

/** A face for the page's resolver: a renderer `FontFile` plus the file it is read from. */
export type HarnessFont = {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** SHA-256 of the file. */
  hash: string;
  unicodeRange?: string;
  /** Another family's face with other widths, registered under `family` (`FontFile.substitute`). */
  substitute?: boolean;
  file: string;
};

/** How a script fallback family is served on this machine. */
export type ScriptFace = {
  family: string;
  /** ISO 15924 codes it is the fallback for (`SCRIPT_FALLBACK_FONTS`). */
  scripts: string[];
  /**
   * installed: the family itself; stand-in: fontconfig's face for the script's language under its name
   * (`standIns`); missing: not registered, glyphs come from the browser's fallback.
   */
  served: 'installed' | 'stand-in' | 'missing';
  /** fontconfig's family and file, when registered. */
  host?: string;
  file?: string;
};

/** The language fontconfig is asked about for each script fallback (`:lang=`). */
export const SCRIPT_LANG: Readonly<Record<string, string>> = {
  Grek: 'el',
  Cyrl: 'ru',
  Hebr: 'he',
  Arab: 'ar',
  Deva: 'hi',
  Taml: 'ta',
  Thai: 'th',
  Mymr: 'my',
  Hani: 'zh-cn',
  Hira: 'ja',
  Kana: 'ja',
  Hang: 'ko',
};

/** Each script's blocks as a CSS unicode-range. */
export const SCRIPT_RANGE: Readonly<Record<string, string>> = {
  Grek: 'U+0370-03FF, U+1F00-1FFF',
  Cyrl: 'U+0400-052F, U+1C80-1C8F, U+2DE0-2DFF, U+A640-A69F',
  Hebr: 'U+0590-05FF, U+FB1D-FB4F',
  Arab: 'U+0600-06FF, U+0750-077F, U+0870-08FF, U+FB50-FDFF, U+FE70-FEFF',
  Deva: 'U+0900-097F, U+A8E0-A8FF',
  Taml: 'U+0B80-0BFF, U+11FC0-11FFF',
  Thai: 'U+0E00-0E7F',
  Mymr: 'U+1000-109F, U+A9E0-A9FF, U+AA60-AA7F',
  Hani: 'U+2E80-2FDF, U+3000-303F, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF, U+20000-3134F',
  Hira: 'U+3000-303F, U+3040-309F, U+FF00-FFEF',
  Kana: 'U+3000-303F, U+30A0-30FF, U+31F0-31FF, U+FF00-FFEF',
  Hang: 'U+1100-11FF, U+3000-303F, U+3130-318F, U+A960-A97F, U+AC00-D7AF, U+D7B0-D7FF',
};

/** Families asked for at most per deck (a hostile deck names thousands). */
export const MAX_FAMILIES = 200;

const key = (family: string) => family.trim().toLowerCase();

/** A family as one fontconfig pattern element: `-`, `:`, `,` and `\` escaped. */
export function fcFamily(family: string): string {
  return family.replace(/[\\\-:,]/g, (c) => `\\${c}`);
}

const fcCache = new Map<string, Promise<HostFace | undefined>>();

/** The file fontconfig gives `pattern` in one variant (the pattern is one argv element: no shell). */
export function fcMatch(pattern: string, bold = false, italic = false): Promise<HostFace | undefined> {
  const k = `${pattern}${bold ? ':bold' : ''}${italic ? ':italic' : ''}`;
  let got = fcCache.get(k);
  if (!got) {
    got = (async () => {
      try {
        const r = await run(
          'fc-match',
          ['-f', '%{file}\t%{index}\t%{weight}\t%{slant}\t%{family[0]}\t%{family}', k],
          { timeoutMs: 10_000, allowFail: true },
        );
        const [file, index, weight, slant, family, names] = r.stdout.split('\t');
        if (r.code !== 0 || !file) return undefined;
        return {
          file,
          index: Number(index) || 0,
          family: family ?? '',
          names: familyNames(names ?? ''),
          bold: Number(weight) >= 180, // fontconfig: semibold 180, bold 200
          italic: Number(slant) >= 100, // italic 100, oblique 110
        };
      } catch {
        return undefined; // fc-match missing: the page falls back to the generic families
      }
    })();
    fcCache.set(k, got);
  }
  return got;
}

/** fontconfig's family names of a face: comma-separated, `\` escapes. */
export function familyNames(list: string): string[] {
  return list
    .split(/(?<!\\),/)
    .map((n) => n.replace(/\\(.)/g, '$1').trim())
    .filter((n) => n);
}

/**
 * Whether fontconfig's face for `family` is another family's with other widths: none of its names is the
 * family or a metric-compatible one.
 */
export function isStandIn(family: string, face: Pick<HostFace, 'family' | 'names'>): boolean {
  const names = face.names.length ? face.names : [face.family];
  return !names.some((n) => metricCompatible(family, n));
}

let installed: Promise<Set<string>> | undefined;

/** The families installed here, lower case (`fc-list`: each face's names, comma-separated, `\` escapes). */
export function hostFamilies(): Promise<Set<string>> {
  installed ??= (async () => {
    const out = new Set<string>();
    try {
      const r = await run('fc-list', [':', 'family'], { timeoutMs: 20_000, allowFail: true });
      for (const line of r.stdout.split('\n')) for (const name of familyNames(line)) out.add(key(name));
    } catch {
      /* no fontconfig: nothing is installed as far as the harness knows */
    }
    return out;
  })();
  return installed;
}

/** Every font family the slides ask for: `fontFamily` values anywhere and `fallbackFonts` entries. */
export function familiesOf(slides: readonly Slide[]): Set<string> {
  const out = new Set<string>();
  const add = (x: unknown) => {
    if (typeof x === 'string' && x.trim()) out.add(x.trim());
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'fontFamily') add(x);
      else if (k === 'fallbackFonts' && Array.isArray(x)) for (const f of x) add(f);
      else walk(x, depth + 1);
    }
  };
  for (const s of slides) walk(s, 0);
  return out;
}

/** The fallback scripts (`textScripts`) of the slides' text objects, bullet labels included. */
export function scriptsOf(slides: readonly Slide[]): Set<string> {
  const out = new Set<string>();
  for (const s of slides)
    for (const o of s.objects)
      if (o.type === 'text') for (const c of textScripts(readableText(o))) out.add(c);
  return out;
}

/**
 * The script fallback families to register, in `SCRIPT_FALLBACK_FONTS` order, each with the scripts it
 * serves: for every script in `scripts`, the first of its families that is installed, else the first one.
 */
export function scriptFallbackPlan(
  scripts: ReadonlySet<string>,
  installedFamilies: ReadonlySet<string>,
): Map<string, { family: string; scripts: string[]; installed: boolean }> {
  const plan = new Map<string, { family: string; scripts: string[]; installed: boolean }>();
  for (const [code, families] of Object.entries(SCRIPT_FALLBACK_FONTS)) {
    if (!scripts.has(code)) continue;
    const family = families.find((f) => installedFamilies.has(key(f))) ?? families[0];
    if (!family) continue;
    const p = plan.get(key(family));
    if (p) p.scripts.push(code);
    else plan.set(key(family), { family, scripts: [code], installed: installedFamilies.has(key(family)) });
  }
  return plan;
}

/** The union of the scripts' ranges. */
function rangeOf(scripts: readonly string[]): string | undefined {
  const parts = new Set<string>();
  for (const s of scripts) for (const r of (SCRIPT_RANGE[s] ?? '').split(', ')) if (r) parts.add(r);
  return parts.size ? [...parts].join(', ') : undefined;
}

type Face = Omit<HarnessFont, 'hash'>;

/**
 * fontconfig's faces for `pattern`, registered as `family`: the regular face, and the bold, italic and bold
 * italic ones that are separate files of that weight and slope in the regular face's family.
 */
async function facesFor(
  family: string,
  pattern: string,
  unicodeRange: string | undefined,
  notes: string[],
): Promise<{ regular?: HostFace; faces: Face[] }> {
  const regular = await fcMatch(pattern);
  if (!regular) return { faces: [] };
  // Every face of the family shares the range and the flag: the variants are files of the same family.
  const shared = {
    ...(unicodeRange ? { unicodeRange } : {}),
    ...(isStandIn(family, regular) ? { substitute: true } : {}),
  };
  const faces: Face[] = [{ family, weight: 400, style: 'normal', file: regular.file, ...shared }];
  const used = new Set([regular.file]);
  for (const [bold, italic] of [
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    const f = await fcMatch(pattern, bold, italic);
    if (!f || used.has(f.file) || f.family !== regular.family) continue;
    if ((bold && !f.bold) || (italic && !f.italic)) continue;
    used.add(f.file);
    faces.push({
      family,
      weight: bold ? 700 : 400,
      style: italic ? 'italic' : 'normal',
      file: f.file,
      ...shared,
    });
  }
  if (regular.index > 0) notes.push(`font ${clip(family)}: face ${regular.index} of a collection`);
  return { regular, faces };
}

const clip = (s: string) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
};

const hashes = new Map<string, Promise<string>>();

/** SHA-256 of a font file (each file read once per run). */
export function fileHash(file: string): Promise<string> {
  let h = hashes.get(file);
  if (!h) {
    h = readFile(file).then((b) => createHash('sha256').update(b).digest('hex'));
    hashes.set(file, h);
  }
  return h;
}

/**
 * The faces the page registers for these slides: the families they ask for, ordo's default face and the
 * script fallbacks (see the header), and how each script fallback is served here.
 */
export async function hostFonts(
  slides: readonly Slide[],
  opts: { standIns?: boolean } = {},
): Promise<{ fonts: HarnessFont[]; notes: string[]; scripts: ScriptFace[] }> {
  const notes: string[] = [];
  const have = await hostFamilies();
  const plan = scriptFallbackPlan(scriptsOf(slides), have);
  const faces = new Map<string, Face[]>();
  const requested = [...familiesOf(slides)].slice(0, MAX_FAMILIES);
  if (have.has(key(DEFAULT_FONT))) requested.push(DEFAULT_FONT);
  for (const family of requested) {
    const k = key(family);
    // A script fallback family that is not installed is served by its stand-in, below.
    if (faces.has(k) || (plan.has(k) && !have.has(k))) continue;
    faces.set(k, (await facesFor(family, fcFamily(family), undefined, notes)).faces);
  }
  const scripts: ScriptFace[] = [];
  for (const [k, p] of plan) {
    const asked = faces.get(k);
    const base = { family: p.family, scripts: p.scripts };
    if (asked) {
      // Asked for by the slides and installed: registered whole, above.
      if (asked[0]) scripts.push({ ...base, served: 'installed', host: p.family, file: asked[0].file });
      continue;
    }
    const lang = SCRIPT_LANG[p.scripts[0]!];
    if (!p.installed && !(opts.standIns && lang)) {
      scripts.push({ ...base, served: 'missing' });
      continue;
    }
    const pattern = p.installed ? fcFamily(p.family) : `:lang=${lang}`;
    const got = await facesFor(p.family, pattern, rangeOf(p.scripts), notes);
    if (!got.regular) {
      scripts.push({ ...base, served: 'missing' });
      continue;
    }
    faces.set(k, got.faces);
    scripts.push({
      ...base,
      served: p.installed ? 'installed' : 'stand-in',
      host: got.regular.family,
      file: got.regular.file,
    });
  }
  const fonts: HarnessFont[] = [];
  for (const list of faces.values())
    for (const f of list) {
      try {
        fonts.push({ ...f, hash: await fileHash(f.file) });
      } catch {
        notes.push(`font ${clip(f.family)}: ${clip(f.file)} could not be read`);
      }
    }
  return { fonts, notes, scripts };
}

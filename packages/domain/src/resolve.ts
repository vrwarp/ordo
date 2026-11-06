import { SCRIPT_FALLBACK_FONTS } from './defaults.ts';
import type { ManifestFile } from './live.ts';
import type { FileRef, Font, Look, Media, Playlist, Presentation } from './schemas.ts';

/** The file an output plays or draws for a media item. */
export function playableFile(m: Media): FileRef | undefined {
  return m.delivery ?? (m.kind === 'image' ? m.original : undefined);
}

/** Every media id referenced by a playlist and its presentations, plus look holding slides and the logo. */
export function referencedMediaIds(
  playlist: Playlist,
  presentations: Record<string, Presentation>,
  looks: Look[] = [],
  logoMediaId?: string,
): Set<string> {
  const ids = new Set<string>();
  const add = (id?: string) => id && ids.add(id);
  for (const item of playlist.items) {
    if (item.kind === 'media') add(item.mediaId);
    if (item.kind === 'presentation') {
      add(item.backgroundMediaId);
      const p = presentations[item.presentationId];
      if (!p) continue;
      add(p.backgroundMediaId);
      for (const sec of p.sections)
        for (const sl of sec.slides) {
          add(sl.backgroundMediaId);
          add(sl.imported?.imageMediaId);
          for (const o of sl.objects) if (o.type === 'image') add(o.mediaId);
        }
    }
  }
  for (const l of looks) add(l.holdingMediaId);
  add(logoMediaId);
  return ids;
}

/** Font families used by any text style in the presentations or looks. */
export function referencedFontFamilies(presentations: Presentation[], looks: Look[]): Set<string> {
  const fam = new Set<string>();
  for (const p of presentations)
    for (const sec of p.sections)
      for (const sl of sec.slides)
        for (const o of sl.objects) if (o.type === 'text') fam.add(o.style.fontFamily);
  for (const l of looks) {
    if (l.layers.slide.mode === 'lyricOnly') {
      fam.add(l.layers.slide.style.fontFamily);
      if (l.layers.slide.nextSlide) fam.add(l.layers.slide.nextSlide.style.fontFamily);
    }
    for (const s of Object.values(l.layers.props.style)) fam.add(s.fontFamily);
  }
  for (const f of scriptFontFamilies(presentations)) fam.add(f);
  return fam;
}

/** Manifest file list for a set of media and fonts: playable files plus video posters. */
export function manifestFiles(media: Media[], fonts: Font[]): ManifestFile[] {
  const out = new Map<string, ManifestFile>();
  const add = (f?: FileRef) => f && out.set(f.hash, { hash: f.hash, bytes: f.bytes, mime: f.mime });
  for (const m of media) {
    add(playableFile(m));
    add(m.poster);
  }
  for (const f of fonts) add(f.file);
  return [...out.values()];
}

/**
 * The scripts `SCRIPT_FALLBACK_FONTS` has faces for (ISO 15924 codes, the ones `textScripts` reports), each
 * with its test: the goLive font scan (design/27 §10).
 */
const FALLBACK_SCRIPT_TESTS: readonly (readonly [code: string, test: RegExp])[] = [
  ['Grek', /\p{Script=Greek}/u],
  ['Cyrl', /\p{Script=Cyrillic}/u],
  ['Hebr', /\p{Script=Hebrew}/u],
  ['Arab', /\p{Script=Arabic}/u],
  ['Deva', /\p{Script=Devanagari}/u],
  ['Taml', /\p{Script=Tamil}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Mymr', /\p{Script=Myanmar}/u],
  ['Hani', /\p{Script=Han}/u],
  ['Hira', /\p{Script=Hiragana}/u],
  ['Kana', /\p{Script=Katakana}/u],
  ['Hang', /\p{Script=Hangul}/u],
];

/** Any character of a `FALLBACK_SCRIPT_TESTS` script: most text has none and is answered in one pass. */
const ANY_FALLBACK_SCRIPT = new RegExp(`[${FALLBACK_SCRIPT_TESTS.map(([, re]) => re.source).join('')}]`, 'u');

/**
 * Han, Kana and Hangul: their fallback faces (Noto CJK) are large, so goLive ships them only with text in
 * these scripts and the output-config fonts never carry them (design/27 §10). The other script fallbacks
 * are bundled and go to every output.
 */
export const ON_DEMAND_FONT_SCRIPTS: readonly string[] = ['Hani', 'Hira', 'Kana', 'Hang'];

/** The `SCRIPT_FALLBACK_FONTS` scripts (ISO 15924 codes) of the characters in `text`. */
export function fallbackFontScripts(text: string): Set<string> {
  const out = new Set<string>();
  if (!ANY_FALLBACK_SCRIPT.test(text)) return out;
  for (const [code, re] of FALLBACK_SCRIPT_TESTS) if (re.test(text)) out.add(code);
  return out;
}

/**
 * The script fallback families the presentations' text needs: `SCRIPT_FALLBACK_FONTS` of every script
 * present in a text object. `referencedFontFamilies` includes them, so goLive ships the faces the library
 * has of these families, and CJK faces reach outputs only this way (design/27 §10: by text scan). Han in a
 * text with Kana or Hangul is Japanese or Korean, whose family covers it; Han alone names every CJK family
 * and goLive ships the ones the venue added.
 */
export function scriptFontFamilies(presentations: Presentation[]): Set<string> {
  const scripts = new Set<string>();
  for (const p of presentations)
    for (const sec of p.sections)
      for (const sl of sec.slides)
        for (const o of sl.objects) {
          if (o.type !== 'text') continue;
          const found = fallbackFontScripts(o.text);
          const kanaOrHangul = found.has('Hira') || found.has('Kana') || found.has('Hang');
          for (const code of found) if (code !== 'Hani' || !kanaOrHangul) scripts.add(code);
        }
  const fam = new Set<string>();
  for (const code of scripts) for (const f of SCRIPT_FALLBACK_FONTS[code] ?? []) fam.add(f);
  return fam;
}

/** The families of `ON_DEMAND_FONT_SCRIPTS`, lower case. */
const ON_DEMAND_FAMILIES: ReadonlySet<string> = new Set(
  ON_DEMAND_FONT_SCRIPTS.flatMap((code) => SCRIPT_FALLBACK_FONTS[code] ?? []).map((f) => f.toLowerCase()),
);

/**
 * Is `family` a CJK fallback family (case-insensitive)? Its faces go to an output only in a goLive whose
 * text needs them, or when something names the family (design/27 §10).
 */
export function isOnDemandFontFamily(family: string): boolean {
  return ON_DEMAND_FAMILIES.has(family.trim().toLowerCase());
}

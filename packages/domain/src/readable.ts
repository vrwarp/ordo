import { type LabelSource, paraLabels } from './bullets.ts';

/**
 * Text as people read it (design/27 §1, §3.2): `TextObject.text` with automatic numbers and bullets
 * written as text, so verse numbers survive on the stage, in bands, cue labels and search. The labels are
 * `paraLabels` (bullets.ts), which the renderer's bullets draw too, so what the stage shows is what the
 * outputs draw.
 */

/** Between a label and its paragraph: a no-break space, so a verse number stays with its first word. */
export const LABEL_GAP = '\u{a0}';

/**
 * `o.text` with each paragraph's bullet or number label in front of it ('(17)\u{a0}For God so loved').
 * Paragraphs stay where they are: the result has as many '\n' as `o.text`, so paragraph i of the result
 * is still described by `o.paras[i]` (a drawer that lays it out drops `bullet` from those paras). Text
 * without paragraph styles is returned as it is.
 */
export function readableText(o: LabelSource): string {
  if (!Array.isArray(o.paras) || !o.paras.length) return o.text;
  const labels = paraLabels(o);
  if (labels.every((l) => l === null)) return o.text;
  return o.text
    .split('\n')
    .map((p, i) => (labels[i] ? `${labels[i]}${LABEL_GAP}${p}` : p))
    .join('\n');
}

/**
 * The scripts the font scan cares about, as ISO 15924 codes with their test, in the order `textScripts`
 * reports them: scripts whose text a deck's Latin faces do not cover, so that a script fallback face
 * (design/27 §10) has to. The text engine's `FaceRequest.script` uses the same codes.
 */
export const FALLBACK_SCRIPTS: readonly (readonly [code: string, test: RegExp])[] = [
  ['Hebr', /\p{Script=Hebrew}/u],
  ['Arab', /\p{Script=Arabic}/u],
  ['Syrc', /\p{Script=Syriac}/u],
  ['Thaa', /\p{Script=Thaana}/u],
  ['Nkoo', /\p{Script=Nko}/u],
  ['Deva', /\p{Script=Devanagari}/u],
  ['Beng', /\p{Script=Bengali}/u],
  ['Guru', /\p{Script=Gurmukhi}/u],
  ['Gujr', /\p{Script=Gujarati}/u],
  ['Orya', /\p{Script=Oriya}/u],
  ['Taml', /\p{Script=Tamil}/u],
  ['Telu', /\p{Script=Telugu}/u],
  ['Knda', /\p{Script=Kannada}/u],
  ['Mlym', /\p{Script=Malayalam}/u],
  ['Sinh', /\p{Script=Sinhala}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Laoo', /\p{Script=Lao}/u],
  ['Mymr', /\p{Script=Myanmar}/u],
  ['Khmr', /\p{Script=Khmer}/u],
  ['Tibt', /\p{Script=Tibetan}/u],
  ['Ethi', /\p{Script=Ethiopic}/u],
  ['Armn', /\p{Script=Armenian}/u],
  ['Geor', /\p{Script=Georgian}/u],
  ['Grek', /\p{Script=Greek}/u],
  ['Cyrl', /\p{Script=Cyrillic}/u],
  ['Hani', /\p{Script=Han}/u],
  ['Hira', /\p{Script=Hiragana}/u],
  ['Kana', /\p{Script=Katakana}/u],
  ['Hang', /\p{Script=Hangul}/u],
];

/** Any character of a `FALLBACK_SCRIPTS` script: most text has none and is answered in one pass. */
const ANY_FALLBACK = new RegExp(`[${FALLBACK_SCRIPTS.map(([, re]) => re.source).join('')}]`, 'u');

/**
 * The scripts (ISO 15924 codes, `FALLBACK_SCRIPTS`) of the characters in `text` that need a script
 * fallback face: the font scan of goLive (CJK faces are shipped only when Han, Kana or Hangul is present)
 * and the outputs' font coverage report. Scan `readableText` when labels count (Thai and Devanagari
 * numbers are written in their own digits).
 */
export function textScripts(text: string): Set<string> {
  const out = new Set<string>();
  if (!ANY_FALLBACK.test(text)) return out;
  for (const [code, re] of FALLBACK_SCRIPTS) if (re.test(text)) out.add(code);
  return out;
}

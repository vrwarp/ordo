import type { TextObject } from './schemas.ts';

/**
 * Text as people read it (design/27 §1, §3.2): `TextObject.text` with automatic numbers and bullets written
 * as text, so verse numbers survive on the stage, in bands, cue labels and search. The renderer's bullets
 * (packages/renderer/src/text/bullets.ts) use the same labels, so what the stage shows is what the output
 * draws.
 *
 * Scaffold: labels are not computed yet (every paragraph reads as written); `textScripts` knows the scripts
 * the bundled fallbacks cover.
 */

/** The label drawn before each paragraph ('1.', '(17)', '•'), or null for none; index = paragraph index. */
export function paraLabels(o: Pick<TextObject, 'text' | 'paras'>): (string | null)[] {
  return o.text.split('\n').map(() => null);
}

/** `o.text` with each paragraph's bullet or number label in front of it. */
export function readableText(o: Pick<TextObject, 'text' | 'paras'>): string {
  const labels = paraLabels(o);
  if (labels.every((l) => l === null)) return o.text;
  return o.text
    .split('\n')
    .map((p, i) => (labels[i] ? `${labels[i]} ${p}` : p))
    .join('\n');
}

/** ISO 15924 codes of the scripts the font scan cares about, in the order they are tested. */
const SCRIPTS: readonly [string, RegExp][] = [
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

/** The scripts (ISO 15924 codes) in `text` that need a script fallback face: the font scan of goLive. */
export function textScripts(text: string): Set<string> {
  const out = new Set<string>();
  for (const [code, re] of SCRIPTS) if (re.test(text)) out.add(code);
  return out;
}

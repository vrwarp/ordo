/**
 * Run markers: an id written into a text run's `<a:t>` before pptx-preview renders it, found again in the
 * rendered page and removed there, so styles pptx-preview gets wrong can be applied to the right element.
 *
 * A marker is MARK_START followed by MARK_DIGITS base-4 digits. Every character is an invisible format
 * character (U+2060..U+2064: word joiner and the invisible math operators): zero width, no line-break
 * opportunity, allowed in XML. The page code (page.ts) decodes them with its own copy of these constants,
 * because it runs inside the browser and cannot import.
 */
export const MARK_START = '⁤';
export const MARK_ALPHABET = '⁠⁡⁢⁣';
export const MARK_DIGITS = 8;
/** Runs one deck can mark (4^8); the rest render as pptx-preview draws them. */
export const MAX_MARKED_RUNS = 4 ** MARK_DIGITS;

export function encodeMarker(id: number): string {
  if (!Number.isInteger(id) || id < 0 || id >= MAX_MARKED_RUNS) throw new RangeError(`marker id ${id}`);
  let s = '';
  let v = id;
  for (let i = 0; i < MARK_DIGITS; i++) {
    s = MARK_ALPHABET[v % 4] + s;
    v = Math.floor(v / 4);
  }
  return MARK_START + s;
}

/** The id of a marker starting at `at` in `text`, or undefined when there is none. */
export function decodeMarker(text: string, at = 0): number | undefined {
  if (text[at] !== MARK_START) return undefined;
  let v = 0;
  for (let i = 1; i <= MARK_DIGITS; i++) {
    // Past the end is not a digit (`indexOf('')` would say 0).
    const ch = text[at + i];
    const d = ch === undefined ? -1 : MARK_ALPHABET.indexOf(ch);
    if (d < 0) return undefined;
    v = v * 4 + d;
  }
  return v;
}

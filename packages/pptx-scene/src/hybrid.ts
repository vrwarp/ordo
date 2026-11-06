/**
 * The art of a hybrid slide once it is emitted (design/27 §5 "Slide class", "Two-phase save"; M3 item D):
 * `EmittedSlide.art`, everything the LibreOffice follow-up needs without the IR.
 *
 * - `elements`: the art's elements as `ElementRef`s (source, `cNvPr id`, and the place among the elements of
 *   that source with that id), so the render copy finds them in the deck again and prints only them.
 * - `box`: the art range's bounding box in logical px (`ArtRange.box` through the frame).
 * - `at` and `before`: where the art object goes in version 2. It takes the place of the lowest residual
 *   element (Rmin): just under the first object emitted for an element at or above Rmin that the art does not
 *   replace. `before` names that object, so the patch finds the place again after the import added or left out
 *   objects below it (a background laid on white, a picture that could not be stored); `at` is its index in
 *   the emitted objects.
 * - `replaces`: the objects of the non-residual elements the art bakes in (residuals emit nothing). Version 1
 *   draws them natively until the art arrives.
 * - `text`: the text of the text bodies inside the art, a table's cells included (`Slide.pptx.artText`,
 *   search and labels only).
 *
 * Pure: indexes and ids only.
 */
import type { SlideObject } from '@ordo/domain';
import type { ArtInfo, Element, ElementRef, Frame, SlideScene, TextBody } from './ir.ts';

/** Longest art text kept (`@ordo/domain` MAX.text). */
const MAX_ART_TEXT = 20_000;
/** Logical coordinates are bounded by the schema (`coord`). */
const MAX_COORD = 100_000;

/**
 * `ElementRef`s of `elements[i]` for each `i` of `indexes`: the source, the `cNvPr id` and the place among
 * the elements of that source with that id (bottom first, from 0), so ids that repeat stay apart.
 */
export function elementRefs(elements: readonly Element[], indexes: readonly number[]): ElementRef[] {
  const want = new Set(indexes);
  const seen = new Map<string, number>();
  const byIndex = new Map<number, ElementRef>();
  let last = -1;
  for (const i of indexes) last = Math.max(last, i);
  for (let i = 0; i <= last && i < elements.length; i++) {
    const e = elements[i]!;
    const key = `${e.from}:${e.shapeId}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    if (want.has(i)) byIndex.set(i, { from: e.from, shapeId: e.shapeId, nth });
  }
  return indexes.map((i) => byIndex.get(i)).filter((r): r is ElementRef => r !== undefined);
}

/** A text body's characters as `TextObject.text` writes them (paragraphs and breaks as '\n'). */
function bodyText(body: TextBody | undefined): string {
  if (!body) return '';
  return body.paras
    .map((p) => p.runs.map((r) => (r.kind === 'break' ? '\n' : r.text.replaceAll('\t', ' '))).join(''))
    .join('\n')
    .trim();
}

const bound = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

/**
 * The art of an emitted hybrid slide, or undefined for any other slide. `spans[i]` is the range of
 * `objects` that element `i` of the scene emitted ([start, end), empty for residuals and hidden elements);
 * `objects` are the slide's objects as emitted (backgrounds first).
 */
export function artInfo(
  s: SlideScene,
  frame: Frame,
  spans: readonly (readonly [number, number])[],
  objects: readonly SlideObject[],
): ArtInfo | undefined {
  const art = s.classification.art;
  if (!art || s.classification.class !== 'hybrid' || s.error) return undefined;
  const replaces: string[] = [];
  const texts: string[] = [];
  for (const i of art.elements) {
    const [a, b] = spans[i] ?? [0, 0];
    for (let k = a; k < b && k < objects.length; k++) replaces.push(objects[k]!.id);
    const e = s.elements[i];
    if (e?.kind === 'shape') {
      const t = bodyText(e.text);
      if (t) texts.push(t);
    } else if (e?.kind === 'table')
      for (const c of e.cells) {
        const t = bodyText(c.text);
        if (t) texts.push(t);
      }
  }
  const at = Math.min(objects.length, spans[art.from]?.[0] ?? objects.length);
  const gone = new Set(replaces);
  let before: string | undefined;
  for (let k = at; k < objects.length; k++)
    if (!gone.has(objects[k]!.id)) {
      before = objects[k]!.id;
      break;
    }
  const x = bound(frame.x0 + art.box.x * frame.s, -MAX_COORD, MAX_COORD);
  const y = bound(frame.y0 + art.box.y * frame.s, -MAX_COORD, MAX_COORD);
  return {
    elements: elementRefs(s.elements, art.elements),
    box: {
      x,
      y,
      w: bound(art.box.cx * frame.s, 0, MAX_COORD),
      h: bound(art.box.cy * frame.s, 0, MAX_COORD),
    },
    at,
    replaces,
    text: texts.join('\n').slice(0, MAX_ART_TEXT),
    ...(before !== undefined ? { before } : {}),
  };
}

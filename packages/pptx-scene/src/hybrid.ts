/**
 * The art of a hybrid slide once it is emitted (design/27 §5 "Slide class", "Two-phase save"; M3 item D):
 * `EmittedSlide.art`, everything the LibreOffice follow-up needs without the IR.
 *
 * - `elements`: the art's elements as `ElementRef`s (source, `cNvPr id`, and the place among the elements of
 *   that source with that id), so the render copy finds them in the deck again and prints only them. The
 *   elements of a SmartArt drawing are one graphic frame there, named once (M6).
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
 * **Without LibreOffice** (M9, `EmitOptions.libreoffice: false`, `withoutLibreOffice`): nothing draws the art,
 * so it is not planned. The slide keeps version 1's objects, and its residual elements are listed by kind
 * (`EmittedSlide.missing`); the slide is hybrid with a `missing:<kind>` reason, its art text kept.
 *
 * Pure: indexes and ids only.
 */
import type { SlideObject } from '@ordo/domain';
import { MISSING_LIMITS, type MissingKind, missingEntry, missingLabel } from '@ordo/domain/missing.ts';
import type { ArtInfo, Classification, Element, ElementRef, Frame, SlideScene, TextBody } from './ir.ts';
import { missingKindOf } from './residual.ts';

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
    // The elements of one SmartArt drawing are its one graphic frame in the deck (M6, `smartart.ts`).
    const prev = elements[i - 1];
    const same = e.diagram !== undefined && prev?.diagram === e.diagram && prev.from === e.from;
    const nth = same ? (seen.get(key) ?? 1) - 1 : (seen.get(key) ?? 0);
    if (!same) seen.set(key, nth + 1);
    if (want.has(i)) byIndex.set(i, { from: e.from, shapeId: e.shapeId, nth });
  }
  const out: ElementRef[] = [];
  const kept = new Set<string>();
  for (const i of indexes) {
    const r = byIndex.get(i);
    if (!r) continue;
    const k = `${r.from}:${r.shapeId}#${r.nth}`;
    if (kept.has(k)) continue;
    kept.add(k);
    out.push(r);
  }
  return out;
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

/**
 * A slide as a hub without LibreOffice stores it (`EmitOptions.libreoffice: false`; design/27 §15 M9,
 * decision 8): nothing draws its art or converts its metafile pictures, so neither is planned (the caller
 * drops `art` and `metafiles`). Version 1's objects stay as they are: the native objects of the art range
 * and the stand-ins version 1 draws for residual text (a warp as plain text, vertical text in its turned
 * box). What the art or the conversion would have drawn is listed by kind (`@ordo/domain` `missingEntry`):
 * - each residual element of the art range: 'smartart' for an element of a SmartArt drawing, else the kind
 *   of its first reason the decision table names (`residual.ts` `missingKindOf`: 'chart', 'ole', 'math',
 *   'decoration' …, 'element' for the rest);
 * - 'metafile' when `metafiles` pictures waited for conversion.
 * The slide is then class hybrid (no art object), with a reason `missing:<kind>` per kind after its own, and
 * `artText` keeps the art's text for search; one note says what is not drawn. Undefined when nothing is
 * missing, and for a picture-class slide (the budget ladder's, M9 `ladder`).
 */
export function withoutLibreOffice(
  s: SlideScene,
  classification: Classification,
  art: ArtInfo | undefined,
  metafiles: number,
  log: (msg: string) => void,
): { classification: Classification; missing: string[]; artText?: string } | undefined {
  if (classification.class === 'picture' || s.error) return undefined;
  const kinds: MissingKind[] = [];
  const add = (k: MissingKind) => {
    if (!kinds.includes(k) && kinds.length < MISSING_LIMITS.entries) kinds.push(k);
  };
  for (const i of s.classification.art?.elements ?? []) {
    const e = s.elements[i];
    if (e?.support !== 'residual') continue;
    add(e.diagram !== undefined ? 'smartart' : missingKindOf(e.reasons));
  }
  if (metafiles > 0) add('metafile');
  if (!kinds.length) return undefined;
  const missing = kinds.map((k) => missingEntry(k));
  const why = missing.map((m) => `missing:${m}`).sort();
  log(`not drawn without LibreOffice: ${kinds.map(missingLabel).join(', ')}`);
  return {
    classification: {
      ...classification,
      class: 'hybrid',
      reasons: [...classification.reasons.filter((r) => !why.includes(r)), ...why],
    },
    missing,
    ...(art?.text ? { artText: art.text } : {}),
  };
}

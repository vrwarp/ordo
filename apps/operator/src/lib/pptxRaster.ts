/**
 * The words of the pictures of shapes (the owner's Q53, Q57.d, Q67, Q68): what the Reset slide card says about a slide
 * whose many-point shapes were drawn into pictures at import, and the test that finds such a slide. Plain English: the
 * owner's words are "picture" and "shape" (no "raster", no "recipe", no "converter").
 */
import type { Slide } from '@ordo/domain';

/** Whether the slide holds a picture of shapes (an object of origin role 'raster'): Reset slide can bring the shapes back. */
export function holdsRaster(slide: Pick<Slide, 'objects'>): boolean {
  return slide.objects.some((o) => o.origin?.role === 'raster');
}

/** The hint under 'Reset slide from PowerPoint' for a slide that holds a picture of shapes. */
export const RASTER_RESET_HINT =
  'Brings the shapes back as shapes. Shapes too large for ordo stay boxes. The changes you made to imported objects are replaced.';

/** The sentence the confirm dialog of Reset slide adds for such a slide. */
export const RASTER_RESET_CONFIRM =
  'Pictures drawn from shapes become shapes again; shapes too large for ordo stay boxes.';

/** The card of the picture of shapes in the slide panel (what it is, what editing it can do). */
export const RASTER_PICTURE_CARD =
  'A picture of shapes made when the file was imported. Move, resize or delete it. It cannot be edited as shapes, and the words in it are no longer text. Reset slide from PowerPoint brings the shapes back as shapes; shapes too large for ordo stay boxes.';

/** The line of the Re-import dialog (Q67): a whole Re-import draws the pictures again. */
export const RASTER_REIMPORT_LINE =
  'Slides you did not edit that have many-point shapes are drawn into pictures again, also the ones you reset to shapes.';

// ── The import report (Q53, C-SR11; the hub's `PptxNativeResult.rasters`) ──────────────────────────────────

/** What the hub's picture step of shapes came to, as the card reads it (read defensively: `readRasterCounts`). */
export type RasterResult = {
  /** Many-point shapes the deck holds on slides that may take a picture. */
  candidates: number;
  /** Shapes drawn into pictures (the many-point ones and the small ones drawn with them). */
  shapes: number;
  /** Pictures planned, made now, found already stored, and not made (their shapes are as before). */
  pictures: number;
  stored: number;
  reused: number;
  putBack: number;
  /** Pictured shapes that carry words. */
  words: number;
  /** Why this hub made none: no Chromium and no LibreOffice, or LibreOffice draws them as before. */
  off?: 'no-maker' | 'libreoffice';
  skipped: { text: number; effects: number; fill: number; anchored: number; other: number };
  reasons: string[];
};

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1_000_000, Math.round(v))) : 0;

/** The picture step's counts from a job result (absent, or not an object: none). */
export function readRasterCounts(v: unknown): RasterResult | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const sk = (r.skipped && typeof r.skipped === 'object' ? r.skipped : {}) as Record<string, unknown>;
  const reasons = Array.isArray(r.reasons)
    ? r.reasons
        .filter((x): x is string => typeof x === 'string')
        .slice(0, 8)
        .map((x) => x.slice(0, 40))
    : [];
  return {
    candidates: num(r.candidates),
    shapes: num(r.shapes),
    pictures: num(r.pictures),
    stored: num(r.stored),
    reused: num(r.reused),
    putBack: num(r.putBack),
    words: num(r.words),
    ...(r.off === 'no-maker' || r.off === 'libreoffice' ? { off: r.off } : {}),
    skipped: {
      text: num(sk.text),
      effects: num(sk.effects),
      fill: num(sk.fill),
      anchored: num(sk.anchored),
      other: num(sk.other),
    },
    reasons,
  };
}

const many = (n: number, one: string, more: string): string =>
  `${n.toLocaleString('en')} ${n === 1 ? one : more}`;

/**
 * The line for the shapes drawn into pictures: the stored slides' own counts (the editor's report reads them from the slides,
 * so it says the same after a re-open as the card said at import).
 */
export function rasterDrawnLine(shapes: number, pictures: number): string {
  return `${many(shapes, 'shape was', 'shapes were')} drawn into ${many(pictures, 'picture', 'pictures')} so the slide shows ${shapes === 1 ? 'it' : 'them'} whole (the pictures can be moved and resized, but the shapes in them cannot be edited; Reset slide from PowerPoint brings back the shapes that fit ordo's limits as shapes, and shapes too large stay boxes)`;
}

/** The line for pictured shapes that carry words (Q68). */
export function rasterWordsLine(words: number): string {
  return `${many(words, 'shape has', 'shapes have')} words: the words are part of the picture now (they cannot be edited and the font is fixed); search finds them, and the cue label and the Stage show them when the slide has no other text`;
}

/** The lines the import card shows for the picture step, in plain words; empty when the deck had nothing to say. */
export function rasterLines(r: RasterResult | undefined): string[] {
  if (!r) return [];
  const lines: string[] = [];
  const made = r.stored + r.reused;
  if (made > 0 && r.shapes > 0) {
    lines.push(rasterDrawnLine(r.shapes, made));
    if (r.words > 0) lines.push(rasterWordsLine(r.words));
  }
  if (r.off === 'no-maker' && r.candidates > 0)
    lines.push(
      'this computer cannot draw pictures of shapes (it needs Chromium): these shapes are as they were',
    );
  if (r.off === 'libreoffice' && r.candidates > 0)
    lines.push('the pictures of these shapes come from LibreOffice, as before');
  const left = r.skipped.effects + r.skipped.fill;
  if (left > 0)
    lines.push(
      `${many(left, 'shape with', 'shapes with')} a shadow, a glow, a soft edge, a 3-D look or a picture fill ${left === 1 ? 'stays' : 'stay'} as ${left === 1 ? 'it was' : 'they were'}`,
    );
  if (r.putBack > 0) {
    const why = new Set(r.reasons);
    if (why.has('live'))
      lines.push(
        `${many(r.putBack, 'picture was', 'pictures were')} not made because a service started; the shapes are as before: use Re-import from PowerPoint after the service`,
      );
    else if (why.has('timeout') || why.has('budget'))
      lines.push(
        `${many(r.putBack, 'picture', 'pictures')} could not be made in time and the shapes are as before`,
      );
    else if (why.has('bytes') || why.has('count') || why.has('pixels'))
      lines.push(
        `the pictures of this presentation would pass the picture limit: the shapes of ${many(r.putBack, 'picture', 'pictures')} stay as they were`,
      );
    else if (why.has('font'))
      lines.push(
        `${many(r.putBack, 'picture was', 'pictures were')} not made because a font for the words in ${r.putBack === 1 ? 'it is' : 'them are'} missing; the shapes are as before`,
      );
    else lines.push(`${many(r.putBack, 'picture', 'pictures')} could not be made; the shapes are as before`);
  }
  return lines;
}

/** What a stored slide says about its pictures of shapes, summed (the editor's report counts it from the slides). */
export function rasterTotals(
  slides: Iterable<Pick<Slide, 'objects'>>,
): { shapes: number; pictures: number } | undefined {
  let shapes = 0;
  let pictures = 0;
  for (const sl of slides)
    for (const o of sl.objects) {
      if (o.origin?.role !== 'raster') continue;
      pictures++;
      shapes += o.origin.raster?.n ?? 0;
    }
  return pictures ? { shapes, pictures } : undefined;
}

import { canonicalJson } from './palette.ts';
import type { CellStyle, TextStyle } from './schemas.ts';

/*
 * A table cell's text box style and its style entry (design/27 M9, `ShapeObject.table`): the one mapping
 * between a cell style (`CellStyle`, sparse over the table's `base`) and the text box style the cell is drawn
 * and edited in. Pure and free of the zod schemas at run time (types only), so the PowerPoint converter
 * (`@ordo/pptx-scene`, whose purity test admits only such domain modules) writes each cell's entry with the
 * same inverse the domain's table model reads it back with (`table.ts` `cellTextStyle`, `cellStyleOf`,
 * `cellRich`). `table.ts` keeps the same two functions (tested equal in `cellstyle.test.ts`) until it
 * re-exports these.
 */

/** The text style keys a cell style sets over `base` as they are (the others are mapped: `align`). */
export const CELL_TEXT_KEYS = [
  'fontFamily',
  'fontWeight',
  'fontSizePx',
  'color',
  'insets',
  'lang',
  'fallbackFonts',
  'fontStyle',
  'valign',
  'direction',
] as const satisfies readonly (keyof CellStyle & keyof TextStyle)[];

/**
 * The text box style a cell is drawn in: `base` with the cell style's fields over it. A cell never shrinks
 * its text (its row grows instead), so the style has no autofit; a cell aligned 'justify' is left aligned and
 * justified, one aligned otherwise is not justified.
 */
export function cellTextStyle(base: TextStyle, s: CellStyle | undefined): TextStyle {
  const out: TextStyle = { ...base };
  delete out.autofit;
  delete out.fitScale;
  if (!s) return out;
  const w = out as Record<string, unknown>;
  for (const k of CELL_TEXT_KEYS) if (s[k] !== undefined) w[k] = s[k];
  if (s.align !== undefined) {
    out.align = s.align === 'justify' ? 'left' : s.align;
    if (s.align === 'justify') out.justify = true;
    else delete out.justify;
  }
  return out;
}

/** The cell style that makes `style` over `base` (`cellTextStyle`'s inverse), keeping `vert` as given. */
export function cellStyleOf(base: TextStyle, style: TextStyle, vert?: CellStyle['vert']): CellStyle {
  const out: CellStyle = {};
  const w = out as Record<string, unknown>;
  for (const k of CELL_TEXT_KEYS)
    if (style[k] !== undefined && canonicalJson(style[k]) !== canonicalJson(base[k])) w[k] = style[k];
  const align = (s: TextStyle) => (s.justify ? 'justify' : s.align);
  if (align(style) !== align(base)) out.align = align(style);
  if (vert !== undefined && vert !== 'horz') out.vert = vert;
  return out;
}

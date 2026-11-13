import { DEFAULT_LYRIC_STYLE, type ShapeObject, type TableCell, type TableData } from '@ordo/domain';
import { clampShapeObject } from '../shape.ts';

/*
 * Table fixtures for the renderer's table tests (not shipped code; vitest only runs *.test.ts).
 */

export const navy = { r: 20, g: 40, b: 90, a: 1 };
export const white = { r: 255, g: 255, b: 255, a: 1 };
export const grey = { r: 200, g: 200, b: 200, a: 1 };

/** The base style of the fixtures: 20 px, office line model, top-left, 5 px insets, no effects. */
export const BASE = {
  ...DEFAULT_LYRIC_STYLE,
  fontFamily: 'Golden',
  fontWeight: 400,
  fontSizePx: 20,
  color: navy,
  align: 'left' as const,
  valign: 'top' as const,
  lineModel: 'office' as const,
  insets: { l: 5, t: 5, r: 5, b: 5 },
  outline: undefined,
  shadow: undefined,
};

/** A grid of R × C single cells with text 'r<r>c<c>', every edge drawn in one thin line. */
export function gridTable(R: number, C: number, extra: Partial<TableData> = {}): TableData {
  const cells: TableCell[] = [];
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) cells.push({ text: `r${r}c${c}` });
  return {
    cols: Array(C).fill(100),
    rows: Array(R).fill(40),
    cells,
    base: BASE,
    lineStyles: [{ width: 1, color: grey }],
    h: [...Array(R + 1)].map((_, k) => [k, 0, C, 0] as [number, number, number, number]),
    v: [...Array(C + 1)].map((_, k) => [k, 0, R, 0] as [number, number, number, number]),
    ...extra,
  };
}

/** A clamped table shape at (100, 100), its box Σcols × Σrows unless given. */
export function tableShape(
  t: TableData,
  box: Partial<ShapeObject['box']> = {},
  extra: Partial<ShapeObject> = {},
) {
  const w = t.cols.reduce((s, x) => s + x, 0);
  const h = t.rows.reduce((s, x) => s + x, 0);
  return clampShapeObject({
    id: 'table',
    type: 'shape',
    box: { x: 100, y: 100, w, h, rotation: 0, ...box },
    shape: 'rect',
    opacity: 1,
    radius: 0,
    table: t,
    origin: { src: 'pptx', role: 'table' },
    ...extra,
  });
}

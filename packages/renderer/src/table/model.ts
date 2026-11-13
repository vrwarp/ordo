import {
  type Box,
  type CellStyle,
  type ShapeObject,
  type TableData,
  type TablePlacement,
  type TextObject,
  type TextStyle,
  canonicalJson,
  cellRuns,
  cellStyleEntry,
  cellTextStyle,
  placeCells,
} from '@ordo/domain';
import { digest } from '../digest.ts';

/*
 * A table's model for drawing (design/27 M9 tables): its placement and its resolved cell styles, made once
 * per (clamped) table and memoised by identity. Every reader of a table's cells goes through it: the layout,
 * the drawer, the hit test and the editor's cell view (`cellText`).
 */

export type TableModel = {
  /** The clamped table. */
  readonly t: TableData;
  readonly placement: TablePlacement;
  /** The text box style of each cell style entry (`cellTextStyle`), and of the base alone at the end. */
  readonly styles: readonly TextStyle[];
  /** A digest of each of `styles` with the top anchor the layout uses (part of a cell layout's key). */
  readonly styleKeys: readonly string[];
  /** A digest of the run palette (part of a cell layout's key: runs name its entries by index). */
  readonly runKey: string;
};

const models = new WeakMap<TableData, TableModel>();

/** The model of a clamped table (`clampTable` output), memoised by identity. */
export function tableModelOf(t: TableData): TableModel {
  const hit = models.get(t);
  if (hit) return hit;
  const list = (t.styles ?? []) as CellStyle[];
  const styles = [...list.map((s) => cellTextStyle(t.base, s)), cellTextStyle(t.base, undefined)];
  const m: TableModel = {
    t,
    placement: placeCells(t),
    styles,
    styleKeys: styles.map((s) => digest(canonicalJson({ ...s, valign: 'top' }))),
    runKey: digest(canonicalJson(t.runStyles ?? [])),
  };
  models.set(t, m);
  return m;
}

/** The model of a clamped table shape, or undefined when it has no table. */
export function tableModel(o: ShapeObject): TableModel | undefined {
  return o.table ? tableModelOf(o.table) : undefined;
}

/** The index into `TableModel.styles` of a cell's style: its entry, else the base alone (the last). */
export function cellStyleIndex(m: TableModel, i: number): number {
  const c = m.t.cells[i];
  const e = cellStyleEntry(m.t, c);
  return e && c?.style !== undefined ? c.style : m.styles.length - 1;
}

/** Whether cell `i` asks for vertical text (drawn horizontally until the vertical text engine draws cells). */
export function cellIsVertical(m: TableModel, i: number): boolean {
  const v = cellStyleEntry(m.t, m.t.cells[i])?.vert;
  return v !== undefined && v !== 'horz';
}

/**
 * Cell `i` as the text object it is drawn and edited as, in `box`: the table's base style with the cell's
 * style entry over it (never shrinking), its runs expanded from the run palette, its paragraph styles; the
 * table's opacity. Undefined when there is no such cell. Not clamped: drawers clamp it (`clampTextObject`).
 */
export function cellText(m: TableModel, i: number, box: Box, opacity = 1): TextObject | undefined {
  const c = m.t.cells[i];
  if (!c) return undefined;
  const o: TextObject = {
    id: `cell-${i}`,
    type: 'text',
    box,
    text: c.text ?? '',
    style: m.styles[cellStyleIndex(m, i)]!,
    opacity,
  };
  if (c.runs) o.runs = cellRuns(m.t, c);
  if (c.paras) o.paras = c.paras;
  return o;
}

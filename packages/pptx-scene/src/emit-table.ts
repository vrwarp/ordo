/**
 * Tables as emitted (design/27 §15 M6 tables; split out of `emit.ts` in M9, `conv-seams`).
 *
 * - **Today** (`emitTableOf`): the M6 group of `tables.ts` `emitTable`: locked grid shapes (background, cell
 *   fills, lines) and one rich `TextObject` per cell; the cells' text counts against the slide's text budget
 *   like any other (written plain past it).
 * - **M9** (`emitTableObject`, `tables-conv`): one `ShapeObject.table` (tables-object.md §4) with the legacy
 *   background rect an older build draws, written only when `EmitOptions.m9Writes` has 'table'. Until then
 *   it declines every table, and the M6 group is written.
 *
 * Pure: IR in, ordo objects out.
 */
import type { SlideObject } from '@ordo/domain';
import { chargeText, overText } from './emit-budget.ts';
import { type EmitCtx, legacyColor } from './emit-ctx.ts';
import type { TableElement } from './ir.ts';
import { richText } from './richtext.ts';
import { emitTable } from './tables.ts';

/**
 * The M9 table object of a table (`ShapeObject.table`, `tables-conv`): pushes it on `out` and returns true,
 * or returns false, leaving `out` as it was, when it does not write one (the field is off, or the table is
 * one it cannot store). Stub: declines every table.
 */
export function emitTableObject(_ctx: EmitCtx, _e: TableElement, _out: SlideObject[]): boolean {
  return false;
}

/** A table's objects: the M9 table object when `emitTableObject` writes one, else the M6 group. */
export function emitTableOf(ctx: EmitCtx, e: TableElement, out: SlideObject[]): void {
  if (emitTableObject(ctx, e, out)) return;
  emitTableGroup(ctx, e, out);
}

/**
 * A table as its M6 group (`tables.ts`): its cells' text is rich text in the slide's budget like any other
 * (written plain past it), drawn with the harness's LibreOffice policies when asked; the legacy text
 * emission has no table of its own and writes the same cells.
 */
function emitTableGroup(ctx: EmitCtx, e: TableElement, out: SlideObject[]): void {
  const texts = emitTable(
    {
      frame: ctx.frame,
      newId: ctx.newId,
      log: ctx.log,
      color: legacyColor,
      ...(ctx.lo ? { lo: true } : {}),
      cellText: (body) =>
        richText(body, {
          frame: ctx.frame,
          log: ctx.log,
          ...(ctx.lo ? { lo: true } : {}),
          ...(overText(ctx) ? { plain: true } : {}),
        }),
    },
    e,
    out,
  );
  for (const o of texts) chargeText(ctx, o);
}

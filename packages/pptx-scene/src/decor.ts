/**
 * Decorations (design/27 §15 M9, `budget-decorations.md` §3.3; `decor-conv` fills this): a z-run of
 * text-less shapes of one scope (`ElementBase.decor`: the index of the run's first element, set by the slide
 * budget, `budget.ts`) written as one locked `ShapeObject.decor` whose legacy is an empty line, so a slide
 * past the object budget keeps its decorations natively instead of sending them to the art. Written only
 * when `EmitOptions.m9Writes` has 'decor'.
 *
 * Stub since `conv-seams`: `emitDecor` writes none, so every member is emitted as before (`emit.ts`).
 *
 * Pure.
 */
import type { SlideObject } from '@ordo/domain';
import type { EmitCtx } from './emit-ctx.ts';
import type { Element } from './ir.ts';

/**
 * Write a run of elements (bottom first) as one decoration on `out` and return true, or return false,
 * leaving `out` as it was, when it writes none (the members are then emitted one by one). Stub: none.
 */
export function emitDecor(_ctx: EmitCtx, _run: readonly Element[], _out: SlideObject[]): boolean {
  return false;
}

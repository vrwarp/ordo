import type { Presentation, SlideObject } from '@ordo/domain';
import type { ReactNode } from 'react';

/*
 * The floating bar's bars (design/15 "Object bars"; the floating bar's counterpart of the Object panel's
 * sections, objectSections.ts): FloatingContextBar.tsx shows, over the selection, the one bar that is first by
 * `order` among those that apply to the primary object and that no applying bar replaces. Its built-in bars
 * (`BUILTIN_BARS` there) are a multi-object selection's, a text box's, a plain shape's (not a table, a chart, a
 * decoration or a locked shape: the shape bar writes the legacy fields only an older build draws for those),
 * a picture's and the neutral bar (what the object is, Layer, Duplicate, Delete, More…), which takes every
 * object no other bar claims. M9's editor tracks add theirs with one line in `OBJECT_BARS` (the table's here;
 * a chart's and a decoration's when their tracks register them), and a bar may stand in for built-in ones
 * (`replaces`) for the objects it applies to.
 */

/** What every bar is given, built once per render of the floating bar. */
export interface ObjectBarContext {
  /** The primary selected object. */
  readonly o: SlideObject;
  /** The live lock or a locked object: the bar's fields are disabled (its tail actions follow the lock). */
  readonly off: boolean;
  /** The live lock alone. */
  readonly readOnly: boolean;
  /**
   * Changes the object as one step of the editor's history (`key` merges repeated edits into one step);
   * nothing under the live lock, and only the box (`overridePath` 'box') of a locked object. `overridePath`
   * marks a theme override on a themed lyric box.
   */
  setObj(fn: (x: SlideObject) => SlideObject, key?: string, overridePath?: string | string[]): void;
  /** Ungroup, Layer, Duplicate, Delete and More…: every bar ends with them. */
  readonly tailActions: ReactNode;
  /** The text selection of the box (or table cell) being edited (`EditorState.textRange`). */
  readonly range: { start: number; end: number };
  readonly slideId: string;
  readonly draft: Presentation;
  /** How many objects are selected (the multi-object bar's count). */
  readonly count: number;
}

export interface ObjectBar {
  /** Unique; the built-ins' are the keys of `OBJECT_BAR_ORDER`. */
  readonly id: string;
  /** Where it ranks: the first applying bar by order shows; equal orders keep their listing order. */
  readonly order: number;
  /** Which selections it is for: one object (the default) or several. */
  readonly selection?: 'one' | 'many';
  /** Whether it shows for `o`, the primary selected object. */
  applies(o: SlideObject): boolean;
  /** Built-in bars it stands in for, for the objects it applies to. */
  readonly replaces?: readonly string[];
  /** The bar, rendered as a component (it may hold state of its own). */
  readonly Component: (c: ObjectBarContext) => ReactNode;
}

/** The built-in bars' ranks (FloatingContextBar.tsx). The neutral bar is last: it applies to everything. */
export const OBJECT_BAR_ORDER = {
  multi: 100,
  text: 200,
  shape: 300,
  picture: 400,
  neutral: 10_000,
} as const;

export type BuiltinBarId = keyof typeof OBJECT_BAR_ORDER;

/** Bars the M9 editor tracks add, one line each. */
export const OBJECT_BARS: readonly ObjectBar[] = [];

const registered: ObjectBar[] = [];

/** Add a bar at run time (tests, a plugin of the editor); returns its removal. */
export function registerObjectBar(b: ObjectBar): () => void {
  registered.push(b);
  return () => {
    const i = registered.indexOf(b);
    if (i >= 0) registered.splice(i, 1);
  };
}

/**
 * The bar the floating bar shows for primary object `o` (`many`: several objects are selected): among the
 * built-ins, `OBJECT_BARS` and the registered bars for that kind of selection that apply to `o`, without those
 * an applying bar replaces, the first by order (stable). Undefined only when no bar applies, which the
 * built-ins' neutral bar rules out.
 */
export function objectBarFor(
  o: SlideObject,
  many: boolean,
  builtins: readonly ObjectBar[],
): ObjectBar | undefined {
  const want = many ? 'many' : 'one';
  const all = [...builtins, ...OBJECT_BARS, ...registered].filter(
    (b) => (b.selection ?? 'one') === want && b.applies(o),
  );
  const replaced = new Set(all.flatMap((b) => b.replaces ?? []));
  return all
    .filter((b) => !replaced.has(b.id))
    .map((b, i) => ({ b, i }))
    .sort((p, q) => p.b.order - q.b.order || p.i - q.i)
    .map((x) => x.b)[0];
}

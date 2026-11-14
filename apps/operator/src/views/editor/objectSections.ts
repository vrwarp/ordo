import type { Presentation, Slide, SlideObject } from '@ordo/domain';
import type { ReactNode } from 'react';

/*
 * The Object panel's sections (design/27 M9 render-seams; design/15): the panel (ObjectPanel.tsx) renders its
 * built-in sections and every section listed or registered here, by `order`, each only for the objects it
 * applies to. M9's editor tracks add theirs (a table's cells, a chart's titles, a decoration's paints, a warp's
 * preset, a 3-D look's line, the locked OLE, ink and maths label) with one line in `OBJECT_SECTIONS`, and a
 * section may stand in for built-in ones (`replaces`) for the objects it applies to.
 */

/** What every section is given, built once per render of the panel. */
export interface ObjectSectionContext {
  readonly o: SlideObject;
  /** The live lock or a locked object (design/27 §11 "Locked objects"): every field but the box read-only. */
  readonly readOnly: boolean;
  /** The live lock alone: a locked object's box stays editable. */
  readonly liveLocked: boolean;
  readonly locked: boolean;
  readonly slideId: string;
  readonly slide: Slide | undefined;
  readonly draft: Presentation;
  /** The slide's lyric box (its `lyricObjectId`, else its first text object). */
  readonly isLyric: boolean;
  /** The lyric box of a themed presentation: style and box edits mark theme overrides. */
  readonly themed: boolean;
  /** The slide's theme overrides (`Slide.overrides`). */
  readonly marks: ReadonlySet<string>;
  /**
   * Changes the object as one step of the editor's history (`key` merges typing into one step); nothing
   * under the live lock, and only the box (`overridePath` 'box') of a locked object. `overridePath` marks
   * a theme override on a themed lyric box (several for a choice that sets several fields: a contrast
   * choice sets both `style.outline` and `style.shadow`).
   */
  set(fn: (x: SlideObject) => SlideObject, key?: string, overridePath?: string | readonly string[]): void;
}

export interface ObjectSection {
  /** Unique; the built-ins' are the keys of `OBJECT_SECTION_ORDER`. */
  readonly id: string;
  /** Where it goes: the built-ins sit at `OBJECT_SECTION_ORDER`; equal orders keep their listing order. */
  readonly order: number;
  /** Whether it shows for `o`. */
  applies(o: SlideObject): boolean;
  /** Built-in sections it stands in for, for the objects it applies to. */
  readonly replaces?: readonly string[];
  /** The section, rendered as a component (it may hold state of its own). */
  readonly Component: (c: ObjectSectionContext) => ReactNode;
}

/** The built-in sections, in the panel's order (ObjectPanel.tsx). */
export const OBJECT_SECTION_ORDER = {
  heading: 100,
  notes: 200,
  text: 300,
  placement: 350,
  box: 400,
  opacity: 500,
  textStyle: 600,
  picture: 700,
  video: 800,
  slideOps: 900,
  shape: 1000,
} as const;

export type BuiltinSectionId = keyof typeof OBJECT_SECTION_ORDER;

/** Sections the M9 editor tracks add, one line each (none yet). */
export const OBJECT_SECTIONS: readonly ObjectSection[] = [];

const registered: ObjectSection[] = [];

/** Add a section at run time (tests, a plugin of the editor); returns its removal. */
export function registerObjectSection(s: ObjectSection): () => void {
  registered.push(s);
  return () => {
    const i = registered.indexOf(s);
    if (i >= 0) registered.splice(i, 1);
  };
}

/**
 * The sections the panel renders for `o`: the built-ins, `OBJECT_SECTIONS` and the registered ones that apply
 * to it, without those an applying section replaces, by order (stable).
 */
export function objectSectionsFor(o: SlideObject, builtins: readonly ObjectSection[]): ObjectSection[] {
  const all = [...builtins, ...OBJECT_SECTIONS, ...registered].filter((s) => s.applies(o));
  const replaced = new Set(all.flatMap((s) => s.replaces ?? []));
  return all
    .filter((s) => !replaced.has(s.id))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.order - b.s.order || a.i - b.i)
    .map((x) => x.s);
}

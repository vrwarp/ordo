/**
 * One LibreOffice policy rule of `--lo-compat` (`index.ts` lists them all): its name, what it changes for the
 * report, and the scene elements it touches. Each rule lives in a file of its own, so an M9 track adds its
 * rule (`flat3d`, `warpRuns`, `vertLo`, `mirrorTurn`, `chartLo`, …) as a file plus one line in `index.ts`.
 */
import type { DeckScene, Para, TextBody } from '@ordo/pptx-scene';

export type SceneSlide = DeckScene['slides'][number];
export type SceneElement = SceneSlide['elements'][number];

export type CompatRuleDef<K extends string = string> = {
  /** The rule's name in `summary.json` (`perSlide.compat`) and the report. */
  readonly key: K;
  /** What LibreOffice does that ordo does not, for the report. */
  readonly text: string;
  /**
   * Whether this element of the slide's scene IR (groups are flattened: every text body is a shape's or a
   * table cell's) is one the rule changes. The harness keeps a slide's rules only when its two drawings
   * differ (`drawingKey`), so a rule may say yes to more than it changes.
   */
  hits(e: SceneElement, slide: SceneSlide): boolean;
};

/** A rule, typed by its key (so `index.ts` derives the `CompatRule` union from the registry). */
export const compatRule = <const K extends string>(r: CompatRuleDef<K>): CompatRuleDef<K> => r;

const visiblePara = (p: Para) => p.runs.some((r) => r.kind !== 'break' && r.text.trim() !== '');

/** A text body's runs that draw something (the end mark only sizes an empty paragraph). */
export function visibleRuns(t: TextBody): TextBody['paras'][number]['runs'] {
  return t.paras.flatMap((p) => p.runs.filter((r) => r.kind !== 'break' && r.text.trim() !== ''));
}

/** Whether a text body shows any text: a rule counts only where it touches such a body. */
export const hasVisibleText = (t: TextBody): boolean => t.paras.some(visiblePara);

/** The text body of a shape element that shows text, else undefined. */
export function shapeText(e: SceneElement): TextBody | undefined {
  return e.kind === 'shape' && e.text && hasVisibleText(e.text) ? e.text : undefined;
}

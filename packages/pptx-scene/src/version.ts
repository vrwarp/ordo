/**
 * What this converter is (design/27 §15 M9, the regroup's import core): its version and the stored M9 fields
 * it writes. One definition, read by every place that parses a deck (the hub's pool task, the client parse
 * in the operator and the Pages demo, the fidelity harness), so a scene parsed in a browser and the hub that
 * stores it can only agree or tell that they do not.
 */
import { ALL_M9_FIELDS, type M9Field } from './emit-ctx.ts';

/**
 * The converter version written to `Slide.pptx.version`, `source.native.version` and a client scene
 * (`PptxClientScene.version`). 2 since M9 (design/27 §15 M9, decisions.md 1): the converter that writes the
 * M9 fields (`M9_WRITES`) and draws 3-D flat. A hub uses a client scene only from its own version.
 */
export const CONVERTER_VERSION = 2;

/**
 * M9 fields that stay off until what reads them is on main (design/27 §15 M9 "Rollout"): 'decor' until
 * `decor-render` registers the decoration drawer (a `ShapeObject.decor` draws its legacy empty line until
 * then: the shapes would vanish), and 'decorFile' until it names decoration files (the import core's
 * `nameShapeFiles` decoration hook, `SHAPE_FILE_KINDS`), so no `pptxdecor:<n>` placeholder is ever stored.
 */
export const M9_HELD_BACK: ReadonlySet<M9Field> = new Set<M9Field>(['decor', 'decorFile']);

/**
 * The stored M9 fields an import writes (design/27 §15 M9 decision 13; the regroup's rollout rule), passed
 * to the converter as `EmitOptions.m9Writes` by every caller, and to its parse (`ParseOptions.m9Writes`), so
 * the slide budgets plan only what is written. The kill switch of the M9 rollout, per field: take one out and
 * the import writes what an older build draws for it instead (§3.2), so a field found wrong can be withheld
 * without a release of the drawers. Every field but `M9_HELD_BACK`. A client scene records the fields it
 * wrote (`PptxClientScene.m9Writes`); a hub that writes others parses the deck itself.
 */
export const M9_WRITES: ReadonlySet<M9Field> = new Set(
  [...ALL_M9_FIELDS].filter((f) => !M9_HELD_BACK.has(f)),
);

/**
 * Whether an import draws pictures from sheets (`EmitOptions.sheets`: `pptxmedia:sheet<n>` composites and
 * atlases), on the hub and in a client parse. False until `decor-render` stores sheets on both paths: an
 * unresolved sheet placeholder would drop its pictures without a word. Without sheets every picture is its
 * own object, and the slide budgets leave the topmost past the render clamp's 16 out and list them
 * (`budget.ts` `BudgetOptions`).
 */
export const PPTX_SHEETS = false;

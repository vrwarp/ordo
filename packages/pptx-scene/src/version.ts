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
 * The stored M9 fields an import writes (design/27 §15 M9 decision 13; the regroup's rollout rule), passed
 * to the converter as `EmitOptions.m9Writes` by every caller. A kill switch per field: take one out and the
 * import writes what an older build draws for it instead (§3.2), so a field found wrong can be withheld
 * without a release of the drawers. A field stays out until what reads it is in: 'decorFile' until
 * `decor-render` names decoration files (the import core's `nameShapeFiles` decoration hook), so no
 * `pptxdecor:<n>` placeholder is ever stored; a decoration keeps its parts in the slide. A client scene
 * records the fields it wrote (`PptxClientScene.m9Writes`); a hub that writes others parses the deck itself.
 */
export const M9_WRITES: ReadonlySet<M9Field> = new Set([...ALL_M9_FIELDS].filter((f) => f !== 'decorFile'));

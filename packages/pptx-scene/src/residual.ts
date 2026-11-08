/**
 * The residual decision table (design/27 §5 "Element support", §15 M9): for every reason an element is rated
 * by, whether ordo draws it natively, draws an approximation, leaves it to the residual path or does not read
 * it at all, and what a hub without LibreOffice records for a residual one (`Slide.pptx.missing`).
 *
 * - **One row per reason**, as the classifier and the readers write it in `ElementBase.reasons` (and the
 *   census as `art:<reason>`): `classify.ts` rates an element's XML by the rows it decides (`by: 'classify'`),
 *   the readers set their own verdicts (`by: 'reader'`: `walk.ts`, `picture.ts`, `tables.ts`,
 *   `smartart.ts`) and the slide's budgets theirs (`by: 'budget'`); their rows are here so the table is
 *   complete and the report can name each reason. A reason ending in `:*` is a family (`preset:star5`).
 * - **Census features.** Each row lists the census features it is a case of (`classify.ts`
 *   `FALLBACK_FEATURES`, the tier blockers). Tiers measure feature use whatever ordo draws, so the features
 *   and tiers never change with a decision; every `FALLBACK_FEATURES` entry has a row.
 * - **Residual** elements go to the art of a hybrid slide when LibreOffice is there; without it
 *   (`EmitOptions.libreoffice: false`, `hybrid.ts`) they are recorded by their `missing` kind
 *   (`@ordo/domain` `MISSING_KINDS`). `unread` elements are not in the IR at all (nothing draws them, with
 *   or without LibreOffice).
 * - **Changing a decision** is changing a row (the M9 areas each own theirs: tables, charts, SmartArt, OLE
 *   and pictures, warps, vertical text and `anchorCtr`); `residual.test.ts` pins every other row.
 *
 * M9 wave 1 changes one row from the base: real 3-D (`3d`, `3d:camera`) is approx, drawn flat, never
 * residual (`3d.md` §3.1: LibreOffice draws 63 of the 68 `art:3d` slides flat too). Only on a slide past the
 * object budget does it still go to the art first (`budget:3d`, as all real 3-D did before), so the budget's
 * other steps choose as they did; version 1 draws it flat meanwhile, and for good without LibreOffice
 * (`drawn`: nothing is missing).
 *
 * M9 wave 2 (`decor-conv`): the slide budgets send nothing to the art (`budget.ts`: decorations,
 * composites, an atlas instead), so the `budget:*` rows are written only behind `ParseOptions.budgetArt`
 * (the harness's A/B), and `3d:flat-in-decoration` (approx) marks real 3-D drawn flat inside a decoration.
 * Nothing goes to the art for being slow to draw (decisions.md "Slow-to-draw elements"): `custGeom:complex`
 * and `geom:complex` are native, kept whole and drawn from the slide's decoration plate, and no longer
 * written.
 *
 * Pure: tables and lookups; deck strings are only compared, never used as object keys.
 */
import type { MissingKind } from '@ordo/domain';
import type { Support } from './ir.ts';

/** What ordo does with an element rated by a reason. */
export type Decision = Support | 'unread';

export interface ResidualRow {
  /** The reason as `ElementBase.reasons` holds it; `prefix:*` stands for every reason with that prefix. */
  reason: string;
  /** The census features (`featuresOf`, `FALLBACK_FEATURES`, the tier blockers) it is a case of. */
  features: readonly string[];
  decision: Decision;
  /** Residual or unread: what a hub without LibreOffice records for the element (`Slide.pptx.missing`). */
  missing?: MissingKind;
  /**
   * Residual, but version 1 draws the element as ordo draws it within the budgets (real 3-D past the object
   * budget: flat, as approx 3-D is): the art only improves on it, so a hub without LibreOffice records
   * nothing for it (`drawnWithoutArt`) and has no `missing` kind for it.
   */
  drawn?: true;
  /** Who rates it: the classifier from the element's XML, the reader's own verdict, or a slide budget. */
  by: 'classify' | 'reader' | 'budget';
  /** What ordo does, in a few words. */
  note: string;
}

/** The decision table, by reason. */
export const RESIDUAL_ROWS: readonly ResidualRow[] = [
  // ── Graphic frames ──
  {
    reason: 'table',
    features: ['table'],
    decision: 'residual',
    missing: 'element',
    by: 'reader',
    note: 'a table tables.ts cannot read (no grid); one it reads is native',
  },
  {
    reason: 'budget:table',
    features: ['table'],
    decision: 'residual',
    missing: 'element',
    by: 'budget',
    note: "a table of more objects than the slide's budget (M9: only behind ParseOptions.budgetArt, the harness's A/B)",
  },
  {
    reason: 'chart',
    features: ['chart'],
    decision: 'residual',
    missing: 'chart',
    by: 'classify',
    note: 'a chart frame',
  },
  {
    reason: 'smartart',
    features: ['smartart'],
    decision: 'residual',
    missing: 'smartart',
    by: 'reader',
    note: 'SmartArt without a drawing cache, or a drawing the art takes part of (whole)',
  },
  {
    reason: 'budget:smartart',
    features: ['smartart'],
    decision: 'residual',
    missing: 'smartart',
    by: 'budget',
    note: "a SmartArt drawing of more objects than the slide's budget (M9: only behind ParseOptions.budgetArt)",
  },
  {
    reason: 'ole',
    features: ['ole'],
    decision: 'residual',
    missing: 'ole',
    by: 'classify',
    note: 'an embedded OLE object',
  },
  {
    reason: 'graphicFrame',
    features: [],
    decision: 'residual',
    missing: 'element',
    by: 'classify',
    note: 'any other graphic frame',
  },
  // ── In a shape's XML ──
  {
    reason: '3d',
    features: ['3d'],
    decision: 'approx',
    by: 'classify',
    note: 'a real bevel or extrusion (M9: drawn flat)',
  },
  {
    reason: '3d:camera',
    features: ['3d'],
    decision: 'approx',
    by: 'classify',
    note: 'real 3-D seen through a turned camera (M9: drawn flat, untilted)',
  },
  {
    reason: 'budget:3d',
    features: ['3d'],
    decision: 'residual',
    drawn: true,
    by: 'budget',
    note: 'real 3-D on a slide past the object budget: to the art first, drawn flat until then and for good without LibreOffice (M9: only behind ParseOptions.budgetArt)',
  },
  {
    reason: 'math',
    features: ['math'],
    decision: 'residual',
    missing: 'math',
    by: 'classify',
    note: 'an equation (a14:m, m:oMath)',
  },
  {
    reason: 'ink',
    features: ['ink'],
    decision: 'unread',
    missing: 'ink',
    by: 'reader',
    note: 'p:contentPart is not read: nothing draws it',
  },
  {
    reason: 'reflection',
    features: ['reflection'],
    decision: 'approx',
    by: 'classify',
    note: 'drawn without its reflection',
  },
  {
    reason: 'innerShdw',
    features: ['innerShdw'],
    decision: 'approx',
    by: 'classify',
    note: 'drawn without its inner shadow',
  },
  {
    reason: 'softEdge',
    features: ['softEdge'],
    decision: 'approx',
    by: 'classify',
    note: "a picture's soft edge (a shape's is drawn)",
  },
  // ── Text bodies ──
  {
    reason: 'warp',
    features: ['warp'],
    decision: 'residual',
    missing: 'element',
    by: 'classify',
    note: 'WordArt warped text (version 1 draws it plain)',
  },
  {
    reason: 'vert',
    features: ['vert'],
    decision: 'residual',
    missing: 'element',
    by: 'classify',
    note: 'vertical text (version 1 draws it in the turned box); a table cell too',
  },
  {
    reason: 'numCol',
    features: [],
    decision: 'residual',
    missing: 'element',
    by: 'classify',
    note: 'text in columns',
  },
  {
    reason: 'anchorCtr',
    features: [],
    decision: 'residual',
    missing: 'element',
    by: 'classify',
    note: 'a centred text block that moves text',
  },
  // ── Pictures ──
  {
    reason: 'metafile',
    features: ['pic:emf', 'pic:wmf'],
    decision: 'approx',
    missing: 'metafile',
    by: 'reader',
    note: 'EMF, WMF (and EMZ, WMZ, PICT): converted by LibreOffice in the follow-up',
  },
  {
    reason: 'pic:tif',
    features: ['pic:tif'],
    decision: 'approx',
    by: 'reader',
    note: 'prepared by the hub',
  },
  {
    reason: 'pic:tiff',
    features: ['pic:tiff'],
    decision: 'approx',
    by: 'reader',
    note: 'prepared by the hub',
  },
  {
    reason: 'pic:jxr',
    features: [],
    decision: 'approx',
    by: 'reader',
    note: 'prepared by the hub',
  },
  {
    reason: 'pic:wdp',
    features: ['pic:wdp'],
    decision: 'residual',
    missing: 'element',
    by: 'classify',
    note: 'an HD Photo picture',
  },
  {
    reason: 'pic:hdp',
    features: ['pic:hdp'],
    decision: 'residual',
    missing: 'element',
    by: 'classify',
    note: 'an HD Photo picture',
  },
  {
    reason: 'mask:*',
    features: [],
    decision: 'approx',
    by: 'reader',
    note: 'a picture clipped to an unknown preset: drawn as a rect',
  },
  {
    reason: 'recolor',
    features: ['recolor'],
    decision: 'approx',
    by: 'reader',
    note: 'colour effects no bake reproduces',
  },
  // ── Geometry ──
  {
    reason: 'custGeom',
    features: ['custGeom'],
    decision: 'residual',
    missing: 'decoration',
    by: 'reader',
    note: 'custom geometry past the bounds',
  },
  {
    reason: 'custGeom:complex',
    features: ['custGeom'],
    decision: 'native',
    by: 'reader',
    note: "custom geometry past the slide's drawing budget: kept whole, drawn from the slide's decoration plate (M9; no longer written)",
  },
  {
    reason: 'geom:complex',
    features: [],
    decision: 'native',
    by: 'reader',
    note: "a preset past the slide's drawing budget: kept whole, drawn from the slide's decoration plate (M9; no longer written)",
  },
  {
    reason: 'preset:*',
    features: ['preset:other'],
    decision: 'approx',
    by: 'reader',
    note: 'a preset the table does not know: drawn as its rect',
  },
  {
    reason: 'pattFill',
    features: ['pattFill'],
    decision: 'approx',
    by: 'reader',
    note: 'a pattern drawn as its blended colour',
  },
  {
    reason: 'shear',
    features: [],
    decision: 'approx',
    by: 'reader',
    note: 'a child of an unevenly scaled group, placed as LibreOffice places it',
  },
  {
    reason: 'tableDiagonal',
    features: ['table'],
    decision: 'approx',
    by: 'reader',
    note: "a table cell's diagonal line",
  },
  {
    reason: 'budget:shapes',
    features: [],
    decision: 'residual',
    missing: 'decoration',
    by: 'budget',
    note: "shapes and pictures past the slide's object budget (M9: only behind ParseOptions.budgetArt)",
  },
  {
    reason: '3d:flat-in-decoration',
    features: ['3d'],
    decision: 'approx',
    by: 'budget',
    note: 'real 3-D drawn flat inside a decoration, on a slide past the object budget with every other step taken (M9, plan decision 6)',
  },
];

const EXACT: ReadonlyMap<string, ResidualRow> = new Map(
  RESIDUAL_ROWS.filter((r) => !r.reason.endsWith(':*')).map((r) => [r.reason, r]),
);
const FAMILIES: readonly ResidualRow[] = RESIDUAL_ROWS.filter((r) => r.reason.endsWith(':*'));

/** The row of a reason (exact, else its `prefix:*` family), or undefined when the table has none. */
export function rowOf(reason: string): ResidualRow | undefined {
  const exact = EXACT.get(reason);
  if (exact) return exact;
  for (const r of FAMILIES) if (reason.startsWith(r.reason.slice(0, -1))) return r;
  return undefined;
}

/** The decision for a reason; `fallback` for a reason the table has no row for. */
export function decisionOf(reason: string, fallback: Decision = 'residual'): Decision {
  return rowOf(reason)?.decision ?? fallback;
}

/**
 * What a hub without LibreOffice records for an element left residual with these reasons: the `missing`
 * kind of its first reason that has one, `element` otherwise.
 */
export function missingKindOf(reasons: readonly string[] | undefined): MissingKind {
  for (const r of reasons ?? []) {
    const kind = rowOf(r)?.missing;
    if (kind) return kind;
  }
  return 'element';
}

/**
 * Whether version 1 draws an element left residual with these reasons as ordo draws it within the budgets
 * (`ResidualRow.drawn`: real 3-D past the object budget, drawn flat): some reason is such a row, and no other
 * reason leaves it to the art (residual, unread, or a reason the table has no row for). A hub without
 * LibreOffice records nothing for it.
 */
export function drawnWithoutArt(reasons: readonly string[] | undefined): boolean {
  let drawn = false;
  for (const r of reasons ?? []) {
    const row = rowOf(r);
    if (row?.drawn) drawn = true;
    else if (!row || row.decision === 'residual' || row.decision === 'unread') return false;
  }
  return drawn;
}

/** The census features some row decides (every `FALLBACK_FEATURES` entry among them). */
export function decidedFeatures(): Set<string> {
  const out = new Set<string>();
  for (const r of RESIDUAL_ROWS) for (const f of r.features) out.add(f);
  return out;
}

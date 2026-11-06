/*
 * DrawingML shape geometry (design/27 §1 geom/, §15 M6; README.md here): the preset table compiled from
 * POI, the compiler for a deck's custGeom and the guide evaluator. Not yet re-exported by `@ordo/renderer`:
 * the drawers and the converter take it up in the next wave (`@ordo/renderer/geom/index.ts` until then).
 */
export {
  asciiTrim,
  builtinSlot,
  compileGeom,
  finiteValue,
  formulaTokens,
  type GeomNotes,
  type GeomSource,
  type GuidePairs,
  type HandleSource,
  newGeomNotes,
  numberToken,
  type PathCmdSource,
  type PathSource,
  type SiteSource,
} from './compile.ts';
export {
  type AdjustPairs,
  applyOp,
  evalGuideLists,
  evalGuides,
  type GuideBox,
  type GuideScope,
  guideSlot,
  guideValue,
  guideValues,
  writeBuiltins,
} from './eval.ts';
export * from './ops.ts';
export { PRESET_GEOMS } from './presets.gen.ts';

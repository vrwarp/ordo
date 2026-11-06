/*
 * DrawingML shape geometry (design/27 §1 geom/, §15 M6; README.md here): the preset table compiled from
 * POI, the compiler for a deck's custGeom, the guide evaluator, the path builder and the Canvas 2D drawer.
 * `@ordo/renderer` re-exports the drawing API (presetGeometry, customGeometry, buildGeom, drawGeom and their
 * types); the compiler and evaluator are here for the converter and tools.
 */
export { ARC_MAX_SEGMENTS, arcParamAngle, arcToCubics } from './arc.ts';
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
export {
  CLOSED_TOLERANCE,
  drawGeom,
  FILL_BRIGHTNESS,
  GEOM_FILL_RULE,
  type GeomFill,
  geomFillPath2D,
  geomPath2D,
  geomPathOpen,
  type GeomStroke,
  type GeomStyle,
  type PathSink,
  shadeRgba,
  traceGeomPath,
} from './draw.ts';
export * from './ops.ts';
export {
  type BuiltGeom,
  buildGeom,
  COORD_LIMIT,
  type CustomGeom,
  customGeometry,
  type GeomPath,
  type GeomRect,
  type GeomSite,
  hasPreset,
  pathData,
  pathPoints,
  presetGeometry,
} from './path.ts';
export { PRESET_GEOMS } from './presets.gen.ts';

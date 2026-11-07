/*
 * DrawingML shape geometry (design/27 §1 geom/, §15 M6; README.md here): the preset table compiled from
 * POI, the compiler for a deck's custGeom, the guide evaluator, the path builder, the Canvas 2D drawer, line
 * ends, gradients and stored geometries (ShapeGeom). `@ordo/renderer` re-exports all of it.
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
  GEOM_CLIP_RULE,
  GEOM_FILL_RULE,
  type GeomFill,
  geomFillPath2D,
  geomPath2D,
  geomPathOpen,
  type GeomSpacePaint,
  type GeomStroke,
  type GeomStyle,
  type PathSink,
  shadeRgba,
  traceGeomPath,
  traceUnionPath,
  UNION_NESTING_LIMIT,
} from './draw.ts';
export {
  ARROW_MIN_BASE,
  type ArrowKind,
  type ArrowSize,
  arrowCentred,
  arrowFor,
  arrowReach,
  type EndedPath,
  type GeomArrow,
  type GeomEnds,
  withEnds,
} from './ends.ts';
export { gradientStyle } from './paint.ts';
export { clampPoints, drawWeight, GEOM_COST, geomCost, unitCost } from './cost.ts';
export {
  clearGeomFiles,
  GEOM_FILE_RETRY_MS,
  GEOM_FILES_CHARS,
  GEOM_FILES_MAX,
  type GeomFileRead,
  geomAwaited,
  geomFile,
  geomFilesVersion,
  geomPending,
  legacyGeometry,
  putGeomFile,
  readGeomFiles,
  resolvedGeom,
  type StoredCost,
  storedCost,
  storedGeometry,
  storedPath,
} from './stored.ts';
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

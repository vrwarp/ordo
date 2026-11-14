/*
 * The closed name lists of PowerPoint 3-D (`Look3d`, design/27 M9): ECMA-376 Part 1 §20.1.10 enumerations,
 * in the standard's order. A stored name outside a list takes the schema's `.catch` default, so a deck or a
 * later build can never put an arbitrary string where a renderer looks a preset up (the renderer's preset
 * tables are arrays and Maps over these names, never objects keyed by a stored string).
 */

/** ST_PresetCameraType: the 62 cameras (`a:scene3d/a:camera prst`). */
export const CAMERA_PRESETS = [
  'legacyObliqueTopLeft',
  'legacyObliqueTop',
  'legacyObliqueTopRight',
  'legacyObliqueLeft',
  'legacyObliqueFront',
  'legacyObliqueRight',
  'legacyObliqueBottomLeft',
  'legacyObliqueBottom',
  'legacyObliqueBottomRight',
  'legacyPerspectiveTopLeft',
  'legacyPerspectiveTop',
  'legacyPerspectiveTopRight',
  'legacyPerspectiveLeft',
  'legacyPerspectiveFront',
  'legacyPerspectiveRight',
  'legacyPerspectiveBottomLeft',
  'legacyPerspectiveBottom',
  'legacyPerspectiveBottomRight',
  'orthographicFront',
  'isometricTopUp',
  'isometricTopDown',
  'isometricBottomUp',
  'isometricBottomDown',
  'isometricLeftUp',
  'isometricLeftDown',
  'isometricRightUp',
  'isometricRightDown',
  'isometricOffAxis1Left',
  'isometricOffAxis1Right',
  'isometricOffAxis1Top',
  'isometricOffAxis2Left',
  'isometricOffAxis2Right',
  'isometricOffAxis2Top',
  'isometricOffAxis3Left',
  'isometricOffAxis3Right',
  'isometricOffAxis3Bottom',
  'isometricOffAxis4Left',
  'isometricOffAxis4Right',
  'isometricOffAxis4Bottom',
  'obliqueTopLeft',
  'obliqueTop',
  'obliqueTopRight',
  'obliqueLeft',
  'obliqueRight',
  'obliqueBottomLeft',
  'obliqueBottom',
  'obliqueBottomRight',
  'perspectiveFront',
  'perspectiveLeft',
  'perspectiveRight',
  'perspectiveAbove',
  'perspectiveBelow',
  'perspectiveAboveLeftFacing',
  'perspectiveAboveRightFacing',
  'perspectiveContrastingLeftFacing',
  'perspectiveContrastingRightFacing',
  'perspectiveHeroicLeftFacing',
  'perspectiveHeroicRightFacing',
  'perspectiveHeroicExtremeLeftFacing',
  'perspectiveHeroicExtremeRightFacing',
  'perspectiveRelaxed',
  'perspectiveRelaxedModerately',
] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

/** ST_LightRigType: the 27 light rigs (`a:scene3d/a:lightRig rig`). */
export const LIGHT_RIGS = [
  'legacyFlat1',
  'legacyFlat2',
  'legacyFlat3',
  'legacyFlat4',
  'legacyNormal1',
  'legacyNormal2',
  'legacyNormal3',
  'legacyNormal4',
  'legacyHarsh1',
  'legacyHarsh2',
  'legacyHarsh3',
  'legacyHarsh4',
  'threePt',
  'balanced',
  'soft',
  'harsh',
  'flood',
  'contrasting',
  'morning',
  'sunrise',
  'sunset',
  'chilly',
  'freezing',
  'flat',
  'twoPt',
  'glow',
  'brightRoom',
] as const;
export type LightRig = (typeof LIGHT_RIGS)[number];

/** ST_LightRigDirection: where a rig's key light comes from (`a:lightRig dir`). */
export const LIGHT_DIRECTIONS = ['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'] as const;
export type LightDirection = (typeof LIGHT_DIRECTIONS)[number];

/** ST_PresetMaterialType: the 15 materials (`a:sp3d prstMaterial`). */
export const MATERIALS = [
  'legacyMatte',
  'legacyPlastic',
  'legacyMetal',
  'legacyWireframe',
  'matte',
  'plastic',
  'metal',
  'warmMatte',
  'translucentPowder',
  'powder',
  'dkEdge',
  'softEdge',
  'clear',
  'flat',
  'softmetal',
] as const;
export type Material = (typeof MATERIALS)[number];

/** ST_BevelPresetType: the 12 bevels (`a:bevelT prst`, `a:bevelB prst`). */
export const BEVEL_PRESETS = [
  'circle',
  'relaxedInset',
  'cross',
  'coolSlant',
  'angle',
  'softRound',
  'convex',
  'slope',
  'divot',
  'riblet',
  'hardEdge',
  'artDeco',
] as const;
export type BevelPresetName = (typeof BEVEL_PRESETS)[number];

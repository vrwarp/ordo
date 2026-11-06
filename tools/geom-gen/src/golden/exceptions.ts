/*
 * Presets allowed under MIN_SSIM in the preset golden (design/27 §15 M6 exit: "except listed ones, each with its
 * reason"), by name. Each reason says what differs and why the difference is LibreOffice's, not the engine's.
 * score.test.ts checks that this lists exactly the presets under the bar in baseline.json.
 */
export const EXCEPTIONS: Readonly<Record<string, string>> = {
  funnel:
    "LibreOffice's own preset table (oox-drawingml-cs-presets, made from the ECMA presets) reads the guide name " +
    '2da in swAng1 (+- cd2 2da 0) and swAng3 (+- cd2 0 2da) as the number 2: its rim arc sweeps 180° instead of ' +
    "180° + 2·da and stops above the rim's widest point, and the cone's lower arc sweeps 180° instead of 180° − 2·da. " +
    'The spec defines 2da as a guide, and POI reads it so (as this engine does). Drawn with 2 for 2da, the funnel ' +
    "scores 0.9987 against LibreOffice's.",
};

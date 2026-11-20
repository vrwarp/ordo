/*
 * Warps whose LibreOffice text lies outside their ECMA-376 hull (the geometry leg of `golden:warps`), by name, each
 * with its reason: what differs and why the difference is LibreOffice's, not the shapes'. warps-score.ts fails a run
 * when an unlisted warp is outside its hull and when a listed one is not outside it in the baseline;
 * warps-baseline.test.ts checks that this lists exactly the warps outside their hull in warp-baseline.json.
 *
 * The shapes follow ECMA-376, which is what PowerPoint draws (r2b sub-wave 2, OQ-WG1): LibreOffice draws its own shapes
 * for these five, so part 3's WordArt fidelity check names them as exceptions beside this list. Nothing here is a deck's
 * text: the probe deck is ordo's own.
 */
export const WARP_EXCEPTIONS: Readonly<Record<string, string>> = {
  textArchUp:
    "LibreOffice puts the line of text on the outside of the curve: the ink of the arch rides above the arch's own " +
    'path (up to 37 px above the top of the box and 18 px beyond its left side at 360 x 240), where ECMA-376 puts the text ' +
    "on the path itself. The hull is the arch's own points, so the ink lies outside it at all three boxes.",
  textArchDown:
    "LibreOffice puts the line of text on the outside of the curve: the ink of the bowl hangs below the bowl's own " +
    'path (up to 21 px below the bottom of the box at 360 x 240), where ECMA-376 puts the text on the path itself. ' +
    'The ink lies outside the hull at all three boxes.',
  textCircle:
    'LibreOffice puts the line of text on the outside of the curve: the ink of the circle starts on the right of the ' +
    "circle's top and reaches past the circle on every side but the left (up to 31 px above the top of the box), " +
    'where ECMA-376 puts the text on the path itself. The ink lies outside the hull at all three boxes.',
  textButton:
    "A one-line text sits in the first of Button's three areas, which is the arch above the button: LibreOffice's ink " +
    "equals Arch Up's, to the pixel, at all three boxes, so it lies on the outside of that curve, outside the hull of " +
    'the whole shape. The text of the other two areas (the line and the bowl) is not drawn by a one-line text.',
  textInflateTop:
    "LibreOffice's text reaches the top of the box at all three boxes, while ECMA-376's top path peaks " +
    '(40,000 / 100,000) / 2 of the height below it (48 px at 240): its ink lies above the hull by that much. ' +
    "LibreOffice's own shape for this warp differs from the ECMA-376 one at the top.",
};

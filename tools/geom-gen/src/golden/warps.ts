import { EMU_PER_PX, type ProbeShape, probeDeck, SLIDE_H, SLIDE_W } from './probe.ts';

/*
 * The warp probe's deck (the geometry leg of `golden:warps`, r2b sub-wave 2): one text box per WordArt warp at its
 * default adjust values, so LibreOffice's drawing of the text can be measured against ordo's hull of the warp. Every
 * box holds the same text in the same face, with no fill and no outline, so only the text's ink is drawn:
 * "WordArt Ag" in Liberation Sans 40 pt (regular, black), centred, one line (`wrap="none"`), zero insets, middle
 * anchored, `a:noAutofit`, `<a:prstTxWarp prst=NAME><a:avLst/></a:prstTxWarp>`. The deck is ordo's own: no third-party
 * deck is read or drawn. Three decks, one per box shape; each puts the box in the middle of a cell of its grid.
 */

/** The text of every box of the probe. */
export const WARP_TEXT = 'WordArt Ag';
/** The face and size: Liberation Sans 40 pt (`sz` is in hundredths of a point). */
export const WARP_FONT = 'Liberation Sans';
export const WARP_SIZE = 4000;

/** One box shape of the probe: its size in px and the grid of cells it sits in on a 1920 x 1080 px slide. */
export interface WarpBox {
  readonly key: string;
  readonly w: number;
  readonly h: number;
  readonly cols: number;
  readonly rows: number;
}

/**
 * The three boxes: 360 x 240 (3:2, as the preset golden's), a wide 600 x 120 and a tall 240 x 300. Their cells (640 x 540,
 * 960 x 360 and 640 x 540 px) leave at least 90 px beyond the box: LibreOffice's ink overshot a box by at most 38 px at
 * planning (the four warps that follow a path put the text on the outside of the curve).
 */
export const WARP_BOXES: readonly WarpBox[] = [
  { key: '360x240', w: 360, h: 240, cols: 3, rows: 2 },
  { key: '600x120', w: 600, h: 120, cols: 2, rows: 3 },
  { key: '240x300', w: 240, h: 300, cols: 3, rows: 2 },
];

/** The layout of `names` (in the order given) at a box: one per cell, row by row, the box centred in its cell in whole px. */
export function warpLayout(names: readonly string[], box: WarpBox): ProbeShape[] {
  const per = box.cols * box.rows;
  const cw = SLIDE_W / box.cols;
  const ch = SLIDE_H / box.rows;
  return names.map((name, i) => {
    const slot = i % per;
    const cell = { x: (slot % box.cols) * cw, y: Math.floor(slot / box.cols) * ch, w: cw, h: ch };
    return {
      name,
      slide: Math.floor(i / per),
      cell,
      // The fill is the probe shape's; this writer draws none.
      box: {
        x: cell.x + Math.floor((cw - box.w) / 2),
        y: cell.y + Math.floor((ch - box.h) / 2),
        w: box.w,
        h: box.h,
      },
      fill: { r: 0, g: 0, b: 0 },
    };
  });
}

/** XML attribute text (warp names are [A-Za-z0-9]; escaped all the same). */
function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** The p:sp of one probe shape: a text box with its warp, `WARP_TEXT` in `WARP_FONT`, no fill and no outline. */
export function warpShapeXml(s: ProbeShape, id: number): string {
  const e = (px: number) => String(Math.round(px * EMU_PER_PX));
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${attr(s.name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${e(s.box.x)}" y="${e(s.box.y)}"/><a:ext cx="${e(s.box.w)}" cy="${e(s.box.h)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="ctr">' +
    `<a:prstTxWarp prst="${attr(s.name)}"><a:avLst/></a:prstTxWarp><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="${WARP_SIZE}" b="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>` +
    `<a:latin typeface="${WARP_FONT}"/></a:rPr><a:t>${WARP_TEXT}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

/** The deck (.pptx bytes) of `names` at a box: seven slides for the 40 warps, the same bytes every time. */
export function warpDeck(names: readonly string[], box: WarpBox): Uint8Array {
  return probeDeck(warpLayout(names, box), warpShapeXml);
}

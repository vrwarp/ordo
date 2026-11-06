/**
 * Slide backgrounds (design/27 §4 "Backgrounds"): looked up on the slide, else the layout, else the master.
 *
 * - `p:bgPr` holds the fill itself (solid, gradient, picture, pattern, none); a picture's relationships
 *   are those of the part that holds the `p:bg`.
 * - `p:bgRef idx` names a theme fill, with `phClr` standing for the reference's own colour: 1-999 index
 *   `fillStyleLst`, 1001 and up `bgFillStyleLst` (idx − 1001). A theme picture fill resolves through the
 *   theme part's relationships. `idx="0"` (or 1000) is no background.
 *
 * How the background is drawn (the slide background, a bottom picture or a bottom rect, extended to 16:9 or
 * not) is decided by `emit.ts`.
 *
 * Owned by work item C (inherit-emit).
 */
import { readFill, styleFill } from './color.ts';
import { rootOf, type SlideCtx, type Source } from './context.ts';
import type { Background } from './ir.ts';
import { blipReader, blipReaderOf } from './picture.ts';
import { child, num, path } from './xml.ts';

const SOURCES: readonly Source[] = ['slide', 'layout', 'master'];

export function readBackground(ctx: SlideCtx): Background {
  for (const from of SOURCES) {
    const bg = path(rootOf(ctx, from), 'p:cSld', 'p:bg');
    if (!bg) continue;
    const bgPr = child(bg, 'p:bgPr');
    if (bgPr) {
      const fill = readFill(bgPr, ctx.color, blipReader(ctx, from));
      if (fill) return { fill, from };
      continue;
    }
    const ref = child(bg, 'p:bgRef');
    if (!ref) continue;
    const idx = num(ref.attrs.idx) ?? 0;
    if (idx <= 0 || idx === 1000) return { fill: { kind: 'none' }, from };
    const fill = styleFill(ctx.theme, ref, ctx.color, blipReaderOf(ctx, ctx.themePart));
    if (fill) return { fill, from };
  }
  return { fill: { kind: 'none' }, from: 'none' };
}

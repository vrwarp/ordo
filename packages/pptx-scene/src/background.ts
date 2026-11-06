/**
 * Slide backgrounds (design/27 §4 "Backgrounds"): looked up on the slide, else the layout, else the master.
 *
 * Owned by work item C (inherit-emit). The scaffold reads `p:bgPr` fills and `p:bgRef` style references.
 * Still to do: picture fills of a theme's bgFillStyleLst resolve through the theme part's relationships;
 * tiles, gradients and the 'Extend plain backgrounds' rule are reported or emitted as design/27 §4 says.
 */
import { readFill, styleFill } from './color.ts';
import { rootOf, type SlideCtx, type Source } from './context.ts';
import type { Background } from './ir.ts';
import { blipReader } from './picture.ts';
import { child, path } from './xml.ts';

export function readBackground(ctx: SlideCtx): Background {
  for (const from of ['slide', 'layout', 'master'] as Source[]) {
    const bg = path(rootOf(ctx, from), 'p:cSld', 'p:bg');
    if (!bg) continue;
    const bgPr = child(bg, 'p:bgPr');
    const fill = bgPr
      ? readFill(bgPr, ctx.color, blipReader(ctx, from))
      : styleFill(ctx.theme, child(bg, 'p:bgRef'), ctx.color, blipReader(ctx, from));
    if (fill) return { fill, from };
  }
  return { fill: { kind: 'none' }, from: 'none' };
}

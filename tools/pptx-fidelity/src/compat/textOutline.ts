import { compatRule, shapeText, visibleRuns } from './rule.ts';

/**
 * An outline on filled text is not drawn. LibreOffice would hollow the letters; the harness's pictures are
 * made from `pptxForRendering`'s copy, which removes such outlines first (as the hub's render copy does,
 * design/27 §5), so the picture shows the fill alone. Hollow text (no fill) keeps its outline, in both.
 */
export const textOutline = compatRule({
  key: 'textOutline',
  text: 'no outline on filled text (removed before LibreOffice draws; it would hollow the letters)',
  hits(e) {
    const t = shapeText(e);
    return !!t && visibleRuns(t).some((r) => r.style.outline !== undefined && r.style.fill.kind !== 'none');
  },
});

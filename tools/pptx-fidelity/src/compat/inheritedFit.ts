import { compatRule, shapeText } from './rule.ts';

/**
 * LibreOffice applies only a shape's own `normAutofit`; one inherited from a layout or master placeholder is
 * ignored (measured with a probe deck), so such text is not shrunk at all.
 */
export const inheritedFit = compatRule({
  key: 'inheritedFit',
  text: 'a normAutofit inherited from a layout or master ignored: the text is not shrunk',
  hits(e) {
    const a = shapeText(e)?.autofit;
    return a?.kind === 'shrink' && !a.own;
  },
});

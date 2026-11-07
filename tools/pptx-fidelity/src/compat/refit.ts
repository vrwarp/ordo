import { compatRule, shapeText } from './rule.ts';

/**
 * LibreOffice ignores PowerPoint's stored `normAutofit` scale and fits the text again from full size; ordo
 * keeps the stored scale while the text fits at it, where the box is drawn with the face PowerPoint fitted it
 * with or a metric clone (design/27 §6 step 10). A box drawn with a stand-in (Aptos with Inter here) is
 * fitted again in both drawings, so the rule changes nothing there.
 */
export const refit = compatRule({
  key: 'refit',
  text: 'the stored autofit scale ignored: text fitted again from full size',
  hits(e) {
    const a = shapeText(e)?.autofit;
    return a?.kind === 'shrink' && !!a.own && (a.fontScale < 1 || a.lnSpcReduction > 0);
  },
});

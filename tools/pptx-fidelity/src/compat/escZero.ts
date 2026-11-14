import { compatRule, shapeText, visibleRuns } from './rule.ts';

/**
 * A run whose nearest `baseline` is 0 under a non-zero one farther along its chain (a text box's runs set
 * `baseline="0"` under a presentation default of -25000) is drawn shifted by that farther one at 58 % of its
 * size: LibreOffice 24.2 reads the 0 as unset (probe decks, design/27 §4 "Baseline 0"). PowerPoint and ordo
 * draw it in place at full size.
 */
export const escZero = compatRule({
  key: 'escZero',
  text: 'a run with baseline 0 under a non-zero inherited baseline shifted by it at 58 % (LibreOffice reads the 0 as unset)',
  hits(e) {
    const t = shapeText(e);
    return !!t && visibleRuns(t).some((r) => r.style.escZero !== undefined);
  },
});

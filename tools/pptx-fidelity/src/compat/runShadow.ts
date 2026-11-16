import { compatRule, drawnRuns } from './rule.ts';

/**
 * LibreOffice draws no run's own text shadow (PowerPoint's "Text Shadow"). A shadow an unfilled shape casts
 * on its text stays: it is the shape's (`ShapeElement.shadow`), not the run's.
 */
export const runShadow = compatRule({
  key: 'runShadow',
  text: "no run's own text shadow (a shadow an unfilled shape casts stays)",
  hits(e) {
    return drawnRuns(e).some((r) => r.style.shadow !== undefined);
  },
});

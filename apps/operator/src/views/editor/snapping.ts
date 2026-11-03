import { type Box, LOGICAL_HEIGHT, LOGICAL_WIDTH } from '@ordo/domain';

export type Guides = { x: number[]; y: number[] };
export type SnapResult = { x: number; y: number; guides: Guides };

/** Lines a box can snap to: canvas edges and centre plus every other object's edges and centre. */
export function snapTargets(others: Box[]): Guides {
  const x = [0, LOGICAL_WIDTH / 2, LOGICAL_WIDTH];
  const y = [0, LOGICAL_HEIGHT / 2, LOGICAL_HEIGHT];
  for (const b of others) {
    x.push(b.x, b.x + b.w / 2, b.x + b.w);
    y.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { x, y };
}

function bestOffset(edges: number[], lines: number[], threshold: number): { delta: number; line?: number } {
  let best: { delta: number; line?: number } = { delta: 0 };
  let bestAbs = threshold + 1e-9;
  for (const e of edges) {
    for (const l of lines) {
      const d = l - e;
      if (Math.abs(d) < bestAbs) {
        bestAbs = Math.abs(d);
        best = { delta: d, line: l };
      }
    }
  }
  return best;
}

/**
 * Snap a moving box (its proposed x, y) to the nearest target line on each axis within `threshold`
 * logical px. Returns the snapped position and the guide lines that matched.
 */
export function snapBox(box: Box, others: Box[], threshold = 8): SnapResult {
  const t = snapTargets(others);
  const bx = bestOffset([box.x, box.x + box.w / 2, box.x + box.w], t.x, threshold);
  const by = bestOffset([box.y, box.y + box.h / 2, box.y + box.h], t.y, threshold);
  return {
    x: box.x + bx.delta,
    y: box.y + by.delta,
    guides: { x: bx.line !== undefined ? [bx.line] : [], y: by.line !== undefined ? [by.line] : [] },
  };
}

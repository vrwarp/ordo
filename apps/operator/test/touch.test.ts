import { describe, expect, it } from 'vitest';
import { revealDelta } from '../src/components/keepVisible.ts';
import { objectToolsSpot, rotaterAngle } from '../src/views/editor/touchGeometry.ts';
import {
  autoScrollSpeed,
  type FlatEntry,
  finishMove,
  flatSlideMove,
  indicatorFor,
  LONG_PRESS_MS,
  moveEntry,
  pressDecision,
  type Rect,
  targetIndex,
} from '../src/components/sortableMath.ts';

const rows = (n: number, h = 50): Rect[] =>
  Array.from({ length: n }, (_, i) => ({ top: i * h, bottom: (i + 1) * h, left: 0, right: 300 }));

describe('sortable: press decision', () => {
  it('a mouse drag starts after a few pixels', () => {
    expect(pressDecision('mouse', 0, 2)).toBe('wait');
    expect(pressDecision('mouse', 0, 4)).toBe('start');
  });
  it('a touch must be held 300 ms; moving first is a scroll', () => {
    expect(pressDecision('touch', 100, 3)).toBe('wait');
    expect(pressDecision('touch', 100, 20)).toBe('abort');
    expect(pressDecision('touch', LONG_PRESS_MS, 3)).toBe('start');
    expect(pressDecision('pen', LONG_PRESS_MS + 50, 40)).toBe('start');
  });
});

describe('sortable: target index (vertical list)', () => {
  const r = rows(4); // midpoints 25, 75, 125, 175
  it('stays put over its own slot', () => {
    expect(targetIndex(r, { x: 10, y: 60 }, 1, 'y')).toBe(1);
  });
  it('moves down past the midpoint of the next item', () => {
    expect(targetIndex(r, { x: 10, y: 74 }, 0, 'y')).toBe(0);
    expect(targetIndex(r, { x: 10, y: 76 }, 0, 'y')).toBe(1);
    expect(targetIndex(r, { x: 10, y: 190 }, 0, 'y')).toBe(3);
  });
  it('moves up above the midpoint of an earlier item', () => {
    expect(targetIndex(r, { x: 10, y: 20 }, 3, 'y')).toBe(0);
    expect(targetIndex(r, { x: 10, y: 80 }, 3, 'y')).toBe(2);
  });
  it('clamps past either end', () => {
    expect(targetIndex(r, { x: 10, y: -500 }, 2, 'y')).toBe(0);
    expect(targetIndex(r, { x: 10, y: 5000 }, 1, 'y')).toBe(3);
  });
  it('agrees with moveEntry: the item ends at the target index', () => {
    const list = ['a', 'b', 'c', 'd'];
    const to = targetIndex(r, { x: 0, y: 130 }, 0, 'y');
    expect(moveEntry(list, 0, to)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('sortable: target index (wrapping chips)', () => {
  // Two rows of three chips, 60 wide, 30 high.
  const chips: Rect[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    top: Math.floor(i / 3) * 40,
    bottom: Math.floor(i / 3) * 40 + 30,
    left: (i % 3) * 70,
    right: (i % 3) * 70 + 60,
  }));
  it('reads left to right on the row under the pointer', () => {
    expect(targetIndex(chips, { x: 105, y: 15 }, 0, 'xy')).toBe(1); // right half of chip 1
    expect(targetIndex(chips, { x: 95, y: 15 }, 0, 'xy')).toBe(0); // left half of chip 1
  });
  it('a pointer on the second row is past the whole first row', () => {
    expect(targetIndex(chips, { x: 5, y: 55 }, 0, 'xy')).toBe(2);
    expect(targetIndex(chips, { x: 200, y: 55 }, 0, 'xy')).toBe(5);
  });
});

describe('sortable: drop indicator', () => {
  it('none for no move; before the slot moving up, after it moving down', () => {
    expect(indicatorFor(2, 2)).toBeNull();
    expect(indicatorFor(3, 1)).toEqual({ index: 1, side: 'before' });
    expect(indicatorFor(0, 2)).toEqual({ index: 2, side: 'after' });
  });
});

describe('sortable: auto-scroll speed', () => {
  it('is zero in the middle and ramps up toward each edge', () => {
    expect(autoScrollSpeed(300, 0, 600)).toBe(0);
    expect(autoScrollSpeed(56, 0, 600)).toBe(0);
    expect(autoScrollSpeed(28, 0, 600)).toBe(-9);
    expect(autoScrollSpeed(0, 0, 600)).toBe(-18);
    expect(autoScrollSpeed(600 - 28, 0, 600)).toBe(9);
    expect(autoScrollSpeed(600, 0, 600)).toBe(18);
  });
  it('is capped past the edges', () => {
    expect(autoScrollSpeed(-100, 0, 600)).toBe(-18);
    expect(autoScrollSpeed(900, 0, 600)).toBe(18);
  });
  it('shrinks the edge band in a short scroller and never divides by zero', () => {
    expect(autoScrollSpeed(50, 0, 90)).toBe(0);
    expect(autoScrollSpeed(0, 0, 90)).toBe(-18);
    expect(autoScrollSpeed(0, 0, 0)).toBe(0);
  });
});

describe('sortable: finishing a drag', () => {
  it('commits a real move', () => {
    expect(finishMove(1, 3, false)).toEqual({ from: 1, to: 3 });
  });
  it('a cancelled drag (Escape, pointercancel) or a drop in place commits nothing', () => {
    expect(finishMove(1, 3, true)).toBeNull();
    expect(finishMove(2, 2, false)).toBeNull();
  });
});

describe('sortable: slides across sections', () => {
  // A: a1 a2 | B: (empty) | C: c1
  const flat: FlatEntry[] = [
    { kind: 'section', id: 'A' },
    { kind: 'slide', id: 'a1' },
    { kind: 'slide', id: 'a2' },
    { kind: 'section', id: 'B' },
    { kind: 'section', id: 'C' },
    { kind: 'slide', id: 'c1' },
  ];
  it('reorders within a section', () => {
    expect(flatSlideMove(flat, 1, 2)).toEqual({ slideId: 'a1', sectionId: 'A', index: 1 });
  });
  it('drops into an empty section', () => {
    expect(flatSlideMove(flat, 2, 3)).toEqual({ slideId: 'a2', sectionId: 'B', index: 0 });
  });
  it('moving up past a header lands at the end of the previous section', () => {
    expect(flatSlideMove(flat, 5, 4)).toEqual({ slideId: 'c1', sectionId: 'B', index: 0 });
    expect(flatSlideMove(flat, 5, 3)).toEqual({ slideId: 'c1', sectionId: 'A', index: 2 });
  });
  it('above the first header clamps to the start of the first section', () => {
    expect(flatSlideMove(flat, 2, 0)).toEqual({ slideId: 'a2', sectionId: 'A', index: 0 });
    expect(flatSlideMove(flat, 1, 0)).toBeNull();
  });
  it('headers are not dragged in the slide list, and a no-op is null', () => {
    expect(flatSlideMove(flat, 0, 2)).toBeNull();
    expect(flatSlideMove(flat, 1, 1)).toBeNull();
  });
});

describe('keep the edited field above the software keyboard', () => {
  const view = { top: 0, height: 400 }; // a 834 px tall screen with a ~434 px keyboard
  it('does nothing for a visible field', () => {
    expect(revealDelta({ top: 100, bottom: 140 }, view)).toBe(0);
  });
  it('scrolls a field under the keyboard up just enough', () => {
    expect(revealDelta({ top: 600, bottom: 640 }, view)).toBe(640 - 388);
  });
  it('scrolls a field above the view down', () => {
    expect(revealDelta({ top: -50, bottom: -10 }, view)).toBe(-62);
  });
  it('aligns a field taller than the view to its top', () => {
    expect(revealDelta({ top: 300, bottom: 1000 }, view)).toBe(288);
  });
  it('follows a panned visual viewport', () => {
    expect(revealDelta({ top: 500, bottom: 540 }, { top: 300, height: 400 })).toBe(0);
    expect(revealDelta({ top: 200, bottom: 240 }, { top: 300, height: 400 })).toBe(-112);
  });
});

describe('the rotate handle stays on the slide under a finger', () => {
  const box = (y: number, h: number, x = 120, w = 1680) => ({ x, y, w, h, rotation: 0 });
  it('sits above a box with room above it', () => {
    expect(rotaterAngle(box(400, 300), 0.5, 64)).toBe(0);
  });
  it('flips below a box at the top of the slide', () => {
    expect(rotaterAngle(box(40, 600), 0.33, 64)).toBe(180);
  });
  it('goes to the side of a full-height box', () => {
    expect(rotaterAngle(box(0, 1080, 100, 1000), 0.5, 64)).toBe(90);
    expect(rotaterAngle(box(0, 1080, 800, 1120), 0.5, 64)).toBe(270);
    expect(rotaterAngle(box(0, 1080, 0, 1920), 0.5, 64)).toBe(0);
  });
  it('follows the box rotation: a wide box turned 90° near the right edge puts the handle on its left', () => {
    // Unrotated it has room above, but its "up" now points right, off the slide.
    expect(rotaterAngle({ ...box(440, 200, 1000), rotation: 90 }, 0.5, 64)).toBe(180);
    // Turned 180° near the top, "up" points down, which is fine.
    expect(rotaterAngle({ ...box(40, 200), rotation: 180 }, 0.5, 64)).toBe(0);
  });
});

describe('editor: floating object tools', () => {
  // A 640 x 360 slide centred in a 664 x 500 pane (stage at 12, 70); scale 1/3.
  const scale = 1 / 3;
  const stage = { x: 12, y: 70 };
  const pane = { w: 664, h: 500 };
  const bar = { w: 400, h: 52 };
  const none = { angle: 90, reach: 79 };

  it('sits above a box low on the slide, centred on it and inside the pane', () => {
    const at = objectToolsSpot(
      { x: 660, y: 700, w: 600, h: 200, rotation: 0 },
      scale,
      stage,
      pane,
      bar,
      none,
    );
    expect(at.y + bar.h).toBeLessThanOrEqual(70 + 700 / 3 - 24);
    expect(at.x).toBe(Math.round(12 + 960 / 3 - 200));
  });

  it('goes below a box near the top, and clear of a rotate handle above it', () => {
    const top = objectToolsSpot(
      { x: 660, y: 20, w: 600, h: 200, rotation: 0 },
      scale,
      stage,
      pane,
      bar,
      none,
    );
    expect(top.y).toBeGreaterThanOrEqual(70 + 220 / 3 + 24);
    const box = { x: 660, y: 250, w: 600, h: 100, rotation: 0 };
    expect(objectToolsSpot(box, scale, stage, pane, bar, none).y).toBeLessThan(70 + 250 / 3);
    // With the rotate handle above, 79 px more are needed there: the tools go below instead.
    const handle = objectToolsSpot(box, scale, stage, pane, bar, { angle: 0, reach: 79 });
    expect(handle.y).toBeGreaterThan(70 + 350 / 3);
  });

  it('falls back to the pane edge away from a box that fills the slide, and clamps to the pane', () => {
    const full = objectToolsSpot(
      { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
      scale,
      stage,
      pane,
      bar,
      none,
    );
    expect(full.y).toBe(pane.h - bar.h - 4);
    const left = objectToolsSpot(
      { x: 0, y: 700, w: 100, h: 100, rotation: 0 },
      scale,
      stage,
      pane,
      bar,
      none,
    );
    expect(left.x).toBe(4);
  });

  it('uses the rotated bounds', () => {
    const flat = objectToolsSpot(
      { x: 860, y: 600, w: 200, h: 20, rotation: 0 },
      scale,
      stage,
      pane,
      bar,
      none,
    );
    const upright = objectToolsSpot(
      { x: 860, y: 600, w: 200, h: 20, rotation: 90 },
      scale,
      stage,
      pane,
      bar,
      none,
    );
    expect(upright.y).toBeLessThan(flat.y);
  });
});

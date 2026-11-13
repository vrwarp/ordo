/**
 * 'Align to slide' and 'Screen placement' (placement.ts; design/15 "Object panel"): the whole selection moves
 * as one block, by its bounds as drawn (a turned box by what the screens show, and it keeps its turn), inside
 * the deck's own area on a 4:3 deck; a PowerPoint shape with its text or a table's cells never come apart.
 */
import { type Box, DEFAULT_THEME, type Presentation, type SlideObject } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { alignSelection, placeSelection } from '../src/views/editor/actions.ts';
import {
  openPresentation,
  selectObjects,
  selectSlide,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { FloatingContextBar } from '../src/views/editor/FloatingContextBar.tsx';
import { getSlide } from '../src/views/editor/ops.ts';
import { boundsOf, groupBox } from '../src/views/editor/ops/group.ts';
import {
  alignedBox,
  FRAME,
  nearBox,
  placeObjects,
  placementArea,
  presetIn,
} from '../src/views/editor/placement.ts';

const FOUR_THREE = { x: 240, y: 0, w: 1440, h: 1080 };
const LOWER_THIRD: Box = { x: 120, y: 720, w: 1680, h: 280, rotation: 0 };

const shape = (id: string, box: Box, extra: Partial<SlideObject> = {}): SlideObject =>
  ({ id, type: 'shape', box, shape: 'rect', opacity: 1, radius: 0, ...extra }) as SlideObject;
const text = (id: string, box: Box, extra: Partial<SlideObject> = {}): SlideObject =>
  ({
    id,
    type: 'text',
    box,
    text: 'Coffee after the service',
    style: { ...DEFAULT_THEME.textBoxDefaults },
    opacity: 1,
    ...extra,
  }) as SlideObject;

function deck(objects: SlideObject[], extra: Partial<Presentation> = {}): Presentation {
  return {
    id: 'p',
    rev: 1,
    title: 'Placement',
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: 'sec', label: 'S', short: 'S', slides: [{ id: 's1', objects }] }],
    arrangements: [],
    archived: false,
    ...extra,
  } as Presentation;
}
const objs = (p: Presentation) => getSlide(p, 's1')!.objects;
const by = (p: Presentation, id: string) => objs(p).find((o) => o.id === id)!;
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01);

describe('the area align and placement work in', () => {
  it('is a 4:3 deck’s own area, else the frame', () => {
    expect(placementArea(deck([]))).toEqual(FRAME);
    const native = { version: 1, slides: 1, native: 1, hybrid: 0, picture: 0 };
    expect(
      placementArea(deck([], { source: { kind: 'pptx', native: { ...native, slideRect: FOUR_THREE } } })),
    ).toEqual(FOUR_THREE);
    // A 16:9 deck's rect is the frame.
    expect(
      placementArea(
        deck([], {
          source: { kind: 'pptx', native: { ...native, slideRect: { x: 0, y: 0, w: 1920, h: 1080 } } },
        }),
      ),
    ).toEqual(FRAME);
    expect(placementArea(undefined)).toEqual(FRAME);
  });

  it('aligns a block to each edge and centre, edges exact, centres on whole pixels', () => {
    const b: Box = { x: 500, y: 300, w: 401, h: 201, rotation: 0 };
    expect(alignedBox(b, FOUR_THREE, 'left')).toMatchObject({ x: 240, y: 300 });
    expect(alignedBox(b, FOUR_THREE, 'right')).toMatchObject({ x: 1680 - 401 });
    expect(alignedBox(b, FOUR_THREE, 'cx')).toMatchObject({ x: Math.round(240 + (1440 - 401) / 2) });
    expect(alignedBox(b, FOUR_THREE, 'top')).toMatchObject({ x: 500, y: 0 });
    expect(alignedBox(b, FOUR_THREE, 'bottom')).toMatchObject({ y: 1080 - 201 });
    expect(alignedBox(b, FOUR_THREE, 'cy')).toMatchObject({ y: Math.round((1080 - 201) / 2) });
  });

  it('maps a preset of the 16:9 frame into a 4:3 deck’s area', () => {
    expect(presetIn(LOWER_THIRD, FRAME)).toEqual(LOWER_THIRD);
    expect(presetIn(LOWER_THIRD, FOUR_THREE)).toEqual({ x: 330, y: 720, w: 1260, h: 280, rotation: 0 });
    expect(nearBox(presetIn(LOWER_THIRD, FOUR_THREE), presetIn(LOWER_THIRD, FOUR_THREE))).toBe(true);
    expect(nearBox(LOWER_THIRD, presetIn(LOWER_THIRD, FOUR_THREE))).toBe(false);
  });
});

describe('placing the selection as one block', () => {
  // A PowerPoint shape with its text: one group.
  const pair = [
    shape('sh', { x: 600, y: 400, w: 600, h: 300, rotation: 0 }, { origin: { src: 'pptx', group: 1 } }),
    text('tx', { x: 650, y: 450, w: 500, h: 200, rotation: 0 }, { origin: { src: 'pptx', group: 1 } }),
  ];

  it('Align left moves a shape with its text together, to the deck’s left edge', () => {
    const p = deck(pair);
    const q = placeObjects(p, 's1', pair, (from) => alignedBox(from, FOUR_THREE, 'left'));
    expect(by(q, 'sh').box).toEqual({ x: 240, y: 400, w: 600, h: 300, rotation: 0 });
    expect(by(q, 'tx').box).toEqual({ x: 290, y: 450, w: 500, h: 200, rotation: 0 });
  });

  it('a turned box aligns by its bounds as drawn and keeps its turn', () => {
    const turned = text('t', { x: 800, y: 400, w: 600, h: 200, rotation: 30 });
    const p = deck([turned]);
    const q = placeObjects(p, 's1', [turned], (from) => alignedBox(from, FRAME, 'left'));
    const b = by(q, 't').box;
    expect(b.rotation).toBe(30);
    expect(b.w).toBe(600);
    close(boundsOf(b).x0, 0);
    const r = placeObjects(p, 's1', [turned], (from) => alignedBox(from, FRAME, 'bottom'));
    close(boundsOf(by(r, 't').box).y1, 1080);
  });

  it('Screen placement puts a turned box’s bounds on the preset and keeps its turn', () => {
    const turned = text('t', { x: 800, y: 400, w: 600, h: 200, rotation: 90 });
    const p = deck([turned]);
    const q = placeObjects(p, 's1', [turned], () => LOWER_THIRD);
    const b = by(q, 't').box;
    expect(b.rotation).toBe(90);
    const g = groupBox([by(q, 't')])!;
    close(g.x, LOWER_THIRD.x);
    close(g.y, LOWER_THIRD.y);
    close(g.w, LOWER_THIRD.w);
    close(g.h, LOWER_THIRD.h);
  });

  it('Screen placement scales a group as one, in a 4:3 deck’s area', () => {
    const p = deck(pair);
    const to = presetIn(LOWER_THIRD, FOUR_THREE);
    const q = placeObjects(p, 's1', pair, () => to);
    const g = groupBox([by(q, 'sh'), by(q, 'tx')])!;
    expect(g).toEqual(to);
    // The text stays inside its shape, where it was in it.
    const sh = by(q, 'sh').box;
    const tx = by(q, 'tx').box;
    close((tx.x - sh.x) / sh.w, 50 / 600);
    close((tx.y - sh.y) / sh.h, 50 / 300);
  });

  it('a locked picture keeps its aspect; nothing moved gives the presentation back', () => {
    const art = {
      id: 'art',
      type: 'image',
      box: { x: 100, y: 100, w: 400, h: 200, rotation: 0 },
      mediaId: 'm',
      fit: 'stretch',
      opacity: 1,
      radius: 0,
      locked: true,
    } as SlideObject;
    const p = deck([art]);
    const q = placeObjects(p, 's1', [art], () => LOWER_THIRD);
    const b = by(q, 'art').box;
    close(b.w / b.h, 2);
    expect(placeObjects(p, 's1', [art], (from) => from)).toBe(p);
  });

  it('marks the box theme override when a themed song’s lyric box is placed', () => {
    const lyric = text('lyric', { x: 0, y: 0, w: 800, h: 200, rotation: 0 });
    const p = deck([lyric], { kind: 'song', themeId: DEFAULT_THEME.id });
    const q = placeObjects(p, 's1', [lyric], () => LOWER_THIRD, 'lyric');
    expect(getSlide(q, 's1')!.overrides).toEqual(['box']);
    // Not on a presentation without a theme.
    const r = placeObjects({ ...p, themeId: undefined }, 's1', [lyric], () => LOWER_THIRD, 'lyric');
    expect(getSlide(r, 's1')!.overrides).toBeUndefined();
  });
});

describe('the selection actions (the drawer and the floating bar)', () => {
  const pair = [
    shape('sh', { x: 600, y: 400, w: 600, h: 300, rotation: 0 }, { origin: { src: 'pptx', group: 1 } }),
    text('tx', { x: 650, y: 450, w: 500, h: 200, rotation: 0 }, { origin: { src: 'pptx', group: 1 } }),
  ];
  const native = { version: 1, slides: 1, native: 1, hybrid: 0, picture: 0, slideRect: FOUR_THREE };
  beforeEach(() => {
    openPresentation(deck(pair, { source: { kind: 'pptx', native } } as Partial<Presentation>));
    selectSlide('s1');
    selectObjects(['sh', 'tx'], 'tx');
  });
  const draft = () => useEditor.getState().draft!;

  it('Align right moves a shape and its text as one block inside the 4:3 area, one undo step', () => {
    alignSelection('right');
    expect(by(draft(), 'sh').box).toMatchObject({ x: 1680 - 600, y: 400 });
    expect(by(draft(), 'tx').box).toMatchObject({ x: 1680 - 550, y: 450 });
    undo();
    expect(objs(draft())).toEqual(pair);
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it('a placement card puts the block on the card scaled into the area', () => {
    placeSelection((_from, area) => presetIn(LOWER_THIRD, area));
    expect(groupBox(objs(draft()))).toEqual(presetIn(LOWER_THIRD, FOUR_THREE));
  });

  it('the floating bar of a multi-selection offers Align', () => {
    // A server render reads the store's initial state (zustand's server snapshot).
    const initial = useEditor.getInitialState();
    const saved = { ...initial };
    const { draft: d, slideId, objectId, objectIds } = useEditor.getState();
    Object.assign(initial, { draft: d, slideId, objectId, objectIds });
    let h = '';
    try {
      h = renderToStaticMarkup(
        createElement(FloatingContextBar, { readOnly: false, drawerOpen: false, onToggleDrawer: () => {} }),
      );
    } finally {
      Object.assign(initial, saved);
    }
    expect(h).toContain('2 selected');
    expect(h).toContain('>Align ▾</button>');
  });
});

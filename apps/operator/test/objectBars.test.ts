/**
 * The floating bar's registry (`views/editor/objectBars.ts`, design/15 "Object bars"): the bar over one
 * selected object is the first bar by order that applies to it and that no applying bar replaces; the neutral
 * bar (scope pill, Layer, Duplicate, Delete, More…) takes every object no bar claims. The shape bar's
 * geometry select and fill pill write the legacy fields (`shape`, `fill`, `gradient`) that only an older
 * build draws for a table, a chart or a decoration, and that a locked object keeps read-only: none of those
 * shows them. (Server-rendered with `createElement`, as the panel tests are.)
 */
import { m9Chart, m9Decor, m9Table } from '@ordo/domain/m9.test-util.ts';
import { Presentation, type SlideObject } from '@ordo/domain';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { openPresentation, selectObject, selectObjects, useEditor } from '../src/views/editor/editorStore.ts';
import { BUILTIN_BARS, FloatingContextBar } from '../src/views/editor/FloatingContextBar.tsx';
import {
  objectBarFor,
  OBJECT_BAR_ORDER,
  OBJECT_BARS,
  registerObjectBar,
} from '../src/views/editor/objectBars.ts';

const white = { r: 255, g: 255, b: 255, a: 1 };
const red = { r: 200, g: 40, b: 40, a: 1 };
const box = { x: 100, y: 100, w: 800, h: 400, rotation: 0 };
const shape = (id: string, extra: Record<string, unknown> = {}): SlideObject =>
  ({ id, type: 'shape', box, shape: 'rect', fill: white, opacity: 1, radius: 0, ...extra }) as SlideObject;

const OBJECTS: SlideObject[] = [
  shape('rect', { fill: red }),
  shape('table', { table: m9Table() }),
  shape('chart', { chart: m9Chart() }),
  shape('decor', { decor: m9Decor() }),
  shape('locked', { locked: true }),
  {
    id: 'text',
    type: 'text',
    box,
    text: 'Amazing grace',
    style: { fontFamily: 'Inter', fontSizePx: 72, color: white },
    opacity: 1,
  } as SlideObject,
  { id: 'photo', type: 'image', box, mediaId: 'm1', fit: 'cover', opacity: 1, radius: 0 } as SlideObject,
];

const deck = Presentation.parse({
  id: 'deck',
  title: 'Deck',
  kind: 'slides',
  sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: OBJECTS }] }],
});

/** Server rendering reads a zustand store's initial state, so the test seeds it there too. */
function seed(p: Partial<ReturnType<typeof useEditor.getState>>) {
  Object.assign(useEditor.getInitialState(), p);
  useEditor.setState(p);
}

const html = (el: ReactElement) => renderToStaticMarkup(el);
const bar = () =>
  html(createElement(FloatingContextBar, { readOnly: false, drawerOpen: false, onToggleDrawer: () => {} }));

function barOf(...ids: string[]): string {
  openPresentation(deck);
  if (ids.length > 1) selectObjects(ids, ids[0]);
  else selectObject(ids[0]);
  const s = useEditor.getState();
  seed({ draft: s.draft, slideId: 'sl', objectId: s.objectId, objectIds: s.objectIds });
  return bar();
}

/** A bar a test registers. */
function ChartBar() {
  return createElement('span', { 'data-chart-bar': '' });
}

afterEach(() => seed({ draft: undefined, slideId: undefined, objectId: undefined, objectIds: [] }));

describe('the floating bar registry (objectBars)', () => {
  it('a table, a chart, a decoration and a locked object show no shape geometry or shape fill', () => {
    for (const id of ['table', 'chart', 'decor', 'locked']) {
      const h = barOf(id);
      expect(h, id).not.toContain('aria-label="Shape geometry"');
      expect(h, id).not.toContain('aria-label="Shape fill"');
      // Every bar keeps the tail actions.
      expect(h, id).toContain('aria-label="Delete object"');
      expect(h, id).toContain('More…');
    }
  });

  it('a plain shape keeps its geometry, fill and stroke; text and pictures keep theirs', () => {
    const rect = barOf('rect');
    expect(rect).toContain('aria-label="Shape geometry"');
    expect(rect).toContain('aria-label="Shape fill"');
    expect(barOf('text')).toContain('aria-label="Bold"');
    expect(barOf('photo')).toContain('Crop');
    expect(barOf('rect', 'text')).toContain('2 selected');
  });

  it('dispatches by order: the first bar that applies and that no applying bar replaces', () => {
    const o = (id: string) => OBJECTS.find((x) => x.id === id)!;
    const one = (id: string) => objectBarFor(o(id), false, BUILTIN_BARS).id;
    expect(one('rect')).toBe('shape');
    expect(one('text')).toBe('text');
    expect(one('photo')).toBe('picture');
    expect(one('chart')).toBe('neutral');
    expect(one('decor')).toBe('neutral');
    expect(one('locked')).toBe('neutral');
    expect(objectBarFor(o('rect'), true, BUILTIN_BARS).id).toBe('multi');
    // No M9 bar is registered yet: a table gets the neutral bar.
    expect(OBJECT_BARS).toEqual([]);
    expect(one('table')).toBe('neutral');
    for (const b of BUILTIN_BARS) expect(b.order).toBe(OBJECT_BAR_ORDER[b.id as 'text']);
    // A registered bar stands in for the built-in ones it replaces, for what it applies to only.
    const off = registerObjectBar({
      id: 'chart',
      order: OBJECT_BAR_ORDER.shape,
      applies: (x) => x.type === 'shape' && !!x.chart,
      replaces: ['neutral'],
      Component: ChartBar,
    });
    try {
      expect(one('chart')).toBe('chart');
      expect(barOf('chart')).toContain('data-chart-bar');
      expect(one('decor')).toBe('neutral');
    } finally {
      off();
    }
    expect(one('chart')).toBe('neutral');
  });
});

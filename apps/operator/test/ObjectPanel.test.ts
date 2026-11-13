/**
 * The Object panel's sections registry (design/27 M9 render-seams; `views/editor/objectSections.ts`): the
 * panel renders its built-in sections and every registered one by order. With nothing registered it must
 * render exactly today's panels: each case's markup is pinned by its digest, recorded on the panel before the
 * registry. A registered section lands at its order, only for the objects it applies to, and may stand in for
 * built-in sections it names. (Server-rendered with `createElement`: vitest runs `*.test.ts` files only.)
 */
import { createHash } from 'node:crypto';
import { Presentation, type SlideObject } from '@ordo/domain';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { useLibrary } from '../src/state/library.ts';
import { openPresentation, useEditor } from '../src/views/editor/editorStore.ts';
import { BUILTIN_SECTIONS, ObjectPanel } from '../src/views/editor/ObjectPanel.tsx';
import {
  OBJECT_SECTION_ORDER,
  OBJECT_SECTIONS,
  type ObjectSectionContext,
  objectSectionsFor,
  registerObjectSection,
} from '../src/views/editor/objectSections.ts';

const white = { r: 255, g: 255, b: 255, a: 1 };
const red = { r: 200, g: 40, b: 40, a: 1 };

const OBJECTS: SlideObject[] = [
  {
    id: 'lyric',
    type: 'text',
    box: { x: 100, y: 600, w: 1720, h: 400, rotation: 0 },
    text: 'Amazing grace',
    style: { fontFamily: 'Inter', fontSizePx: 72, color: white } as never,
    opacity: 1,
  } as SlideObject,
  {
    id: 'note',
    type: 'text',
    box: { x: 100, y: 100, w: 600, h: 200, rotation: 5 },
    text: 'Verse 1',
    style: { fontFamily: 'Inter', fontSizePx: 40, color: { r: 0, g: 255, b: 0, a: 1 } } as never,
    opacity: 0.8,
    runs: [{ start: 0, end: 5, fontWeight: 700 }],
  } as SlideObject,
  {
    id: 'photo',
    type: 'image',
    box: { x: 0, y: 0, w: 960, h: 540, rotation: 0 },
    mediaId: 'm1',
    fit: 'cover',
    opacity: 1,
    radius: 12,
    crop: { l: 0.1, t: 0, r: 0, b: 0.1 },
  } as SlideObject,
  {
    id: 'masked',
    type: 'image',
    box: { x: 960, y: 0, w: 960, h: 540, rotation: 0 },
    mediaId: 'm1',
    fit: 'contain',
    opacity: 1,
    radius: 0,
    mask: { preset: 'ellipse' },
    flipH: true,
  } as SlideObject,
  {
    id: 'clip',
    type: 'image',
    box: { x: 320, y: 180, w: 1280, h: 720, rotation: 0 },
    mediaId: 'm1',
    fit: 'contain',
    opacity: 1,
    radius: 0,
    play: { mediaId: 'v1', start: 'auto', loop: false, onEnd: 'hold' },
  } as SlideObject,
  {
    id: 'rect',
    type: 'shape',
    box: { x: 100, y: 100, w: 400, h: 300, rotation: 0 },
    shape: 'rect',
    fill: red,
    stroke: { width: 3, color: white },
    opacity: 1,
    radius: 8,
  } as SlideObject,
  {
    id: 'star',
    type: 'shape',
    box: { x: 600, y: 100, w: 400, h: 300, rotation: 0 },
    shape: 'rect',
    fill: red,
    opacity: 1,
    radius: 0,
    geom: { preset: 'star5' },
    gradient: {
      kind: 'linear',
      angle: 45,
      stops: [
        { at: 0, color: red },
        { at: 1, color: white },
      ],
    },
    dash: 'dash',
    origin: { src: 'pptx', shapeId: 4, role: 'shape' },
  } as SlideObject,
  {
    id: 'line',
    type: 'shape',
    box: { x: 100, y: 800, w: 600, h: 0, rotation: 0 },
    shape: 'line',
    stroke: { width: 2, color: white },
    opacity: 1,
    radius: 0,
  } as SlideObject,
];

const deck = Presentation.parse({
  id: 'deck',
  title: 'Deck',
  kind: 'slides',
  sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: OBJECTS }] }],
});

/** Server rendering reads a zustand store's initial state, so the panel test seeds it there too. */
function seed<T extends object>(
  store: { getInitialState: () => T; setState: (p: Partial<T>) => void },
  p: Partial<T>,
) {
  Object.assign(store.getInitialState(), p);
  store.setState(p);
}

const html = (el: ReactElement) => renderToStaticMarkup(el);
/**
 * The markup's digest, React's `useId` values made equal: they name a component's place in the tree (one
 * more component level changes them), not what the panel shows or does.
 */
const digest = (s: string) =>
  createHash('sha256')
    .update(s.replace(/_R_[0-9a-zA-Z]+_/g, '_R_'))
    .digest('hex')
    .slice(0, 16);

function panel(o: SlideObject, readOnly = false): string {
  return html(createElement(ObjectPanel, { o, readOnly }));
}

/** A section a test registers: the object's id, and whether its fields are read-only. */
function CellsSection({ o, readOnly }: ObjectSectionContext) {
  return createElement('section', { 'data-cells': o.id }, readOnly ? 'ro' : 'rw');
}

/**
 * Each case's markup digest on the panel before the registry, recorded then: on main's panel at 1764e05 (its
 * placement presets, align bar, inline-editing text field and the canvas-first editor's typography card,
 * folded paragraph strip and stroke line), which the sections reproduce. The text cases (lyric, note) were
 * re-recorded when the typography card's font select was named 'Font' (e2e/editor-fit.spec.ts): that aria-label is their only
 * change.
 */
const BEFORE: Record<string, string> = {
  clip: 'd07d1eea6ce4acad',
  'clip locked': 'a8353fb12cc9ea38',
  'clip read-only': 'ef694d9768642f1d',
  line: '1febad1893a3857f',
  'line locked': '46cb9d8f4b94310f',
  'line read-only': '91e422367cacb421',
  lyric: '860acd1a710ec0aa',
  'lyric locked': '8f1dd27c7210a8ec',
  'lyric read-only': 'd43f6f550dbd31cf',
  masked: 'e748fd810491ebb8',
  'masked locked': '9350270c7b61c4ea',
  'masked read-only': 'e606cde4b64619b5',
  note: 'e35823f7a550417d',
  'note locked': '16a8d5facf19b6bf',
  'note read-only': 'b826b966fdc86813',
  photo: 'c0060acdf3fd63c1',
  'photo locked': '28d67736d4e8dbfe',
  'photo read-only': '0d19dc03171c2dbb',
  rect: '569eae13823cca01',
  'rect locked': '1f8092f62967d819',
  'rect read-only': '223f6bde383e96fc',
  star: '606bcbcbcfcefde3',
  'star locked': '85e2268772d13750',
  'star read-only': 'a0340cee01b56026',
};

describe('the Object panel sections (M9 render-seams)', () => {
  beforeEach(() => {
    openPresentation(deck);
    const draft = useEditor.getState().draft!;
    seed(useEditor, { draft, slideId: 'sl', objectId: undefined });
    seed(useLibrary, {
      data: {
        ...useLibrary.getState().data,
        media: [
          { id: 'm1', name: 'Sunrise.jpg', kind: 'image', hash: 'h1', width: 1600, height: 900 } as never,
        ],
      },
    });
  });

  it('the sections registry renders today’s panels', () => {
    const got: Record<string, string> = {};
    const objects = useEditor.getState().draft!.sections[0]!.slides[0]!.objects;
    for (const o of objects) {
      got[o.id] = digest(panel(o));
      got[`${o.id} read-only`] = digest(panel(o, true));
      got[`${o.id} locked`] = digest(panel({ ...o, locked: true } as SlideObject));
    }
    expect(got).toEqual(BEFORE);
  });

  it('lists the built-in sections in today’s order, each for the objects it served', () => {
    expect(OBJECT_SECTIONS).toEqual([]);
    const ids = (o: SlideObject) => objectSectionsFor(o, BUILTIN_SECTIONS).map((x) => x.id);
    const [lyric, , photo, , , rect] = OBJECTS;
    expect(ids(lyric!)).toEqual([
      'heading',
      'notes',
      'text',
      'placement',
      'box',
      'opacity',
      'textStyle',
      'slideOps',
    ]);
    expect(ids(photo!)).toEqual(['heading', 'notes', 'box', 'opacity', 'picture', 'video', 'slideOps']);
    expect(ids(rect!)).toEqual(['heading', 'notes', 'box', 'opacity', 'slideOps', 'shape']);
    for (const b of BUILTIN_SECTIONS) expect(b.order).toBe(OBJECT_SECTION_ORDER[b.id as 'heading']);
  });

  it('renders a registered section at its order, only where it applies, in place of what it replaces', () => {
    const rect = useEditor.getState().draft!.sections[0]!.slides[0]!.objects.find((x) => x.id === 'rect')!;
    const photo = useEditor.getState().draft!.sections[0]!.slides[0]!.objects.find((x) => x.id === 'photo')!;
    const off = registerObjectSection({
      id: 'cells',
      order: OBJECT_SECTION_ORDER.opacity + 1,
      applies: (o) => o.type === 'shape',
      replaces: ['shape'],
      Component: CellsSection,
    });
    try {
      const h = panel(rect);
      expect(h).toContain('<section data-cells="rect">rw</section>');
      expect(h).not.toContain('<h4>Shape</h4>');
      expect(h.indexOf('data-cells')).toBeGreaterThan(h.indexOf('Opacity'));
      expect(h.indexOf('data-cells')).toBeGreaterThan(h.indexOf('<h4>Position and size</h4>'));
      expect(h.endsWith('<section data-cells="rect">rw</section></div>')).toBe(true);
      expect(panel(rect, true)).toContain('<section data-cells="rect">ro</section>');
      // A picture is not a shape: its panel is today's.
      expect(digest(panel(photo))).toBe(BEFORE.photo);
    } finally {
      off();
    }
    expect(digest(panel(rect))).toBe(BEFORE.rect);
  });
});

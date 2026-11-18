/**
 * What the editor shows of an imported table's stored form (design/15 "Table editing", r2b 1b tables-form):
 * the table stores LibreOffice's 600 dpi sizes (14 pt is stored 14.04 pt, 28.08 logical px), and the size
 * field shows a cell's size as typed sizes are shown (28), the stored value unchanged. (Server-rendered with
 * `createElement`, as the table bar tests are.)
 */
import {
  cellTextObject,
  Presentation,
  type ShapeObject,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';
import { m9Table } from '@ordo/domain/m9.test-util.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { openPresentation, selectCell, useEditor } from '../src/views/editor/editorStore.ts';
import { FloatingContextBar } from '../src/views/editor/FloatingContextBar.tsx';
import { pasteRichText, sliceRichText } from '../src/views/editor/ops/index.ts';

const white = { r: 255, g: 255, b: 255, a: 1 };
/** The fixture table imported at LibreOffice's sizes: its base 14.04 pt (28.08 px), rows fixed. */
const imported = () => {
  const t = m9Table();
  return { ...t, base: { ...t.base, fontSizePx: 28.08 }, rowRule: 'fixed' as const };
};
const TABLE = {
  id: 'table',
  type: 'shape',
  box: { x: 120, y: 160, w: 1320, h: 410, rotation: 0 },
  shape: 'rect',
  fill: white,
  opacity: 1,
  radius: 0,
  table: imported(),
} as SlideObject;

const deck = Presentation.parse({
  id: 'deck',
  title: 'Order of service',
  kind: 'slides',
  sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: [TABLE] }] }],
});

/** Server rendering reads a zustand store's initial state, so the test seeds it there too. */
function seed() {
  const s = useEditor.getState();
  const p = { draft: s.draft, slideId: 'sl', objectId: s.objectId, objectIds: s.objectIds, cell: s.cell };
  Object.assign(useEditor.getInitialState(), p);
  useEditor.setState(p);
}
afterEach(() => {
  Object.assign(useEditor.getInitialState(), {
    draft: undefined,
    slideId: undefined,
    objectId: undefined,
    objectIds: [],
    cell: undefined,
  });
});

/** The size shown between the bar's Size − and Size + buttons. */
const shownSize = (html: string) =>
  /aria-label="Decrease font size"[\s\S]*?<span class="mono small"[^>]*>([^<]*)<\/span>/.exec(html)?.[1];

describe("the table bar on an imported table's cell", () => {
  it('shows a stored 600 dpi size as typed sizes are shown (28.08 px as 28), the stored size unchanged', () => {
    openPresentation(deck);
    useEditor.setState({ slideId: 'sl' });
    selectCell('table', 9); // 'Worship team': the base style, no entry of its own
    seed();
    const html = renderToStaticMarkup(
      createElement(FloatingContextBar, { readOnly: false, drawerOpen: false, onToggleDrawer: () => {} }),
    );
    expect(html).toContain('Row 3, column 4');
    expect(shownSize(html)).toBe('28');
    const t = (
      useEditor.getState().draft!.sections[0]!.slides[0]!.objects[0] as typeof TABLE & {
        table: ReturnType<typeof imported>;
      }
    ).table;
    expect(t.base.fontSizePx).toBe(28.08);
  });
});

describe("a cell's text pasted into a text box", () => {
  it("takes the box's size, its runs their ratio to the cell's: no 600 dpi size travels", () => {
    // A cell of the imported table (base 28.08 px) whose second word is at half its size (14.04 px).
    const t = imported();
    t.cells[9] = { ...t.cells[9]!, runs: [[8, 12, 0]] };
    const o = { ...TABLE, table: { ...t, runStyles: [{ sizeScale: 0.5 }] } } as ShapeObject;
    const view = cellTextObject(o, 9)!;
    expect(view.text).toBe('Worship team');
    expect(view.style.fontSizePx).toBe(28.08);
    const slice = sliceRichText(view, 0, view.text.length);
    const box = {
      id: 'box',
      type: 'text',
      box: { x: 100, y: 700, w: 1700, h: 300, rotation: 0 },
      text: '',
      style: { ...view.style, fontSizePx: 60 },
      opacity: 1,
    } as TextObject;
    const pasted = pasteRichText(box, 0, 0, slice).object;
    expect(pasted.text).toBe('Worship team');
    expect(pasted.style.fontSizePx).toBe(60);
    expect(pasted.runs).toEqual([{ start: 8, end: 12, sizeScale: 0.5 }]);
  });
});

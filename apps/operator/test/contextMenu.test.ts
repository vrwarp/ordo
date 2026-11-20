import { DEFAULT_THEME, type ImageObject, type Presentation, type Slide, type Theme } from '@ordo/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  type ContextMenuEntry,
  closeContextMenu,
  installTouchLongPress,
  isEditableTarget,
  LONG_PRESS_MENU_MS,
  LONG_PRESS_MOVE_PX,
  normalizeContextMenuEntries,
  openContextMenu,
} from '../src/components/ContextMenu.tsx';
import {
  buildCanvasContextMenu,
  buildSectionHeaderContextMenu,
  buildSlideCardContextMenu,
  buildTableRailContextMenu,
  type CanvasContextMenuArgs,
} from '../src/views/editor/editorContextMenu.ts';
import { duplicateSection, newShape, newText } from '../src/views/editor/ops.ts';
import { newTable } from '../src/views/editor/ops/index.ts';

function noop() {}

function labels(entries: readonly ContextMenuEntry[]): string[] {
  return entries.map((e) => {
    if (e.kind === 'separator') return '---';
    if (e.kind === 'label') return `[${e.label}]`;
    if (e.kind === 'submenu') return `${e.label} >`;
    return e.label;
  });
}

function makeDeck(): { p: Presentation; slide: Slide; theme: Theme } {
  const theme: Theme = structuredClone(DEFAULT_THEME);
  const textObj = newText(theme);
  textObj.id = 'txt-1';
  textObj.text = 'Amazing Grace';
  const shapeObj = newShape('rect');
  shapeObj.id = 'shp-1';
  const imgObj: ImageObject = {
    id: 'img-1',
    type: 'image',
    box: { x: 100, y: 100, w: 600, h: 400, rotation: 0 },
    mediaId: 'med-img',
    fit: 'contain',
    opacity: 1,
    radius: 0,
  };
  const vidObj: ImageObject = {
    id: 'vid-1',
    type: 'image',
    box: { x: 100, y: 100, w: 600, h: 400, rotation: 0 },
    mediaId: 'med-vid',
    fit: 'contain',
    opacity: 1,
    radius: 0,
    play: { mediaId: 'med-vid', start: 'auto', loop: false, muted: false, onEnd: 'hold' },
  };
  const tableObj = newTable(theme, { rows: 3, cols: 3 });
  tableObj.id = 'tbl-1';

  const slide: Slide = {
    id: 'sl-1',
    objects: [textObj, shapeObj, imgObj, vidObj, tableObj],
  };

  const p: Presentation = {
    id: 'pres-1',
    rev: 1,
    title: 'Test Deck',
    kind: 'slides',
    themeId: theme.id,
    meta: { tags: [] },
    sections: [
      { id: 'sec-1', label: 'Verse 1', short: 'V1', slides: [slide] },
      { id: 'sec-2', label: 'Chorus', short: 'C', slides: [{ id: 'sl-2', objects: [] }] },
    ],
    arrangements: [],
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  return { p, slide, theme };
}

function makeCanvasArgs(overrides: Partial<CanvasContextMenuArgs> = {}): CanvasContextMenuArgs {
  const { p, slide, theme } = makeDeck();
  return {
    p,
    slide,
    theme,
    readOnly: false,
    objectIds: [],
    mediaLookup: (id) =>
      id === 'med-vid'
        ? ({
            id,
            kind: 'video',
            name: 'clip.mp4',
            state: 'ready',
            size: 100,
            createdAt: 0,
            updatedAt: 0,
          } as never)
        : ({
            id,
            kind: 'image',
            name: 'pic.png',
            state: 'ready',
            size: 100,
            createdAt: 0,
            updatedAt: 0,
          } as never),
    onPaste: noop,
    onEditText: noop,
    onOpenInspector: noop,
    onOpenBackgroundPicker: noop,
    onOpenImagePicker: noop,
    onOpenVideoPicker: noop,
    onReplacePicture: noop,
    onReplaceVideo: noop,
    onAddObject: noop,
    ...overrides,
  };
}

describe('ContextMenu foundation', () => {
  it('normalizeContextMenuEntries strips leading, trailing, duplicate separators, falsy entries, and empty submenus', () => {
    const out = normalizeContextMenuEntries([
      false,
      null,
      undefined,
      { kind: 'separator' },
      { label: 'First', onSelect: noop },
      { kind: 'separator' },
      { kind: 'separator' },
      { kind: 'submenu', label: 'Empty Sub', items: [] },
      {
        kind: 'submenu',
        label: 'Valid Sub',
        items: [{ kind: 'separator' }, { label: 'Child', onSelect: noop }, { kind: 'separator' }],
      },
      { kind: 'separator' },
      { label: 'Last', onSelect: noop },
      { kind: 'separator' },
    ]);

    expect(labels(out)).toEqual(['First', '---', 'Valid Sub >', '---', 'Last']);
    const sub = out[2];
    expect(sub?.kind).toBe('submenu');
    if (sub?.kind === 'submenu') {
      expect(labels(sub.items)).toEqual(['Child']);
    }
  });

  it('isEditableTarget detects native inputs and contenteditable elements', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(
      true,
    );
    expect(
      isEditableTarget({
        tagName: 'SPAN',
        closest: (sel: string) => (sel === '[contenteditable="true"]' ? {} : null),
      } as unknown as EventTarget),
    ).toBe(true);
  });

  it('openContextMenu respects Shift+Right-Click and editable targets', () => {
    closeContextMenu();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    // Shift+Right-Click falls back to browser menu
    expect(
      openContextMenu(
        {
          shiftKey: true,
          target: { tagName: 'DIV' },
          clientX: 10,
          clientY: 20,
          preventDefault,
          stopPropagation,
        } as never,
        [{ label: 'Action', onSelect: noop }],
      ),
    ).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();

    // Editable target falls back unless allowInField is set
    expect(
      openContextMenu(
        {
          shiftKey: false,
          target: { tagName: 'INPUT' },
          clientX: 10,
          clientY: 20,
          preventDefault,
          stopPropagation,
        } as never,
        [{ label: 'Action', onSelect: noop }],
      ),
    ).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();

    // Empty menu does not hijack right-click
    expect(
      openContextMenu(
        {
          shiftKey: false,
          target: { tagName: 'DIV' },
          clientX: 10,
          clientY: 20,
          preventDefault,
          stopPropagation,
        } as never,
        [{ kind: 'separator' }],
      ),
    ).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();

    // Normal target opens menu and prevents default
    expect(
      openContextMenu(
        {
          shiftKey: false,
          target: { tagName: 'DIV' },
          clientX: 10,
          clientY: 20,
          preventDefault,
          stopPropagation,
        } as never,
        [{ label: 'Action', onSelect: noop }],
      ),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    closeContextMenu();
  });
});

describe('Editor context menu builders', () => {
  it('builds empty canvas menu with Paste, Insert submenu, and Slide actions', () => {
    const entries = buildCanvasContextMenu(makeCanvasArgs({ objectIds: [] }));
    const l = labels(entries);
    expect(l).toContain('Paste');
    expect(l).toContain('Paste as plain text');
    expect(l).toContain('Insert >');
    expect(l).toContain('Change background…');
    expect(l).toContain('Duplicate slide');
    expect(l).toContain('Select all objects');
  });

  it('builds text object menu with Edit text, Screen placement, Contrast, Align, Arrange, Delete', () => {
    const entries = buildCanvasContextMenu(makeCanvasArgs({ objectIds: ['txt-1'], primaryId: 'txt-1' }));
    const l = labels(entries);
    expect(l[0]).toBe('Edit text');
    expect(l).toContain('Screen placement >');
    expect(l).toContain('Contrast >');
    expect(l).toContain('Align to slide >');
    expect(l).toContain('Arrange >');
    expect(l[l.length - 1]).toBe('Delete');
  });

  it('builds image menu with Crop, Replace image, Mask, Fit, Flip', () => {
    const entries = buildCanvasContextMenu(makeCanvasArgs({ objectIds: ['img-1'], primaryId: 'img-1' }));
    const l = labels(entries);
    expect(l).toContain('Crop…');
    expect(l).toContain('Replace image…');
    expect(l).toContain('Mask >');
    expect(l).toContain('Fit >');
    expect(l).toContain('Flip >');
    expect(l).not.toContain('Playback >');
  });

  it('builds video menu with Replace video, Use poster only, and Playback submenu', () => {
    const entries = buildCanvasContextMenu(makeCanvasArgs({ objectIds: ['vid-1'], primaryId: 'vid-1' }));
    const l = labels(entries);
    expect(l).toContain('Replace video…');
    expect(l).toContain('Use poster only');
    expect(l).toContain('Playback >');
    expect(l).not.toContain('Crop…');
  });

  it('builds table cell menu and whole-table menu distinctly', () => {
    const cellEntries = buildCanvasContextMenu(
      makeCanvasArgs({ objectIds: ['tbl-1'], primaryId: 'tbl-1', cell: 0 }),
    );
    const cellLabels = labels(cellEntries);
    expect(cellLabels).toContain('Cut cell');
    expect(cellLabels).toContain('Copy cell');
    expect(cellLabels).toContain('Insert >');
    expect(cellLabels).toContain('Table options >');
    expect(cellLabels).toContain('Select entire table');

    const wholeEntries = buildCanvasContextMenu(makeCanvasArgs({ objectIds: ['tbl-1'], primaryId: 'tbl-1' }));
    const wholeLabels = labels(wholeEntries);
    expect(wholeLabels).toContain('Cut table');
    expect(wholeLabels).toContain('Header row');
    expect(wholeLabels).toContain('Banded rows');
    expect(wholeLabels).toContain('Delete table');
  });

  it('builds multi-select menu with count label and disables edits in readOnly mode', () => {
    const entries = buildCanvasContextMenu(
      makeCanvasArgs({ objectIds: ['txt-1', 'shp-1'], primaryId: 'txt-1', readOnly: true }),
    );
    const l = labels(entries);
    expect(l[0]).toBe('[2 objects selected]');
    const cut = entries.find((e) => e.kind !== 'separator' && e.kind !== 'label' && e.label === 'Cut');
    expect(cut && 'disabled' in cut ? cut.disabled : false).toBe(true);
  });

  it('builds table rail context menus with boundary disabled states', () => {
    const { slide } = makeDeck();
    const tbl = slide.objects.find((o) => o.id === 'tbl-1')!;
    expect(tbl.type).toBe('shape');
    if (tbl.type !== 'shape') return;

    const row0 = buildTableRailContextMenu({ o: tbl, axis: 'row', index: 0, readOnly: false });
    expect(labels(row0)[0]).toBe('[Row 1]');
    const moveUp = row0.find(
      (e) => e.kind !== 'separator' && e.kind !== 'label' && e.label === 'Move row up',
    );
    expect(moveUp && 'disabled' in moveUp ? moveUp.disabled : false).toBe(true);

    const col2 = buildTableRailContextMenu({ o: tbl, axis: 'col', index: 2, readOnly: false });
    expect(labels(col2)[0]).toBe('[Column 3]');
    const moveRight = col2.find(
      (e) => e.kind !== 'separator' && e.kind !== 'label' && e.label === 'Move column right',
    );
    expect(moveRight && 'disabled' in moveRight ? moveRight.disabled : false).toBe(true);
  });

  it('builds slide card and section header context menus', () => {
    const { p, slide } = makeDeck();
    const slideWithOverride: Slide = { ...slide, overrides: ['box'] };
    const cardMenu = buildSlideCardContextMenu({
      slide: slideWithOverride,
      p,
      readOnly: false,
      onCopy: noop,
      onCut: noop,
      onPaste: noop,
      onDuplicate: noop,
      onNewLike: noop,
      onToggleHidden: noop,
      onResetToTheme: noop,
      onDelete: noop,
    });
    expect(labels(cardMenu)).toContain('Reset to theme');
    expect(labels(cardMenu)).toContain('Hide slide');

    const secMenu = buildSectionHeaderContextMenu({
      section: p.sections[0]!,
      index: 0,
      totalSections: 2,
      readOnly: false,
      onAddSlide: noop,
      onDuplicateSection: noop,
      onRename: noop,
      onMoveDown: noop,
      onDelete: noop,
    });
    expect(labels(secMenu)).toEqual([
      'Add slide to section',
      'Duplicate section',
      'Rename section',
      '---',
      'Move section down',
      '---',
      'Delete section…',
    ]);
  });
});

describe('duplicateSection', () => {
  it('clones a section with fresh section, slide, and object IDs right after the original', () => {
    const { p } = makeDeck();
    const origSec = p.sections[0]!;
    const origSlide = origSec.slides[0]!;
    const next = duplicateSection(p, origSec.id);

    expect(next.sections.length).toBe(p.sections.length + 1);
    const cloned = next.sections[1]!;
    expect(cloned.id).not.toBe(origSec.id);
    expect(cloned.label).toBe(`${origSec.label} (copy)`);
    expect(cloned.slides.length).toBe(origSec.slides.length);
    expect(cloned.slides[0]!.id).not.toBe(origSlide.id);
    expect(cloned.slides[0]!.objects[0]!.id).not.toBe(origSlide.objects[0]!.id);
  });
});

describe('installTouchLongPress', () => {
  function makeMockDoc() {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const doc = {
      defaultView: null,
      body: { classList: { contains: () => false } },
      activeElement: null,
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
      emit: (type: string, ev: unknown) => {
        for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
      },
    };
    return doc;
  }

  it('dispatches a bubbling contextmenu event after LONG_PRESS_MENU_MS on touch hold', () => {
    vi.useFakeTimers();
    const origMouseEvent = globalThis.MouseEvent;
    globalThis.MouseEvent = class MockMouseEvent {
      type: string;
      clientX: number;
      clientY: number;
      defaultPrevented = false;
      constructor(type: string, init?: { clientX?: number; clientY?: number }) {
        this.type = type;
        this.clientX = init?.clientX ?? 0;
        this.clientY = init?.clientY ?? 0;
      }
      preventDefault() {
        this.defaultPrevented = true;
      }
    } as unknown as typeof MouseEvent;

    try {
      const doc = makeMockDoc();
      const uninstall = installTouchLongPress(doc as unknown as Document);
      const dispatched: unknown[] = [];
      const target = {
        tagName: 'DIV',
        closest: () => null,
        dispatchEvent: (ev: { preventDefault: () => void }) => {
          dispatched.push(ev);
          ev.preventDefault();
          return false;
        },
      };

      doc.emit('pointerdown', {
        pointerType: 'touch',
        isPrimary: true,
        pointerId: 1,
        clientX: 120,
        clientY: 240,
        target,
      });

      vi.advanceTimersByTime(LONG_PRESS_MENU_MS - 10);
      expect(dispatched).toHaveLength(0);

      vi.advanceTimersByTime(20);
      expect(dispatched).toHaveLength(1);
      expect((dispatched[0] as { type: string; clientX: number; clientY: number }).type).toBe('contextmenu');
      expect((dispatched[0] as { clientX: number }).clientX).toBe(120);
      expect((dispatched[0] as { clientY: number }).clientY).toBe(240);

      // Trailing click is swallowed
      const clickEv = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
      doc.emit('click', clickEv);
      expect(clickEv.preventDefault).toHaveBeenCalledTimes(1);

      uninstall();
    } finally {
      globalThis.MouseEvent = origMouseEvent;
      vi.useRealTimers();
    }
  });

  it('cancels on movement beyond LONG_PRESS_MOVE_PX, ignores mouse, and ignores [data-sort-handle]', () => {
    vi.useFakeTimers();
    const doc = makeMockDoc();
    const uninstall = installTouchLongPress(doc as unknown as Document);
    const dispatchEvent = vi.fn();

    // Movement cancels
    const normalTarget = { tagName: 'DIV', closest: () => null, dispatchEvent };
    doc.emit('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
      pointerId: 2,
      clientX: 50,
      clientY: 50,
      target: normalTarget,
    });
    doc.emit('pointermove', {
      pointerId: 2,
      clientX: 50 + LONG_PRESS_MOVE_PX + 5,
      clientY: 50,
    });
    vi.advanceTimersByTime(LONG_PRESS_MENU_MS + 50);
    expect(dispatchEvent).not.toHaveBeenCalled();

    // Mouse pointer ignored
    doc.emit('pointerdown', {
      pointerType: 'mouse',
      isPrimary: true,
      pointerId: 3,
      clientX: 50,
      clientY: 50,
      target: normalTarget,
    });
    vi.advanceTimersByTime(LONG_PRESS_MENU_MS + 50);
    expect(dispatchEvent).not.toHaveBeenCalled();

    // Sort handle ignored (leaves 300ms drag intact)
    const handleTarget = {
      tagName: 'BUTTON',
      closest: (sel: string) => (sel === '[data-sort-handle]' ? {} : null),
      dispatchEvent,
    };
    doc.emit('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
      pointerId: 4,
      clientX: 50,
      clientY: 50,
      target: handleTarget,
    });
    vi.advanceTimersByTime(LONG_PRESS_MENU_MS + 50);
    expect(dispatchEvent).not.toHaveBeenCalled();

    uninstall();
    vi.useRealTimers();
  });
});

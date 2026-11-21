/**
 * `window.__ordo.editor` (views/editor/inspect.ts) is added to the diagnostics object other modules fill,
 * and leaves their getters live: `lib/capabilities.ts` reports `persistence` and `capabilities` through
 * getters that the end-to-end specs read after the page has asked for persistent storage.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The store as an empty editor holds it (the real one wants a document once a window exists).
vi.mock('../src/views/editor/editorStore.ts', () => ({
  useEditor: { getState: () => ({ dirty: false, saving: false, conflict: false, objectIds: [] }) },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('window.__ordo.editor', () => {
  it('is added without freezing the getters already there', async () => {
    let persisted: string | undefined;
    const ordo = {
      get persistence() {
        return persisted;
      },
    };
    const w = { __ordo: ordo as Record<string, unknown> };
    vi.stubGlobal('window', w);
    const { inspectEditor } = await import('../src/views/editor/inspect.ts');
    expect(w.__ordo).toBe(ordo);
    expect(w.__ordo.editor).toBe(inspectEditor);
    persisted = 'granted';
    expect(w.__ordo.persistence).toBe('granted');
    expect(inspectEditor()).toMatchObject({ dirty: false, objectIds: [] });
  });

  it('starts the object when nothing made it yet', async () => {
    const w: { __ordo?: Record<string, unknown> } = {};
    vi.stubGlobal('window', w);
    const { inspectEditor } = await import('../src/views/editor/inspect.ts');
    expect(w.__ordo?.editor).toBe(inspectEditor);
  });

  it('reports what the canvas draws whole (views/editor/wholeState.ts), a copy of the last plan', async () => {
    vi.stubGlobal('window', { __ordo: {} as Record<string, unknown> });
    const { inspectEditor } = await import('../src/views/editor/inspect.ts');
    const { setWholeStatus, noteWholeDraw, resetWholeStatus } = await import(
      '../src/views/editor/wholeState.ts'
    );
    resetWholeStatus();
    const whole = inspectEditor().whole;
    // The fields the end-to-end specs and the measures read: every count, the three skips, why, the times.
    expect(Object.keys(whole).sort()).toEqual(
      [
        'blocked',
        'coarse',
        'drawn',
        'lastMs',
        'light',
        'live',
        'pending',
        'px',
        'skipped',
        'stale',
        'wanted',
      ].sort(),
    );
    expect(Object.keys(whole.skipped).sort()).toEqual(['bound', 'cache', 'total']);
    setWholeStatus({
      wanted: 3,
      drawn: 1,
      pending: 1,
      blocked: 0,
      px: 12,
      skipped: { bound: 0, cache: 0, total: 1 },
      stale: 0,
      live: false,
      coarse: false,
      light: false,
    });
    noteWholeDraw('p9', 7);
    const again = inspectEditor().whole;
    expect(again).toMatchObject({ wanted: 3, drawn: 1, pending: 1, px: 12, skipped: { total: 1 } });
    expect(again.lastMs).toEqual([{ id: 'p9', ms: 7 }]);
    // A copy: the page cannot change the canvas's counts through it.
    again.drawn = 99;
    again.skipped.total = 99;
    expect(inspectEditor().whole.drawn).toBe(1);
    expect(inspectEditor().whole.skipped.total).toBe(1);
    resetWholeStatus();
  });
});

/** The inspect hook reads wholeState.ts without the canvas: the module imports nothing (the tableKitState.ts pattern). */
describe('views/editor/wholeState.ts', () => {
  it('imports nothing', () => {
    const src = readFileSync(new URL('../src/views/editor/wholeState.ts', import.meta.url), 'utf8');
    expect(src.match(/^\s*(import\b|export\b[^;\n]*\bfrom\b)/gm) ?? []).toEqual([]);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});

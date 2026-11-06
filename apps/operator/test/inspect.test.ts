/**
 * `window.__ordo.editor` (views/editor/inspect.ts) is added to the diagnostics object other modules fill,
 * and leaves their getters live: `lib/capabilities.ts` reports `persistence` and `capabilities` through
 * getters that the end-to-end specs read after the page has asked for persistent storage.
 */
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
});

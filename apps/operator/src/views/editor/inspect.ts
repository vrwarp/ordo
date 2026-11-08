import type { Presentation } from '@ordo/domain';
import { useEditor } from './editorStore.ts';

/** What `window.__ordo.editor` reports: the open editor, for the end-to-end specs (e2e/editorhelpers.ts). */
export type EditorInspect = {
  id?: string;
  /** The revision the editor last saved or loaded. */
  baseRev?: number;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  slideId?: string;
  objectId?: string;
  objectIds: string[];
  /** The draft as the editor holds it (what Save would send, with the base rev). */
  draft?: Presentation;
};

/**
 * A read-only view of the editor's state on `window.__ordo.editor` (as `lib/capabilities.ts` exposes the
 * device's capabilities): nothing that the signed-in volunteer cannot already see, and no way to change it.
 */
export function inspectEditor(): EditorInspect {
  const s = useEditor.getState();
  return {
    id: s.id,
    baseRev: s.base?.rev,
    dirty: s.dirty,
    saving: s.saving,
    conflict: s.conflict,
    slideId: s.slideId,
    objectId: s.objectId,
    objectIds: [...s.objectIds],
    draft: s.draft ? structuredClone(s.draft) : undefined,
  };
}

if (typeof window !== 'undefined') {
  // Added to the object that is there, never spread into a new one: a spread would read the getters other
  // modules put there (`capabilities`, `persistence`) once, and keep their first values for good.
  const w = window as unknown as { __ordo?: Record<string, unknown> };
  w.__ordo ??= {};
  w.__ordo.editor = inspectEditor;
}

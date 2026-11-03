import { api, ApiFailure } from '@ordo/client';
import type { Presentation, SlideObject } from '@ordo/domain';
import { create } from 'zustand';
import { upsertLocal } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { History } from './history.ts';
import { getSlide } from './ops.ts';
import type { Guides } from './snapping.ts';

export type EditorState = {
  id?: string;
  /** Last saved (or loaded) version. */
  base?: Presentation;
  draft?: Presentation;
  slideId?: string;
  objectId?: string;
  dirty: boolean;
  saving: boolean;
  /** The hub refused the save with 409 (changed elsewhere). */
  conflict: boolean;
  guides: Guides;
  canUndo: boolean;
  canRedo: boolean;
  loadError?: string;
};

export const useEditor = create<EditorState>(() => ({
  dirty: false,
  saving: false,
  conflict: false,
  guides: { x: [], y: [] },
  canUndo: false,
  canRedo: false,
}));

const history = new History<Presentation>(200, 800);

function firstSlideId(p: Presentation): string | undefined {
  for (const s of p.sections) if (s.slides[0]) return s.slides[0].id;
  return undefined;
}

export function openPresentation(p: Presentation): void {
  history.clear();
  const prev = useEditor.getState();
  const keepSlide = prev.id === p.id && prev.slideId && getSlide(p, prev.slideId) ? prev.slideId : undefined;
  useEditor.setState({
    id: p.id,
    base: p,
    draft: p,
    slideId: keepSlide ?? firstSlideId(p),
    objectId: undefined,
    dirty: false,
    saving: false,
    conflict: false,
    canUndo: false,
    canRedo: false,
    loadError: undefined,
  });
}

export async function loadPresentation(id: string, fallback?: Presentation): Promise<void> {
  try {
    const p = await api<Presentation>(`/presentations/${id}`);
    openPresentation(p);
  } catch (e) {
    if (fallback) openPresentation(fallback);
    else useEditor.setState({ loadError: errorText(e) });
  }
}

/** Apply an edit to the draft and record undo. `key` coalesces rapid edits (typing, nudges). */
export function change(fn: (p: Presentation) => Presentation, key?: string): void {
  const s = useEditor.getState();
  if (!s.draft) return;
  const next = fn(s.draft);
  if (next === s.draft) return;
  history.push(s.draft, key);
  useEditor.setState({ draft: next, dirty: true, canUndo: history.canUndo, canRedo: history.canRedo });
}

export function undo(): void {
  const s = useEditor.getState();
  if (!s.draft) return;
  const prev = history.undo(s.draft);
  if (prev)
    useEditor.setState({ draft: prev, dirty: true, canUndo: history.canUndo, canRedo: history.canRedo });
  fixSelection();
}

export function redo(): void {
  const s = useEditor.getState();
  if (!s.draft) return;
  const next = history.redo(s.draft);
  if (next)
    useEditor.setState({ draft: next, dirty: true, canUndo: history.canUndo, canRedo: history.canRedo });
  fixSelection();
}

function fixSelection(): void {
  const s = useEditor.getState();
  if (!s.draft) return;
  const slide = getSlide(s.draft, s.slideId);
  if (!slide) useEditor.setState({ slideId: firstSlideId(s.draft), objectId: undefined });
  else if (s.objectId && !slide.objects.some((o) => o.id === s.objectId))
    useEditor.setState({ objectId: undefined });
}

export function selectSlide(slideId: string | undefined): void {
  useEditor.setState({ slideId, objectId: undefined });
}
export function selectObject(objectId: string | undefined): void {
  useEditor.setState({ objectId });
}

export function currentSlide() {
  const s = useEditor.getState();
  return s.draft ? getSlide(s.draft, s.slideId) : undefined;
}

export function currentObject(): SlideObject | undefined {
  const s = useEditor.getState();
  return currentSlide()?.objects.find((o) => o.id === s.objectId);
}

/** Save with the base rev. 409 opens the reload dialog; 423 means locked by the live playlist. */
export async function save(force = false): Promise<boolean> {
  const s = useEditor.getState();
  if (!s.draft || !s.base || s.saving) return false;
  useEditor.setState({ saving: true });
  try {
    let rev = s.base.rev;
    if (force) rev = (await api<Presentation>(`/presentations/${s.draft.id}`)).rev;
    const saved = await api<Presentation>(`/presentations/${s.draft.id}`, {
      method: 'PUT',
      json: { ...s.draft, rev },
    });
    upsertLocal('presentations', saved);
    const cur = useEditor.getState();
    // Keep edits made while the save was in flight.
    const stillDirty = cur.draft !== s.draft;
    useEditor.setState({
      base: saved,
      draft: stillDirty ? { ...cur.draft!, rev: saved.rev } : saved,
      dirty: stillDirty,
      saving: false,
      conflict: false,
    });
    return true;
  } catch (e) {
    useEditor.setState({ saving: false });
    if (e instanceof ApiFailure && e.status === 409) {
      useEditor.setState({ conflict: true });
      return false;
    }
    if (e instanceof ApiFailure && e.status === 423)
      toast('This presentation is in the live playlist and locked until End service.', 'warn');
    else toast(`Could not save: ${errorText(e)}`, 'error');
    return false;
  }
}

/** Discard local changes and load the latest version from the hub. */
export async function reloadLatest(): Promise<void> {
  const s = useEditor.getState();
  if (!s.id) return;
  await loadPresentation(s.id);
}

export function replaceBase(p: Presentation): void {
  openPresentation(p);
  upsertLocal('presentations', p);
}

import { api, ApiFailure } from '@ordo/client';
import type { Presentation, SlideObject } from '@ordo/domain';
import type { RevisionInfo } from '@ordo/protocol';
import { create } from 'zustand';
import { deviceProfile } from '../../lib/capabilities.ts';
import { onlyJobSaves, rebaseOnJobs } from '../../lib/pptxImport.ts';
import { saveSizeCheck } from '../../lib/sizes.ts';
import { upsertLocal } from '../../state/library.ts';
import { currentRole } from '../../state/session.ts';
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
/** Presentations already warned about this session for passing the 4 MiB budget (design/27 §3.4). */
const warnedLarge = new Set<string>();

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

/**
 * Save with the base rev. 409 opens the reload dialog; 423 means locked by the live playlist. A presentation
 * over the 4 MiB budget saves with a warning (once per session); one over the hub's 32 MiB body limit is
 * refused here with the reason (design/27 §3.4).
 */
export async function save(force = false, adopted = false): Promise<boolean> {
  const s = useEditor.getState();
  if (!s.draft || !s.base || s.saving) return false;
  const size = saveSizeCheck(s.draft);
  if (size.refuse) {
    toast(`Could not save: ${size.refuse}`, 'error');
    return false;
  }
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
    if (size.warn && !warnedLarge.has(saved.id)) {
      warnedLarge.add(saved.id);
      toast(size.warn, 'warn');
    }
    return true;
  } catch (e) {
    useEditor.setState({ saving: false });
    if (e instanceof ApiFailure && e.status === 409) {
      // Saved meanwhile only by the hub's PowerPoint jobs (version 2 of an import): take their work over and
      // save again, instead of offering to overwrite it.
      if (!force && !adopted && (await adoptJobSaves().catch(() => 'other')) === 'adopted')
        return save(false, true);
      useEditor.setState({ conflict: true });
      return false;
    }
    if (e instanceof ApiFailure && e.status === 423)
      toast(
        deviceProfile(currentRole()) === 'edit'
          ? 'This presentation is in the playlist that is live at the venue. It can be edited again after the service.'
          : 'This presentation is in the live playlist and locked until End service.',
        'warn',
      );
    else toast(`Could not save: ${errorText(e)}`, 'error');
    return false;
  }
}

/**
 * When only the hub's PowerPoint jobs saved the open presentation since it was opened (`onlyJobSaves`: its
 * LibreOffice follow-up, reference pictures, the text repair), take their revision over: the whole of it when
 * nothing is unsaved, else slide by slide (`rebaseOnJobs`), unsaved edits kept. 'other' when someone else
 * saved (the usual banner and conflict dialog apply); 'none' when there is nothing newer or the editor moved on.
 */
export async function adoptJobSaves(): Promise<'adopted' | 'other' | 'none'> {
  const s = useEditor.getState();
  if (!s.id || !s.base || !s.draft) return 'none';
  const [latest, revisions] = await Promise.all([
    api<Presentation>(`/presentations/${s.id}`),
    api<RevisionInfo[]>(`/presentations/${s.id}/revisions`),
  ]);
  if (latest.rev <= s.base.rev) return 'none';
  if (!onlyJobSaves(revisions, s.base.rev, latest.rev)) return 'other';
  const cur = useEditor.getState();
  if (cur.id !== s.id || cur.base !== s.base || !cur.draft || cur.saving) return 'none';
  upsertLocal('presentations', latest);
  if (!cur.dirty) {
    const objectId = cur.objectId;
    openPresentation(latest);
    if (objectId && currentSlide()?.objects.some((o) => o.id === objectId)) useEditor.setState({ objectId });
    return 'adopted';
  }
  useEditor.setState({ base: latest, draft: rebaseOnJobs(cur.base!, cur.draft, latest) });
  return 'adopted';
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

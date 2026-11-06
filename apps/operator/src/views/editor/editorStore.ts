import { api, ApiFailure } from '@ordo/client';
import type { Presentation, SlideObject } from '@ordo/domain';
import type { RevisionInfo } from '@ordo/protocol';
import { create } from 'zustand';
import { deviceProfile } from '../../lib/capabilities.ts';
import { onlyJobSaves, rebaseOnJobs } from '../../lib/pptxImport.ts';
import { saveSizeCheck } from '../../lib/sizes.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { currentRole } from '../../state/session.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { History } from './history.ts';
import { type MergeConflict, prepareMerge, same, theirsOf } from './merge.ts';
import { getSlide } from './ops.ts';
import type { Guides } from './snapping.ts';

export type EditorState = {
  id?: string;
  /** Last saved (or loaded) version. */
  base?: Presentation;
  draft?: Presentation;
  slideId?: string;
  /** The primary selected object: the one the Object panel edits (M4 item B: `Selection.primary`). */
  objectId?: string;
  /**
   * Every selected object, in the slide's z order (a group selected by a click, members added with Shift):
   * empty with no selection, `[objectId]` for one object. Always contains `objectId` when it is set.
   */
  objectIds: string[];
  dirty: boolean;
  saving: boolean;
  /** The hub refused the save with 409 (changed elsewhere). */
  conflict: boolean;
  /**
   * What the last 409's three-way merge could not combine (M4 item H; the conflict dialog lists it): empty when
   * there was nothing to merge (no version in the answer, or 'Save mine anyway').
   */
  mergeConflicts: MergeConflict[];
  guides: Guides;
  canUndo: boolean;
  canRedo: boolean;
  loadError?: string;
};

export const useEditor = create<EditorState>(() => ({
  objectIds: [],
  dirty: false,
  saving: false,
  conflict: false,
  mergeConflicts: [],
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
    objectIds: [],
    dirty: false,
    saving: false,
    conflict: false,
    mergeConflicts: [],
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
  if (!slide) {
    useEditor.setState({ slideId: firstSlideId(s.draft), objectId: undefined, objectIds: [] });
    return;
  }
  // A state set with `objectId` alone (older callers) selects that one object.
  const sel = s.objectIds.length ? s.objectIds : s.objectId ? [s.objectId] : [];
  const ids = sel.filter((id) => slide.objects.some((o) => o.id === id));
  const primary = s.objectId && ids.includes(s.objectId) ? s.objectId : ids[0];
  if (primary !== s.objectId || ids.length !== s.objectIds.length)
    useEditor.setState({ objectId: primary, objectIds: ids });
}

export function selectSlide(slideId: string | undefined): void {
  useEditor.setState({ slideId, objectId: undefined, objectIds: [] });
}
/** Select one object (or none): it is the whole selection. */
export function selectObject(objectId: string | undefined): void {
  useEditor.setState({ objectId, objectIds: objectId ? [objectId] : [] });
}
/**
 * Select several objects (a group, design/27 §11 item 5): `ids` kept in the open slide's z order, `primary`
 * (default: the first of `ids`) the one the Object panel edits. Ids not on the open slide are left out.
 */
export function selectObjects(ids: readonly string[], primary?: string): void {
  const slide = currentSlide();
  const want = new Set(ids);
  const ordered = slide ? slide.objects.filter((o) => want.has(o.id)).map((o) => o.id) : [];
  const first = primary && ordered.includes(primary) ? primary : ids.find((id) => ordered.includes(id));
  useEditor.setState({ objectId: first, objectIds: ordered });
}

export function currentSlide() {
  const s = useEditor.getState();
  return s.draft ? getSlide(s.draft, s.slideId) : undefined;
}

export function currentObject(): SlideObject | undefined {
  const s = useEditor.getState();
  return currentSlide()?.objects.find((o) => o.id === s.objectId);
}

/** Every selected object of the open slide, in z order. */
export function currentObjects(): SlideObject[] {
  const s = useEditor.getState();
  const ids = new Set(s.objectIds);
  return currentSlide()?.objects.filter((o) => ids.has(o.id)) ?? [];
}

/** A save merges someone else's version at most this many times before it shows the conflict dialog. */
const MAX_MERGES = 3;

/**
 * Save with the base rev. On 409 the editor first takes over a revision only the PowerPoint jobs saved
 * (`adoptJobSaves`), else merges the version that won (`mergeTheirs`) and saves again (a second 409 merges
 * again, `MAX_MERGES` at most), else opens the conflict dialog with what could not be merged. `force` ('Save
 * mine anyway') saves over theirs without merging. 423 means locked by the live playlist. A presentation
 * over the 4 MiB budget saves with a warning (once per session); one over the hub's 32 MiB body limit is
 * refused here with the reason (design/27 §3.4). `merges` counts the merges this save made.
 */
export async function save(force = false, adopted = false, merges = 0): Promise<boolean> {
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
      mergeConflicts: [],
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
        return save(false, true, merges);
      // Saved by someone else: their version merged with the draft and saved again (design/27 §11 item 17).
      const merged = force || merges >= MAX_MERGES ? undefined : mergeTheirs(s, theirsOf(e));
      if (merged === 'same') return true;
      if (merged === 'merged') {
        const ok = await save(false, adopted, merges + 1);
        if (ok && merges === 0) toast('Saved together with the changes someone else saved meanwhile.', 'ok');
        return ok;
      }
      useEditor.setState({ conflict: true, mergeConflicts: merged ?? [] });
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

const content = (p: Presentation) => {
  const { rev: _rev, createdAt: _c, updatedAt: _u, ...rest } = p;
  return rest;
};

/**
 * Merge `theirs` (the version that won a 409, `theirsOf`) with the draft over the base (M4 item H, `merge.ts`).
 * Merged: the draft becomes the merge on theirs' revision, its undo and redo steps move onto theirs too, and
 * the caller saves again ('merged'); 'same' when theirs already holds every change of the draft (nothing is
 * left to save). The conflicts when it cannot merge; undefined when there is nothing to merge with, or the
 * editor moved on since the save began (`start`).
 */
function mergeTheirs(
  start: EditorState,
  theirs: Presentation | undefined,
): 'merged' | 'same' | MergeConflict[] | undefined {
  const cur = useEditor.getState();
  const { base, draft } = cur;
  if (!theirs || !base || !draft || cur.saving || cur.id !== start.id || base !== start.base)
    return undefined;
  if (theirs.id !== base.id || theirs.rev <= base.rev) return undefined;
  const merge = prepareMerge(base, theirs);
  const r = merge(draft, true);
  if (!r.merged) return r.conflicts;
  const nothingLeft = same(content(r.merged), content(theirs));
  history.rebase((snapshot) => merge(snapshot).merged);
  useEditor.setState({
    base: theirs,
    draft: nothingLeft ? theirs : r.merged,
    dirty: !nothingLeft,
    conflict: false,
    mergeConflicts: [],
    canUndo: history.canUndo,
    canRedo: history.canRedo,
  });
  fixSelection();
  // Nothing to save: the library takes theirs over (unless it already holds a newer one).
  const lib = useLibrary.getState().data.presentations.find((x) => x.id === theirs.id);
  if (nothingLeft && (!lib || lib.rev < theirs.rev)) upsertLocal('presentations', theirs);
  return nothingLeft ? 'same' : 'merged';
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
    const { objectId, objectIds } = cur;
    openPresentation(latest);
    const kept = objectIds.filter((id) => currentSlide()?.objects.some((o) => o.id === id));
    if (kept.length) selectObjects(kept, objectId);
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

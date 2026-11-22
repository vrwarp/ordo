import { ApiFailure, api } from '@ordo/client';
import type { Presentation, SlideObject } from '@ordo/domain';
import type { RevisionInfo } from '@ordo/protocol';
import { create } from 'zustand';
import { deviceProfile } from '../../lib/capabilities.ts';
import { onlyJobSaves, rebaseOnJobs } from '../../lib/pptxImport.ts';
import { saveSizeCheck } from '../../lib/sizes.ts';
import { type EditorUiPersist, journalPut, journalRemove } from '../../state/draftJournal.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { currentRole } from '../../state/session.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { removeUnsaved, upsertUnsaved } from '../../state/unsaved.ts';
import { navigate } from '../../useRoute.ts';
import { History } from './history.ts';
import { type MergeConflict, prepareMerge, same, theirsOf } from './merge.ts';
import { getSlide } from './ops.ts';
import type { TableRange } from './ops/table.ts';
import type { Guides } from './snapping.ts';

export type CanvasTextSelection = {
  start: number;
  end: number;
  caret: number;
};

/**
 * What a text edit goes to (design/15 "Table editing"): a text object, or one cell of a table (`cell`, its
 * index in `TableData.cells`), edited as the cell's text object view and written back through `setCell`.
 */
export type TextTarget = { objectId: string; cell?: number };

export type EditorUiState = {
  tab: 'object' | 'slide' | 'presentation';
  drawerOpen: boolean;
  stageLens: 'canvas' | string;
  keepLoop: boolean;
  songMode: 'reflow' | 'canvas' | null;
  deckMode: 'canvas' | 'notes';
  notesDockOpen: boolean | null;
  zoom: 'fit' | 0.5 | 0.75 | 1;
};

export const DEFAULT_EDITOR_UI: EditorUiState = {
  tab: 'slide',
  drawerOpen: false,
  stageLens: 'canvas',
  keepLoop: false,
  songMode: null,
  deckMode: 'canvas',
  notesDockOpen: null,
  zoom: 'fit',
};

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
  /**
   * The selected cell of the primary object when it is a table (its index in `TableData.cells`): the cell the
   * table bar and panel edit. Undefined: the whole table (or no table).
   */
  cell?: number;
  /**
   * Optional multi-cell rectangular selection range of the primary table (`r0..r1`, `c0..c1`, inclusive).
   * When set, formatting, cell fill, borders, merge, and Delete apply to all cells in this range.
   */
  cellRange?: TableRange;
  inlineEditingId?: string;
  /**
   * With `inlineEditingId` a table's id: the cell edited on the canvas. The inline target is
   * `{ objectId: inlineEditingId, cell: inlineEditingCell }` (`inlineTarget`).
   */
  inlineEditingCell?: number;
  textRange: CanvasTextSelection;
  loadError?: string;
  ui: EditorUiState;
};

type PresentationSession = {
  id: string;
  base: Presentation;
  draft: Presentation;
  history: History<Presentation>;
  slideId?: string;
  objectId?: string;
  objectIds: string[];
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  mergeConflicts: MergeConflict[];
  cell?: number;
  cellRange?: TableRange;
  ui: EditorUiState;
};

const EMPTY_TEXT_RANGE: CanvasTextSelection = { start: 0, end: 0, caret: 0 };
const EMPTY_GUIDES: Guides = { x: [], y: [] };

export const useEditor = create<EditorState>(() => ({
  objectIds: [],
  dirty: false,
  saving: false,
  conflict: false,
  mergeConflicts: [],
  guides: EMPTY_GUIDES,
  canUndo: false,
  canRedo: false,
  inlineEditingId: undefined,
  textRange: EMPTY_TEXT_RANGE,
  ui: { ...DEFAULT_EDITOR_UI },
}));

/** Active undo/redo stack for the presentation currently mounted in `useEditor`. */
let history = new History<Presentation>(200, 800);
/** Dirty (or conflicted / saving) presentation sessions kept across tab and presentation switches. */
const sessions = new Map<string, PresentationSession>();
/** Lightweight workspace state remembered for clean presentations visited during this session. */
const uiMemory = new Map<string, { slideId?: string; ui: EditorUiState }>();
/** Monotonic target id for `enterPresentation` so an earlier presentation's slow GET cannot clobber a newer one. */
let wantedPresentationId: string | undefined;

/** Presentations already warned about this session for passing the presentation budget (8 MiB, design/27 §3.4). */
const warnedLarge = new Set<string>();

const content = (p: Presentation) => {
  const { rev: _rev, createdAt: _c, updatedAt: _u, ...rest } = p;
  return rest;
};

function isDraftDirty(base: Presentation | undefined, draft: Presentation | undefined): boolean {
  if (!base || !draft || draft === base) return false;
  return !same(content(draft), content(base));
}

function toUiPersist(ui: EditorUiState): EditorUiPersist {
  return {
    tab: ui.tab,
    drawerOpen: ui.drawerOpen,
    stageLens: ui.stageLens,
    songMode: ui.songMode,
    deckMode: ui.deckMode,
    notesDockOpen: ui.notesDockOpen,
    zoom: ui.zoom,
  };
}

function fromUiPersist(p?: EditorUiPersist): EditorUiState {
  return {
    tab: p?.tab ?? DEFAULT_EDITOR_UI.tab,
    drawerOpen: p?.drawerOpen ?? DEFAULT_EDITOR_UI.drawerOpen,
    stageLens: p?.stageLens ?? DEFAULT_EDITOR_UI.stageLens,
    keepLoop: false,
    songMode: p?.songMode ?? DEFAULT_EDITOR_UI.songMode,
    deckMode: p?.deckMode ?? DEFAULT_EDITOR_UI.deckMode,
    notesDockOpen: p?.notesDockOpen ?? DEFAULT_EDITOR_UI.notesDockOpen,
    zoom: p?.zoom ?? DEFAULT_EDITOR_UI.zoom,
  };
}

function syncRegistryForSession(sess: PresentationSession | undefined, id: string): void {
  const regKey = `pres:${id}`;
  if (!sess?.dirty) {
    removeUnsaved(regKey);
    journalRemove(regKey);
    return;
  }
  upsertUnsaved({
    key: regKey,
    kind: 'presentation',
    id,
    label: sess.draft.title || 'Untitled presentation',
    route: { name: 'edit', id },
    saving: sess.saving,
    save: () => savePresentationById(id),
    discard: () => discardPresentationById(id),
  });
  journalPut(regKey, {
    kind: 'presentation',
    id,
    base: sess.base,
    draft: sess.draft,
    slideId: sess.slideId,
    ui: toUiPersist(sess.ui),
    updatedAt: Date.now(),
  });
}

/** Snapshot the active `useEditor` state into `sessions` (when dirty/saving/conflicted) and `unsaved` / `draftJournal`. */
function syncActiveToSessions(): void {
  const s = useEditor.getState();
  if (!s.id || !s.base || !s.draft) return;
  uiMemory.set(s.id, { slideId: s.slideId, ui: { ...s.ui } });
  if (s.dirty || s.saving || s.conflict) {
    const sess: PresentationSession = {
      id: s.id,
      base: s.base,
      draft: s.draft,
      history,
      slideId: s.slideId,
      objectId: s.objectId,
      objectIds: [...s.objectIds],
      dirty: s.dirty,
      saving: s.saving,
      conflict: s.conflict,
      mergeConflicts: [...s.mergeConflicts],
      cell: s.cell,
      cellRange: s.cellRange,
      ui: { ...s.ui },
    };
    sessions.set(s.id, sess);
    syncRegistryForSession(sess, s.id);
  } else {
    sessions.delete(s.id);
    syncRegistryForSession(undefined, s.id);
  }
}

/** Park the currently active presentation in `sessions` (if dirty) before switching to another presentation. */
export function parkActivePresentation(): void {
  syncActiveToSessions();
}

function activateSession(sess: PresentationSession): void {
  history = sess.history;
  useEditor.setState({
    id: sess.id,
    base: sess.base,
    draft: sess.draft,
    slideId: sess.slideId ?? firstSlideId(sess.draft),
    objectId: sess.objectId,
    objectIds: [...sess.objectIds],
    dirty: sess.dirty,
    saving: sess.saving,
    conflict: sess.conflict,
    mergeConflicts: [...sess.mergeConflicts],
    guides: EMPTY_GUIDES,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    cell: sess.cell,
    cellRange: sess.cellRange,
    inlineEditingId: undefined,
    inlineEditingCell: undefined,
    textRange: EMPTY_TEXT_RANGE,
    loadError: undefined,
    ui: { ...sess.ui },
  });
  fixSelection();
}

export function setEditorUi(
  patch: Partial<EditorUiState> | ((prev: EditorUiState) => Partial<EditorUiState>),
): void {
  const cur = useEditor.getState();
  const delta = typeof patch === 'function' ? patch(cur.ui) : patch;
  const nextUi: EditorUiState = { ...cur.ui, ...delta };
  useEditor.setState({ ui: nextUi });
  if (cur.id) {
    uiMemory.set(cur.id, { slideId: cur.slideId, ui: nextUi });
    const sess = sessions.get(cur.id);
    if (sess) {
      sess.ui = nextUi;
      if (sess.dirty) syncRegistryForSession(sess, cur.id);
    }
  }
}

export function setTextRange(range: { start: number; end: number; caret?: number }): void {
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.max(start, Math.max(range.start, range.end));
  const caret = range.caret !== undefined ? Math.max(start, Math.min(end, range.caret)) : end;
  const cur = useEditor.getState().textRange;
  if (cur.start === start && cur.end === end && cur.caret === caret) return;
  useEditor.setState({ textRange: { start, end, caret } });
}

/**
 * Start editing on the canvas: a text object, or with `cell` that cell of a table (which becomes the selected
 * cell), with the selection `range` (else the one kept).
 */
export function startInlineEditing(
  objectId: string,
  range?: { start: number; end: number; caret?: number },
  cell?: number,
): void {
  const at =
    cell === undefined
      ? { inlineEditingCell: undefined, cellRange: undefined }
      : { inlineEditingCell: cell, cell, cellRange: undefined };
  if (range) {
    const start = Math.max(0, Math.min(range.start, range.end));
    const end = Math.max(start, Math.max(range.start, range.end));
    const caret = range.caret !== undefined ? Math.max(start, Math.min(end, range.caret)) : end;
    useEditor.setState({ inlineEditingId: objectId, ...at, textRange: { start, end, caret } });
  } else {
    useEditor.setState({ inlineEditingId: objectId, ...at });
  }
}

export function stopInlineEditing(): void {
  useEditor.setState({ inlineEditingId: undefined, inlineEditingCell: undefined });
}

/** What the canvas edits inline: a text object, or a table's cell; undefined when nothing is edited. */
export function inlineTarget(s: EditorState = useEditor.getState()): TextTarget | undefined {
  if (!s.inlineEditingId) return undefined;
  return s.inlineEditingCell === undefined
    ? { objectId: s.inlineEditingId }
    : { objectId: s.inlineEditingId, cell: s.inlineEditingCell };
}

/**
 * Select cell `cell` of table `objectId` (the table alone becomes the selection), or with `undefined` the
 * whole table. A new cell starts with an empty text selection; editing another target on the canvas stops.
 */
export function selectCell(objectId: string, cell: number | undefined): void {
  useEditor.setState((s) => {
    const sameCell = s.objectId === objectId && s.cell === cell && !s.cellRange;
    const editing = s.inlineEditingId === objectId && s.inlineEditingCell === cell && cell !== undefined;
    return {
      objectId,
      objectIds: [objectId],
      cell,
      cellRange: undefined,
      inlineEditingId: editing ? s.inlineEditingId : undefined,
      inlineEditingCell: editing ? s.inlineEditingCell : undefined,
      textRange: sameCell ? s.textRange : EMPTY_TEXT_RANGE,
    };
  });
  syncActiveToSessions();
}

/**
 * Select a rectangular cell range of table `objectId`, keeping `anchorCell` as the primary `cell`.
 * Stops inline editing since multi-cell operations act on the range as a whole.
 */
export function selectCellRange(objectId: string, anchorCell: number, range: TableRange): void {
  useEditor.setState({
    objectId,
    objectIds: [objectId],
    cell: anchorCell,
    cellRange: range,
    inlineEditingId: undefined,
    inlineEditingCell: undefined,
    textRange: EMPTY_TEXT_RANGE,
  });
  syncActiveToSessions();
}

function firstSlideId(p: Presentation): string | undefined {
  for (const s of p.sections) if (s.slides[0]) return s.slides[0].id;
  return undefined;
}

/**
 * Open presentation `p` cleanly as the active presentation (clearing any prior draft/history for `p.id`).
 * Any *other* presentation that was active and dirty is parked in `sessions` first so its edits are never lost.
 */
export function openPresentation(p: Presentation): void {
  const prev = useEditor.getState();
  if (prev.id && prev.id !== p.id) {
    syncActiveToSessions();
  }
  wantedPresentationId = p.id;
  sessions.delete(p.id);
  syncRegistryForSession(undefined, p.id);
  history = new History<Presentation>(200, 800);
  const remembered = uiMemory.get(p.id);
  const candidateSlide = prev.id === p.id && prev.slideId ? prev.slideId : remembered?.slideId;
  const keepSlide = candidateSlide && getSlide(p, candidateSlide) ? candidateSlide : undefined;
  const nextUi = remembered ? { ...remembered.ui } : { ...DEFAULT_EDITOR_UI };
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
    guides: EMPTY_GUIDES,
    canUndo: false,
    canRedo: false,
    cell: undefined,
    cellRange: undefined,
    inlineEditingId: undefined,
    inlineEditingCell: undefined,
    textRange: EMPTY_TEXT_RANGE,
    loadError: undefined,
    ui: nextUi,
  });
}

export async function loadPresentation(id: string, fallback?: Presentation): Promise<void> {
  wantedPresentationId = id;
  try {
    const p = await api<Presentation>(`/presentations/${id}`);
    if (wantedPresentationId !== id) return;
    openPresentation(p);
  } catch (e) {
    if (wantedPresentationId !== id) return;
    if (fallback) openPresentation(fallback);
    else useEditor.setState({ loadError: errorText(e) });
  }
}

/**
 * Enter `#/edit/:id` from `EditorView`: parks any previous presentation's edits, restores a parked dirty
 * session for `id` immediately with its full undo stack and workspace UI, or loads fresh from the hub when clean.
 */
export async function enterPresentation(id: string, fallback?: Presentation): Promise<void> {
  const cur = useEditor.getState();
  if (cur.id === id && (cur.dirty || cur.saving || cur.conflict) && cur.draft) {
    wantedPresentationId = id;
    syncActiveToSessions();
    return;
  }
  syncActiveToSessions();
  wantedPresentationId = id;
  const parked = sessions.get(id);
  if (parked && (parked.dirty || parked.saving || parked.conflict)) {
    activateSession(parked);
    return;
  }
  await loadPresentation(id, fallback);
}

/** Apply an edit to the draft and record undo. `key` coalesces rapid edits (typing, nudges). */
export function change(fn: (p: Presentation) => Presentation, key?: string): void {
  const s = useEditor.getState();
  if (!s.draft) return;
  const next = fn(s.draft);
  if (next === s.draft) return;
  history.push(s.draft, key);
  const dirty = isDraftDirty(s.base, next);
  useEditor.setState({ draft: next, dirty, canUndo: history.canUndo, canRedo: history.canRedo });
  syncActiveToSessions();
}

export function undo(): void {
  const s = useEditor.getState();
  if (!s.draft) return;
  const prev = history.undo(s.draft);
  if (prev) {
    const dirty = isDraftDirty(s.base, prev);
    useEditor.setState({ draft: prev, dirty, canUndo: history.canUndo, canRedo: history.canRedo });
  }
  fixSelection();
  syncActiveToSessions();
}

export function redo(): void {
  const s = useEditor.getState();
  if (!s.draft) return;
  const next = history.redo(s.draft);
  if (next) {
    const dirty = isDraftDirty(s.base, next);
    useEditor.setState({ draft: next, dirty, canUndo: history.canUndo, canRedo: history.canRedo });
  }
  fixSelection();
  syncActiveToSessions();
}

function fixSelection(): void {
  const s = useEditor.getState();
  if (!s.draft) return;
  const slide = getSlide(s.draft, s.slideId);
  if (!slide) {
    useEditor.setState({
      slideId: firstSlideId(s.draft),
      objectId: undefined,
      objectIds: [],
      cell: undefined,
      cellRange: undefined,
      inlineEditingId: undefined,
      inlineEditingCell: undefined,
    });
    return;
  }
  // A state set with `objectId` alone (older callers) selects that one object.
  const sel = s.objectIds.length ? s.objectIds : s.objectId ? [s.objectId] : [];
  const ids = sel.filter((id) => slide.objects.some((o) => o.id === id));
  const primary = s.objectId && ids.includes(s.objectId) ? s.objectId : ids[0];
  if (primary !== s.objectId || ids.length !== s.objectIds.length)
    useEditor.setState({ objectId: primary, objectIds: ids });
  // A cell an undo took away (a row or column inserted, then undone) is no longer selected nor edited.
  const hasCell = (id: string | undefined, i: number | undefined) => {
    const o = id === undefined || i === undefined ? undefined : slide.objects.find((x) => x.id === id);
    return o?.type === 'shape' && !!o.table && i! < o.table.cells.length;
  };
  const st = useEditor.getState();
  if (st.cell !== undefined && !hasCell(st.objectId, st.cell))
    useEditor.setState({ cell: undefined, cellRange: undefined });
  else if (st.cellRange) {
    const o = st.objectId ? slide.objects.find((x) => x.id === st.objectId) : undefined;
    if (
      o?.type !== 'shape' ||
      !o.table ||
      st.cellRange.r1 >= o.table.rows.length ||
      st.cellRange.c1 >= o.table.cols.length
    ) {
      useEditor.setState({ cellRange: undefined });
    }
  }
  if (st.inlineEditingCell !== undefined && !hasCell(st.inlineEditingId, st.inlineEditingCell))
    useEditor.setState({ inlineEditingId: undefined, inlineEditingCell: undefined });
}

export function selectSlide(slideId: string | undefined): void {
  useEditor.setState({
    slideId,
    objectId: undefined,
    objectIds: [],
    cell: undefined,
    cellRange: undefined,
    inlineEditingId: undefined,
    inlineEditingCell: undefined,
    textRange: EMPTY_TEXT_RANGE,
  });
  syncActiveToSessions();
}

/** Select one object (or none): it is the whole selection. The object already selected keeps its cell. */
export function selectObject(objectId: string | undefined): void {
  useEditor.setState((s) => {
    const sameObj = !!objectId && objectId === s.objectId;
    const editing = !!objectId && objectId === s.inlineEditingId;
    return {
      objectId,
      objectIds: objectId ? [objectId] : [],
      cell: sameObj ? s.cell : undefined,
      cellRange: sameObj ? s.cellRange : undefined,
      inlineEditingId: editing ? s.inlineEditingId : undefined,
      inlineEditingCell: editing ? s.inlineEditingCell : undefined,
      textRange: sameObj ? s.textRange : EMPTY_TEXT_RANGE,
    };
  });
  syncActiveToSessions();
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
  useEditor.setState((s) => ({
    objectId: first,
    objectIds: ordered,
    cell: ordered.length === 1 && first === s.objectId ? s.cell : undefined,
    cellRange: ordered.length === 1 && first === s.objectId ? s.cellRange : undefined,
    inlineEditingId: undefined,
    inlineEditingCell: undefined,
    textRange: first && first === s.objectId ? s.textRange : EMPTY_TEXT_RANGE,
  }));
  syncActiveToSessions();
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
 * over the 8 MiB budget saves with a warning (once per session); one over the hub's 32 MiB body limit is
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
  syncActiveToSessions();
  try {
    let rev = s.base.rev;
    if (force) rev = (await api<Presentation>(`/presentations/${s.draft.id}`)).rev;
    const saved = await api<Presentation>(`/presentations/${s.draft.id}`, {
      method: 'PUT',
      json: { ...s.draft, rev },
    });
    upsertLocal('presentations', saved);
    const cur = useEditor.getState();
    if (cur.id === saved.id) {
      // Keep edits made while the save was in flight.
      const stillDirty = Boolean(cur.draft && cur.draft !== s.draft && isDraftDirty(saved, cur.draft));
      useEditor.setState({
        base: saved,
        draft: stillDirty ? { ...cur.draft!, rev: saved.rev } : saved,
        dirty: stillDirty,
        saving: false,
        conflict: false,
        mergeConflicts: [],
      });
      syncActiveToSessions();
    } else {
      // User switched to another presentation while PUT was in flight: clean up the parked session.
      const parked = sessions.get(saved.id);
      if (parked && parked.draft !== s.draft && isDraftDirty(saved, parked.draft)) {
        parked.base = saved;
        parked.draft = { ...parked.draft, rev: saved.rev };
        parked.dirty = true;
        parked.saving = false;
        parked.conflict = false;
        parked.mergeConflicts = [];
        syncRegistryForSession(parked, saved.id);
      } else {
        sessions.delete(saved.id);
        syncRegistryForSession(undefined, saved.id);
      }
    }
    if (size.warn && !warnedLarge.has(saved.id)) {
      warnedLarge.add(saved.id);
      toast(size.warn, 'warn');
    }
    return true;
  } catch (e) {
    if (useEditor.getState().id === s.id) {
      useEditor.setState({ saving: false });
      syncActiveToSessions();
    } else {
      const parked = s.id ? sessions.get(s.id) : undefined;
      if (parked) {
        parked.saving = false;
        syncRegistryForSession(parked, parked.id);
      }
    }
    if (e instanceof ApiFailure && e.status === 409) {
      // Saved meanwhile only by the hub's PowerPoint jobs (version 2 of an import): take their work over and
      // save again, instead of offering to overwrite it.
      if (!force && !adopted && useEditor.getState().id === s.id) {
        if ((await adoptJobSaves().catch(() => 'other')) === 'adopted') return save(false, true, merges);
      }
      // Saved by someone else: their version merged with the draft and saved again (design/27 §11 item 17).
      const merged = force || merges >= MAX_MERGES ? undefined : mergeTheirs(s, theirsOf(e));
      if (merged === 'same') return true;
      if (merged === 'merged') {
        const ok = await save(false, adopted, merges + 1);
        if (ok && merges === 0) toast('Saved together with the changes someone else saved meanwhile.', 'ok');
        return ok;
      }
      if (useEditor.getState().id === s.id) {
        useEditor.setState({ conflict: true, mergeConflicts: merged ?? [] });
        syncActiveToSessions();
      }
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
 * Save any dirty presentation by `id` (active or parked in `sessions`, e.g. from the Nav unsaved popover or
 * `Save & Go live`). If a parked presentation hits an unmergeable 409 conflict, activates it and opens `#/edit/:id`
 * so the ConflictDialog can resolve it.
 */
export async function savePresentationById(
  id: string,
  force = false,
  adopted = false,
  merges = 0,
): Promise<boolean> {
  if (useEditor.getState().id === id) {
    return save(force, adopted, merges);
  }
  const sess = sessions.get(id);
  if (!sess || sess.saving) return false;
  const size = saveSizeCheck(sess.draft);
  if (size.refuse) {
    toast(`Could not save “${sess.draft.title}”: ${size.refuse}`, 'error');
    return false;
  }
  sess.saving = true;
  syncRegistryForSession(sess, id);
  try {
    let rev = sess.base.rev;
    if (force) rev = (await api<Presentation>(`/presentations/${id}`)).rev;
    const saved = await api<Presentation>(`/presentations/${id}`, {
      method: 'PUT',
      json: { ...sess.draft, rev },
    });
    upsertLocal('presentations', saved);
    sessions.delete(id);
    syncRegistryForSession(undefined, id);
    if (size.warn && !warnedLarge.has(saved.id)) {
      warnedLarge.add(saved.id);
      toast(size.warn, 'warn');
    }
    return true;
  } catch (e) {
    sess.saving = false;
    syncRegistryForSession(sess, id);
    if (e instanceof ApiFailure && e.status === 409) {
      if (!force && !adopted && (await adoptParkedJobSaves(sess).catch(() => 'other')) === 'adopted') {
        return savePresentationById(id, false, true, merges);
      }
      const theirs = theirsOf(e);
      if (
        !force &&
        merges < MAX_MERGES &&
        theirs &&
        theirs.id === sess.base.id &&
        theirs.rev > sess.base.rev
      ) {
        const merge = prepareMerge(sess.base, theirs);
        const r = merge(sess.draft, true);
        if (r.merged) {
          const nothingLeft = same(content(r.merged), content(theirs));
          sess.history.rebase((snapshot) => merge(snapshot).merged);
          if (nothingLeft) {
            const lib = useLibrary.getState().data.presentations.find((x) => x.id === theirs.id);
            if (!lib || lib.rev < theirs.rev) upsertLocal('presentations', theirs);
            sessions.delete(id);
            syncRegistryForSession(undefined, id);
            return true;
          }
          sess.base = theirs;
          sess.draft = r.merged;
          sess.dirty = true;
          syncRegistryForSession(sess, id);
          const ok = await savePresentationById(id, false, adopted, merges + 1);
          if (ok && merges === 0)
            toast('Saved together with the changes someone else saved meanwhile.', 'ok');
          return ok;
        }
        sess.conflict = true;
        sess.mergeConflicts = r.conflicts;
      } else {
        sess.conflict = true;
        sess.mergeConflicts = [];
      }
      syncRegistryForSession(sess, id);
      syncActiveToSessions();
      activateSession(sess);
      navigate({ name: 'edit', id });
      return false;
    }
    if (e instanceof ApiFailure && e.status === 423)
      toast(
        deviceProfile(currentRole()) === 'edit'
          ? `“${sess.draft.title}” is in the playlist that is live at the venue. It can be edited again after the service.`
          : `“${sess.draft.title}” is in the live playlist and locked until End service.`,
        'warn',
      );
    else toast(`Could not save “${sess.draft.title}”: ${errorText(e)}`, 'error');
    return false;
  }
}

async function adoptParkedJobSaves(sess: PresentationSession): Promise<'adopted' | 'other' | 'none'> {
  const [latest, revisions] = await Promise.all([
    api<Presentation>(`/presentations/${sess.id}`),
    api<RevisionInfo[]>(`/presentations/${sess.id}/revisions`),
  ]);
  if (latest.rev <= sess.base.rev) return 'none';
  if (!onlyJobSaves(revisions, sess.base.rev, latest.rev)) return 'other';
  upsertLocal('presentations', latest);
  const oldBase = sess.base;
  const reimported = revisions.some(
    (r) => r.rev > oldBase.rev && r.rev <= latest.rev && r.savedBy === 'pptx-reimport',
  );
  if (reimported) {
    const merge = prepareMerge(oldBase, latest);
    const r = merge(sess.draft, true);
    if (!r.merged) return 'other';
    sess.draft = r.merged;
    sess.history.rebase((snapshot) => merge(snapshot).merged);
  } else {
    sess.draft = rebaseOnJobs(oldBase, sess.draft, latest);
    sess.history.rebase((snapshot) => rebaseOnJobs(oldBase, snapshot, latest));
  }
  sess.base = latest;
  sess.dirty = isDraftDirty(latest, sess.draft);
  syncRegistryForSession(sess.dirty ? sess : undefined, sess.id);
  return 'adopted';
}

/** Discard unsaved changes for presentation `id` (active or parked). */
export async function discardPresentationById(id: string): Promise<void> {
  sessions.delete(id);
  syncRegistryForSession(undefined, id);
  if (useEditor.getState().id === id) {
    const libP = useLibrary.getState().data.presentations.find((p) => p.id === id);
    await loadPresentation(id, libP);
  }
}

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
  syncActiveToSessions();
  // Nothing to save: the library takes theirs over (unless it already holds a newer one).
  const lib = useLibrary.getState().data.presentations.find((x) => x.id === theirs.id);
  if (nothingLeft && (!lib || lib.rev < theirs.rev)) upsertLocal('presentations', theirs);
  return nothingLeft ? 'same' : 'merged';
}

/**
 * When only the hub's PowerPoint jobs saved the open presentation since it was opened (`onlyJobSaves`: its
 * LibreOffice follow-up, reference pictures, the text repair, a re-import), take their revision over: the
 * whole of it when nothing is unsaved, else with the unsaved edits kept.
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
  const oldBase = cur.base!;
  const reimported = revisions.some(
    (r) => r.rev > oldBase.rev && r.rev <= latest.rev && r.savedBy === 'pptx-reimport',
  );
  let draft: Presentation;
  let move: (snapshot: Presentation) => Presentation | undefined;
  if (reimported) {
    const merge = prepareMerge(oldBase, latest);
    const r = merge(cur.draft, true);
    if (!r.merged) return 'other';
    draft = r.merged;
    move = (snapshot) => merge(snapshot).merged;
  } else {
    draft = rebaseOnJobs(oldBase, cur.draft, latest);
    move = (snapshot) => rebaseOnJobs(oldBase, snapshot, latest);
  }
  history.rebase(move);
  const dirty = isDraftDirty(latest, draft);
  useEditor.setState({ base: latest, draft, dirty, canUndo: history.canUndo, canRedo: history.canRedo });
  fixSelection();
  syncActiveToSessions();
  return 'adopted';
}

/** Discard local changes and load the latest version from the hub. */
export async function reloadLatest(): Promise<void> {
  const s = useEditor.getState();
  if (!s.id) return;
  sessions.delete(s.id);
  syncRegistryForSession(undefined, s.id);
  await loadPresentation(s.id);
}

export function replaceBase(p: Presentation): void {
  openPresentation(p);
  upsertLocal('presentations', p);
}

/** Restore a persisted presentation draft from the IndexedDB recovery journal (`ordo-drafts`). */
export function restorePresentationDraftFromJournal(
  id: string,
  base: Presentation,
  draft: Presentation,
  slideId?: string,
  ui?: EditorUiPersist,
): void {
  const remote = useLibrary.getState().data.presentations.find((p) => p.id === id);
  if (!remote || same(content(draft), content(remote))) {
    journalRemove(`pres:${id}`);
    return;
  }
  if (!isDraftDirty(base, draft)) {
    journalRemove(`pres:${id}`);
    return;
  }
  const h = new History<Presentation>(200, 800);
  h.push(base);
  const resolvedUi = fromUiPersist(ui);
  const validSlide = slideId && getSlide(draft, slideId) ? slideId : firstSlideId(draft);
  const sess: PresentationSession = {
    id,
    base,
    draft,
    history: h,
    slideId: validSlide,
    objectId: undefined,
    objectIds: [],
    dirty: true,
    saving: false,
    conflict: false,
    mergeConflicts: [],
    ui: resolvedUi,
  };
  sessions.set(id, sess);
  uiMemory.set(id, { slideId: validSlide, ui: resolvedUi });
  syncRegistryForSession(sess, id);
  // If the editor is already mounted on this presentation id, swap the restored draft in at once.
  if (useEditor.getState().id === id && !useEditor.getState().dirty) {
    activateSession(sess);
  }
}

export function getParkedSessionIds(): string[] {
  return [...sessions.keys()];
}

export function resetEditorSessionsForTests(): void {
  for (const id of sessions.keys()) {
    removeUnsaved(`pres:${id}`);
    journalRemove(`pres:${id}`);
  }
  const curId = useEditor.getState().id;
  if (curId) {
    removeUnsaved(`pres:${curId}`);
    journalRemove(`pres:${curId}`);
  }
  sessions.clear();
  uiMemory.clear();
  wantedPresentationId = undefined;
  history = new History<Presentation>(200, 800);
  useEditor.setState({
    id: undefined,
    base: undefined,
    draft: undefined,
    slideId: undefined,
    objectId: undefined,
    objectIds: [],
    dirty: false,
    saving: false,
    conflict: false,
    mergeConflicts: [],
    guides: EMPTY_GUIDES,
    canUndo: false,
    canRedo: false,
    cell: undefined,
    cellRange: undefined,
    inlineEditingId: undefined,
    inlineEditingCell: undefined,
    textRange: EMPTY_TEXT_RANGE,
    loadError: undefined,
    ui: { ...DEFAULT_EDITOR_UI },
  });
}

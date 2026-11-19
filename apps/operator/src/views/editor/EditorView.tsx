import { SVG_HEAD_BYTES, type SlideObject } from '@ordo/domain';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FindReplaceDialog } from './FindReplaceDialog.tsx';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { ErrorBoundary, PaneError } from '../../components/ErrorBoundary.tsx';
import { DeckSwatchesSource, type SwatchSource } from '../../components/deckSwatches.ts';
import { installKeepVisible } from '../../components/keepVisible.ts';
import { Menu } from '../../components/Menu.tsx';
import { useCoarsePointer, useMedia } from '../../components/pointer.ts';
import { useLockedIds, useMediaLookup } from '../../hooks.ts';
import { useProfile } from '../../lib/capabilities.ts';
import { useLibrary } from '../../state/library.ts';
import { useSession } from '../../state/session.ts';
import { toast } from '../../state/toasts.ts';
import {
  addToSlide,
  armPlainPaste,
  type ClipboardReadable,
  consumePlainPaste,
  copySelection,
  copySlideSelection,
  copyTableCellSelection,
  copyTextSelection,
  inlineText,
  markExternalClipboard,
  tableKey,
  cutSelection,
  cutSlideSelection,
  cutTableCellSelection,
  cutTextSelection,
  deleteSelection,
  duplicateSelection,
  handleTextPaste,
  mayAdd,
  moveSelection,
  pasteIntoSelectedTableCell,
  pasteTableFromClipboard,
  readSystemClipboard,
  replaceBackgroundWith,
  replacePictureWith,
  reorderSelection,
  tryPasteObjectsFromClipboard,
  tryPasteSlidesFromClipboard,
  ungroupSelection,
  writeLastObjectClip,
  writeLastSlideClip,
  writeLastTableCellClip,
} from './actions.ts';
import { previewLooks } from '../../lib/lookPreviews.ts';
import { treatAsSlides } from '../../lib/pptxImport.ts';
import { uploadFiles } from '../library/MediaTab.tsx';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import { ConflictDialog } from './ConflictDialog.tsx';
import { buildCanvasContextMenu } from './editorContextMenu.ts';
import { canEditorClipboard, historyKey, keyPlace, slideNavKey, stepSlide } from './editorKeys.ts';
import { FloatingContextBar } from './FloatingContextBar.tsx';
import { LookPreviews, SingleLookStagePreview } from './LookPreviews.tsx';
import { addVideo, newVideo, replaceVideo } from './mediaOps.ts';
import {
  adoptJobSaves,
  change,
  currentObject,
  loadPresentation,
  redo,
  reloadLatest,
  save,
  selectObject,
  selectSlide,
  setTextRange,
  startInlineEditing,
  stopInlineEditing,
  undo,
  useEditor,
} from './editorStore.ts';
// `window.__ordo.editor`, read by the end-to-end specs (e2e/editorhelpers.ts).
import './inspect.ts';
import { ObjectPanel } from './ObjectPanel.tsx';
import { getSlide, newImage, newShape, newText, themeOf, updateObject, type ZOrder } from './ops.ts';
import { hasGroup, htmlToRichText, newTable, parseTableClipboard, pasteRichText } from './ops/index.ts';
import { SpeakerNotesDock } from './SpeakerNotesDock.tsx';

const DeckNotesEditor = lazy(() => import('./DeckNotesEditor.tsx'));
import { PresentationPanel } from './PresentationPanel.tsx';
import { LoopDeckBanner } from './PptxReport.tsx';
import { insertBox, svgDeclared } from './insertBox.ts';
import { RevisionsDialog } from './RevisionsDialog.tsx';
import { SlideCanvas } from './SlideCanvas.tsx';
import { makeSlideEditable, SlidePanel } from './SlidePanel.tsx';
import { SlidesPanel } from './SlidesPanel.tsx';
import { SongReflowEditor } from './SongReflowEditor.tsx';
import { TableInsertPicker } from './TableInsertPicker.tsx';

/** Nudge steps (px in slide units) offered by the touch toolbar; the keyboard uses 1 and Shift 10. */
const STEPS = [1, 10, 50] as const;

/** Move the selection (a group as one) by (dx, dy); consecutive nudges coalesce into one undo step. */
function nudge(dx: number, dy: number): void {
  if (currentObject()) moveSelection(dx, dy);
}

/** Focus the selected text box's text field (Enter, double-tap, or the Edit text button). */
function focusTextEditor(): void {
  const el = document.getElementById('ordo-text-editor') as HTMLTextAreaElement | null;
  // Synchronous when the field is already there: iPadOS only raises the keyboard for a focus() made
  // inside the user's gesture.
  if (el) el.focus();
  else
    setTimeout(() => (document.getElementById('ordo-text-editor') as HTMLTextAreaElement | null)?.focus(), 0);
}

const LOOKS_OPEN_KEY = 'ordo.editor.looksOpen';
function storedLooksOpen(): boolean | null {
  try {
    const v = localStorage.getItem(LOOKS_OPEN_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

/** The full slide editor (prd/03, design/15). */
export function EditorView({ id }: { id: string }) {
  const ed = useEditor();
  const libP = useLibrary((s) => s.data.presentations.find((p) => p.id === id));
  const themes = useLibrary((s) => s.data.themes);
  const allLooks = useLibrary((s) => s.data.settings.looks);
  const locked = useLockedIds();
  const media = useMediaLookup();
  const [tab, setTab] = useState<'object' | 'slide' | 'presentation'>('slide');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [stageLens, setStageLens] = useState<'canvas' | string>('canvas');
  // 'Keep as a loop' on the loop deck's stage line (`LoopDeckBanner`): hidden for this visit.
  const [keepLoop, setKeepLoop] = useState(false);
  const [bgPick, setBgPick] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [songMode, setSongMode] = useState<'reflow' | 'canvas' | null>(null);
  const [deckMode, setDeckMode] = useState<'canvas' | 'notes'>('canvas');
  const [notesDockOpen, setNotesDockOpen] = useState<boolean | null>(null);
  const [zoom, setZoom] = useState<'fit' | 0.5 | 0.75 | 1>('fit');
  // The paint pickers' deck swatches: components/deckSwatches.ts reads the deck from this context, so the
  // shared components never import the editor's store.
  const swatchSource = useMemo<SwatchSource>(
    () => ({
      presentation: ed.draft,
      theme: ed.draft?.themeId ? themes.find((t) => t.id === ed.draft?.themeId) : undefined,
    }),
    [ed.draft, themes],
  );

  const toggleFullScreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setFocusMode(false);
      } else {
        const rootEl = root.current;
        if (rootEl?.requestFullscreen) {
          await rootEl.requestFullscreen();
          setFocusMode(true);
        } else {
          setFocusMode((v) => !v);
        }
      }
    } catch {
      setFocusMode((v) => !v);
    }
  };

  useEffect(() => {
    const onFsChange = () => {
      setFocusMode(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const [revisions, setRevisions] = useState(false);
  const [imagePick, setImagePick] = useState(false);
  const [videoPick, setVideoPick] = useState(false);
  // 'Find…' (Ctrl+F outside a text field): find and replace across the presentation (M4 item E).
  const [finding, setFinding] = useState(false);
  // The window key handler reads it without re-binding (its effect depends on readOnly only).
  const findingRef = useRef(false);
  findingRef.current = finding;
  // The Presenter Notes Studio or the Lyric Script is shown instead of the slide canvas (set where the render
  // decides it, below): the window's handlers then leave the canvas's selection alone.
  const studioRef = useRef(false);
  const [dismissedRev, setDismissedRev] = useState(0);
  // The newest revision found saved by someone else (not only by the hub's PowerPoint jobs): the banner's.
  const [otherRev, setOtherRev] = useState(0);
  const libRev = libP?.rev ?? 0;
  const baseRev = ed.base?.rev ?? 0;
  // A revision saved only by a PowerPoint job (version 2 of an import, reference pictures, the text repair)
  // is taken over, unsaved edits kept, instead of being announced as someone else's.
  useEffect(() => {
    if (!libRev || !baseRev || libRev <= baseRev || ed.saving) return;
    let gone = false;
    void adoptJobSaves().then(
      (r) => {
        if (!gone && r === 'other') setOtherRev(libRev);
      },
      () => {
        if (!gone) setOtherRev(libRev);
      },
    );
    return () => {
      gone = true;
    };
  }, [libRev, baseRev, ed.saving]);
  const [step, setStep] = useState<(typeof STEPS)[number]>(10);
  // Look previews: open by default on a touch device in landscape, collapsed in narrow portrait and on
  // the desktop (where the slide canvas keeps its full height until someone opens them).
  const touchLandscape = useMedia('(pointer: coarse) and (orientation: landscape)');
  // A finger gets one compact toolbar row with menus and the object tools floating by the selection; a
  // mouse keeps the full toolbar (design/15 "Touch").
  const coarse = useCoarsePointer();
  const role = useSession((s) => {
    const r = s.me?.role ?? s.offlineRole;
    return r === 'operate' || r === 'edit' ? r : null;
  });
  const profile = useProfile(role);
  const [looksOpen, setLooksOpen] = useState<boolean | null>(storedLooksOpen);
  const root = useRef<HTMLDivElement>(null);
  // The root renders only once *this* presentation's draft is in the store (the store keeps the previous
  // one's draft while the next loads, so `ed.draft` alone would be true before the root exists).
  const hasRoot = ed.id === id && !!ed.draft;
  // biome-ignore lint/correctness/useExhaustiveDependencies: install once the editor root has rendered
  useEffect(() => {
    const el = root.current;
    return el ? installKeepVisible(el) : undefined;
  }, [hasRoot]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency list
  useEffect(() => {
    setDeckMode('canvas');
    setNotesDockOpen(null);
    void loadPresentation(id, libP);
  }, [id]);
  useEffect(() => {
    if (ed.objectId) setTab('object');
  }, [ed.objectId]);

  const p = ed.id === id ? ed.draft : undefined;
  const tallViewport = useMedia('(min-height: 800px)');
  const deckHasNotes = useMemo(
    () => (p ? p.sections.some((sec) => sec.slides.some((sl) => Boolean(sl.notes?.trim()))) : false),
    [p],
  );
  const readOnly = locked.has(id);
  // The lock as it is now, for what finishes later (a pasted picture's upload).
  const readOnlyNow = useRef(readOnly);
  readOnlyNow.current = readOnly;
  const slide = p ? getSlide(p, ed.slideId) : undefined;
  const obj = slide?.objects.find((o) => o.id === ed.objectId);
  // An imported deck PowerPoint plays as a loop (`importReport` `loop`): its line on the stage.
  const loopDeck = p?.kind === 'loop' && p.source?.kind === 'pptx';

  const pasteClipboardPayload = useCallback(
    (
      data: ClipboardReadable | null,
      rawFile: File | null,
      plainOnly: boolean,
      syncInline?: (caret: number) => void,
    ): boolean => {
      const st = useEditor.getState();
      if (!st.draft || !st.slideId) return false;

      // 1. Inline text box or table cell editing.
      const inline = st.inlineEditingId ? inlineText() : undefined;
      if (inline) {
        const { view, target } = inline;
        if (!plainOnly && target.cell !== undefined) {
          const html = data?.getData('text/html') ?? '';
          const plain = data?.getData('text/plain') ?? '';
          if (pasteTableFromClipboard(target.objectId, target.cell, html, plain)) {
            stopInlineEditing();
            return true;
          }
        }
        const caret = handleTextPaste(
          view,
          st.textRange.start,
          st.textRange.end,
          data as DataTransfer | null,
          target,
          plainOnly,
        );
        if (caret !== null) {
          setTextRange({ start: caret, end: caret, caret });
          syncInline?.(caret);
          return true;
        }
        return false;
      }

      // 1b. Selected table on the canvas: paste spreadsheet matrix or single-cell text directly into selected cell(s).
      const selObj = currentObject();
      if (selObj?.type === 'shape' && selObj.table && !selObj.locked) {
        if (pasteIntoSelectedTableCell(selObj.id, st.cell, st.cellRange, data, plainOnly)) {
          return true;
        }
      }

      // 2. Copied Ordo slides (`data-ordo-slides` or in-memory slide clipboard).
      const pastingSlides = tryPasteSlidesFromClipboard(data);
      if (pastingSlides) return true;

      // 3. Image file/blob in the clipboard (e.g. screenshot or copied image).
      if (rawFile) {
        const ext = rawFile.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        const named =
          !rawFile.name || rawFile.name === 'image.png'
            ? new File([rawFile], `pasted-${Date.now()}.${ext}`, { type: rawFile.type })
            : rawFile;
        const targetSlideId = st.slideId;
        void uploadFiles([named]).then(async (uploaded) => {
          const m = uploaded[0];
          if (!m) return;
          const declared = await svgDeclared(m, () => named.slice(0, SVG_HEAD_BYTES).text());
          const imgObj = newImage(m.id, insertBox(m, declared));
          if (readOnlyNow.current) return;
          addToSlide(targetSlideId, imgObj);
        });
        return true;
      }

      // 4. Copied Ordo slide objects (`data-ordo-objects` or in-memory object clipboard).
      const pastingObjs = tryPasteObjectsFromClipboard(data);
      if (pastingObjs) return true;

      // 5. Tabular spreadsheet data pasted onto the slide -> create a new Table.
      const html = data?.getData('text/html') ?? '';
      const plain = data?.getData('text/plain') ?? '';
      const curTheme = themeOf(st.draft, useLibrary.getState().data.themes);
      if (!plainOnly) {
        const pastedMatrix = parseTableClipboard(html, plain);
        if (pastedMatrix) {
          addToSlide(st.slideId, newTable(curTheme, { cells: pastedMatrix }));
          toast(
            `Inserted ${pastedMatrix.length}×${Math.max(...pastedMatrix.map((r) => r.length))} table from clipboard`,
            'ok',
          );
          return true;
        }
      }

      // 6. Rich or plain text pasted directly onto the slide canvas -> create a new TextObject.
      const richSlice = plainOnly
        ? plain
          ? { text: plain }
          : null
        : (html && htmlToRichText(html, curTheme.textBoxDefaults)) || (plain ? { text: plain } : null);
      if (richSlice?.text.trim()) {
        const baseObj = newText(curTheme, '');
        const { object } = pasteRichText(baseObj, 0, 0, richSlice);
        addToSlide(st.slideId, object);
        return true;
      }
      return false;
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A control that handled the key itself (a radio group's arrows, a menu's Escape) keeps it.
      if (e.defaultPrevented) return;
      const ctrl = e.ctrlKey || e.metaKey;
      // Where the focus is decides which shortcuts apply (editorKeys.ts): a dialog keeps every key, a field
      // its own keys, a button Enter, Space, the arrows and Delete; the slide canvas gets them all.
      const place = keyPlace(e.target);
      if (ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!readOnly && place !== 'dialog') void save();
        return;
      }
      if (e.altKey && !ctrl && e.code === 'KeyN' && place !== 'dialog') {
        e.preventDefault();
        setNotesDockOpen((prev) => !(prev ?? false));
        return;
      }
      if (place === 'field' || place === 'dialog') return;
      // Escape closes an open Find & replace card first (one Escape, one thing), even when the focus left it.
      if (e.key === 'Escape' && !ctrl && findingRef.current) {
        e.preventDefault();
        setFinding(false);
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFinding(true);
        return;
      }
      const step = historyKey(e);
      if (step) {
        e.preventDefault();
        if (!readOnly) (step === 'undo' ? undo : redo)();
        return;
      }
      const st = useEditor.getState();
      // In the Presenter Notes Studio or the Lyric Script the canvas is not shown, and the focus is often on the
      // page, which reads as the canvas (`keyPlace`): the button that opened the studio is gone, and a click
      // outside the Lyric Script's text leaves the focus there. What the canvas had selected (an object, a
      // table's cell, or a text box or cell being typed in) is hidden there: no key acts on it (no nudge,
      // Delete, Enter, Tab, Escape, table key, duplicate, copy or cut), and Up and Down move between slides,
      // which the studio shows.
      const studio = studioRef.current;
      const o = studio ? undefined : currentObject();

      // When nothing has focus (no object is selected on the canvas, and focus is not in a field or dialog),
      // Up/Down arrows and PageUp/PageDown navigate to the previous / next slide.
      if (!o && (studio || !st.inlineEditingId) && st.draft) {
        const delta = slideNavKey(e);
        if (delta !== 0) {
          const allSlides = st.draft.sections.flatMap((sec) => sec.slides);
          const nextId = stepSlide(
            allSlides.map((s) => s.id),
            st.slideId,
            delta,
          );
          e.preventDefault();
          if (nextId && nextId !== st.slideId) {
            selectSlide(nextId);
          }
          return;
        }
      }

      // Copy/Cut/Plain-paste shortcuts apply on both canvas and UI controls (like Ctrl+D/Z/Y/F),
      // unless the user highlighted text in UI chrome. Ctrl+C also works in read-only presentations.
      if (!studio && !st.inlineEditingId && ctrl && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'v' && e.shiftKey && canEditorClipboard(place, 'paste')) {
          armPlainPaste();
          return;
        }
        if (k === 'c' && !e.shiftKey && canEditorClipboard(place, 'copy')) {
          if (o?.type === 'shape' && o.table && (st.cell !== undefined || st.cellRange)) {
            copyTableCellSelection();
          } else if (o) {
            copySelection();
          } else if (st.slideId) {
            copySlideSelection();
          }
          return;
        }
        if (k === 'x' && !e.shiftKey && !readOnly && canEditorClipboard(place, 'cut')) {
          if (o?.type === 'shape' && o.table && (st.cell !== undefined || st.cellRange)) {
            cutTableCellSelection();
          } else if (o) {
            cutSelection();
          } else if (st.slideId) {
            cutSlideSelection();
          }
          return;
        }
      }

      if (!o || !st.slideId || readOnly) return;
      // The selection acts as one block: a group, or what Shift-click gathered (design/27 §11 item 5).
      if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (place !== 'canvas' || ctrl || e.altKey) return;
      // A selected table's cells: Enter, Tab, Escape and Delete (design/15 "Table editing").
      if (tableKey(e, o, readOnly)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
        return;
      }
      const by = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] }[e.key];
      if (d) {
        e.preventDefault();
        nudge(d[0]!, d[1]!);
        return;
      }
      if (e.key === 'Enter' && o.type === 'text') {
        e.preventDefault();
        startInlineEditing(o.id);
      }
      if (e.key === 'Escape') {
        stopInlineEditing();
        selectObject(undefined);
      }
    };

    const syncInlineTextarea = (caret: number) => {
      requestAnimationFrame(() => {
        const f = document.getElementById('ordo-text-editor');
        if (f instanceof HTMLTextAreaElement) f.setSelectionRange(caret, caret);
      });
    };

    const onCopy = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const place = keyPlace(e.target);
      if (!canEditorClipboard(place, 'copy')) return;
      // The studio's own fields copy as fields do; the hidden canvas's selection is not copied (onKey).
      if (studioRef.current) return;
      const st = useEditor.getState();
      // A text box or a table's cell edited on the canvas (`inlineText`).
      const inline = st.inlineEditingId && st.draft && st.slideId ? inlineText() : undefined;
      if (inline) {
        if (copyTextSelection(inline.view, st.textRange.start, st.textRange.end, e.clipboardData)) {
          e.preventDefault();
        }
        return;
      }
      const selObj = currentObject();
      if (selObj?.type === 'shape' && selObj.table && (st.cell !== undefined || st.cellRange)) {
        if (copyTableCellSelection(e.clipboardData) || writeLastTableCellClip(e.clipboardData)) {
          e.preventDefault();
        }
        return;
      }
      if (selObj) {
        if (copySelection(e.clipboardData) || writeLastObjectClip(e.clipboardData)) {
          e.preventDefault();
        }
        return;
      }
      if (copySlideSelection(e.clipboardData) || writeLastSlideClip(e.clipboardData)) {
        e.preventDefault();
      }
    };

    const onCut = (e: ClipboardEvent) => {
      if (e.defaultPrevented || readOnly) return;
      const place = keyPlace(e.target);
      if (!canEditorClipboard(place, 'cut')) return;
      if (studioRef.current) return;
      const st = useEditor.getState();
      const inline = st.inlineEditingId && st.draft && st.slideId ? inlineText() : undefined;
      if (inline) {
        const { view, target } = inline;
        const caret = cutTextSelection(view, st.textRange.start, st.textRange.end, e.clipboardData, target);
        if (caret !== null) {
          e.preventDefault();
          setTextRange({ start: caret, end: caret, caret });
          syncInlineTextarea(caret);
        }
        return;
      }
      const selObj = currentObject();
      if (selObj?.type === 'shape' && selObj.table && (st.cell !== undefined || st.cellRange)) {
        if (cutTableCellSelection(e.clipboardData) || writeLastTableCellClip(e.clipboardData)) {
          e.preventDefault();
        }
        return;
      }
      if (selObj) {
        if (cutSelection(e.clipboardData) || writeLastObjectClip(e.clipboardData)) {
          e.preventDefault();
        }
        return;
      }
      // If `onKey` already cut the selection or slide, write the pending clip into `clipboardData`.
      if (
        writeLastObjectClip(e.clipboardData) ||
        writeLastTableCellClip(e.clipboardData) ||
        writeLastSlideClip(e.clipboardData) ||
        cutSlideSelection(e.clipboardData)
      ) {
        e.preventDefault();
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || readOnly) return;
      const place = keyPlace(e.target);
      if (!canEditorClipboard(place, 'paste')) return;
      // Nothing is pasted onto the hidden canvas (a picture, objects or a new text box) or into its box or cell.
      if (studioRef.current) return;
      const plainOnly = consumePlainPaste();
      const items = [...(e.clipboardData?.items ?? [])];
      const imgItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
      const rawFile =
        imgItem?.getAsFile() ??
        [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/')) ??
        null;
      if (pasteClipboardPayload(e.clipboardData ?? null, rawFile, plainOnly, syncInlineTextarea)) {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    window.addEventListener('blur', markExternalClipboard);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('blur', markExternalClipboard);
    };
  }, [readOnly, pasteClipboardPayload]);

  const [replacePicId, setReplacePicId] = useState<string | null>(null);
  const [replaceVidId, setReplaceVidId] = useState<string | null>(null);

  const pasteFromUi = async (plainOnly = false) => {
    if (readOnly) return;
    const sys = await readSystemClipboard();
    const readable: ClipboardReadable | null = sys
      ? {
          getData: (type: string) =>
            type === 'text/html' ? sys.html : type === 'text/plain' ? sys.plain : '',
        }
      : null;
    if (!pasteClipboardPayload(readable, sys?.imageFile ?? null, plainOnly) && !sys) {
      toast('Use Ctrl+V (⌘V on Mac) to paste from another app.', 'warn');
    }
  };

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  if (ed.loadError && ed.id !== id)
    return (
      <div className="center">
        <div className="banner red">Could not open the presentation: {ed.loadError}</div>
      </div>
    );
  if (!p) return <div className="center muted">Loading…</div>;
  const theme = themeOf(p, themes);
  const changedElsewhere =
    !!libP &&
    !!ed.base &&
    libP.rev > ed.base.rev &&
    !ed.saving &&
    otherRev >= libP.rev &&
    libP.rev !== dismissedRev;
  const z = (zz: ZOrder) => obj && reorderSelection(zz);
  // 'Ungroup' applies while a selected object belongs to a group (a PowerPoint group, a shape with its text).
  const grouped = !!slide && hasGroup(slide.objects.filter((o) => ed.objectIds.includes(o.id)));
  const add = (o: SlideObject) => {
    if (!slide || readOnly) return;
    addToSlide(slide.id, o);
  };
  const bgId = slide?.backgroundMediaId ?? p.backgroundMediaId;
  const editText = (objectId?: string) => {
    if (readOnly) return;
    const targetId = objectId ?? ed.objectId;
    if (targetId && targetId !== ed.objectId) selectObject(targetId);
    setTab('object');
    setDrawerOpen(true);
    focusTextEditor();
  };
  const openDrawerTab = (target: 'object' | 'slide' | 'presentation') => {
    if (drawerOpen && tab === target) {
      setDrawerOpen(false);
    } else {
      setTab(target);
      setDrawerOpen(true);
    }
  };
  const shownLooks = previewLooks(allLooks);
  const activeLensLook = stageLens === 'canvas' ? undefined : shownLooks.find((l) => l.id === stageLens);
  const duplicate = () => {
    if (obj && slide) duplicateSelection();
  };
  const remove = () => {
    if (obj && slide) deleteSelection();
  };
  const looksShown = looksOpen ?? touchLandscape;
  // A song in the Lyric Script or a deck in Presenter Notes Studio has no stage pane: Find floats there.
  const reflow = p.kind === 'song' && (songMode ?? (coarse ? 'canvas' : 'reflow')) === 'reflow';
  const deckNotesStudio = p.kind !== 'song' && deckMode === 'notes';
  const scriptStudio = reflow || deckNotesStudio;
  studioRef.current = scriptStudio;
  const findDocked = !scriptStudio;
  // Touch: the keyboard-only actions as buttons, floating by the selected object (SlideCanvas places them).
  const objectTools =
    coarse && obj && !readOnly ? (
      <>
        <span className="ed-nudge">
          <button type="button" aria-label="Left" onClick={() => nudge(-step, 0)}>
            ←
          </button>
          <button type="button" aria-label="Up" onClick={() => nudge(0, -step)}>
            ↑
          </button>
          <button type="button" aria-label="Down" onClick={() => nudge(0, step)}>
            ↓
          </button>
          <button type="button" aria-label="Right" onClick={() => nudge(step, 0)}>
            →
          </button>
          <select
            aria-label="Nudge step"
            value={step}
            onChange={(e) => setStep(Number(e.target.value) as (typeof STEPS)[number])}
          >
            {STEPS.map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </select>
        </span>
        {obj.type === 'text' && (
          <button type="button" onClick={() => editText()}>
            Edit text
          </button>
        )}
        <button type="button" onClick={() => selectObject(undefined)}>
          Deselect
        </button>
      </>
    ) : undefined;

  const showProps = coarse || drawerOpen;
  const effectiveNotesDockOpen =
    notesDockOpen !== null ? notesDockOpen : deckHasNotes && !showProps && !coarse && tallViewport;
  const stageLookId = shownLooks.find((l) => l.kind === 'stage')?.id;

  const page = (
    <div
      className={`editor ${focusMode ? 'focus-mode' : ''} ${!coarse ? (drawerOpen ? 'drawer-open' : 'canvas-first') : ''}`}
      ref={root}
    >
      {coarse ? (
        <div className="toolbar ed-toolbar-touch">
          <a className="btn small ghost" href="#/library">
            ← Library
          </a>
          <b className="ellipsis ed-title">{p.title}</b>
          {p.kind === 'song' && (
            <div
              className="row"
              style={{
                background: 'var(--bg)',
                borderRadius: 6,
                padding: 2,
                border: '1px solid var(--line)',
                margin: '0 4px',
              }}
            >
              <button
                type="button"
                className={`small ${(songMode ?? 'canvas') === 'reflow' ? 'on' : 'ghost'}`}
                style={{ fontWeight: 600 }}
                onClick={() => setSongMode('reflow')}
              >
                Script
              </button>
              <button
                type="button"
                className={`small ${(songMode ?? 'canvas') === 'canvas' ? 'on' : 'ghost'}`}
                style={{ fontWeight: 600 }}
                onClick={() => setSongMode('canvas')}
              >
                Canvas
              </button>
            </div>
          )}
          <button
            type="button"
            className={ed.dirty || ed.saving ? 'primary' : 'ed-saved-pill'}
            aria-label={ed.saving ? 'Saving…' : ed.dirty ? 'Save' : 'Saved'}
            disabled={readOnly || !ed.dirty || ed.saving}
            onClick={() => void save()}
            title="Ctrl+S"
          >
            {ed.saving ? 'Saving…' : ed.dirty ? 'Save' : 'Saved'}
          </button>
          <button type="button" disabled={readOnly || !ed.canUndo} onClick={undo} title="Undo (Ctrl+Z)">
            ↶<span className="touch-label">Undo</span>
          </button>
          <button type="button" disabled={readOnly || !ed.canRedo} onClick={redo} title="Redo (Ctrl+Y)">
            ↷<span className="touch-label">Redo</span>
          </button>
          <Menu
            label="Add"
            disabled={readOnly || !slide}
            items={[
              { label: 'Text', onSelect: () => add(newText(theme)) },
              { label: 'Image…', name: 'Image', onSelect: () => setImagePick(true) },
              { label: 'Video…', name: 'Video', onSelect: () => setVideoPick(true) },
              { label: 'Rectangle', name: 'Rect', onSelect: () => add(newShape('rect')) },
              { label: 'Ellipse', onSelect: () => add(newShape('ellipse')) },
              { label: 'Line', onSelect: () => add(newShape('line')) },
            ]}
          />
          <Menu
            label="Arrange"
            disabled={readOnly || !slide}
            items={[
              ...(obj
                ? [
                    { label: '✂ Cut', name: 'Cut', onSelect: () => void cutSelection() },
                    { label: '⎘ Copy', name: 'Copy', onSelect: () => void copySelection() },
                  ]
                : []),
              { label: '📋 Paste', name: 'Paste', onSelect: () => void pasteFromUi(false) },
              ...(obj
                ? [
                    { label: '⤒ Bring to front', name: 'Front', onSelect: () => z('front') },
                    { label: '↑ Bring forward', name: 'Forward', onSelect: () => z('forward') },
                    { label: '↓ Send backward', name: 'Backward', onSelect: () => z('backward') },
                    { label: '⤓ Send to back', name: 'Back', onSelect: () => z('back') },
                    { label: '⧉ Duplicate', name: 'Duplicate', onSelect: duplicate },
                    { label: '🗑 Delete', name: 'Delete', danger: true, onSelect: remove },
                    ...(grouped ? [{ label: 'Ungroup', onSelect: ungroupSelection }] : []),
                  ]
                : []),
            ]}
          />
          <span className="spacer" />
          <button type="button" onClick={() => setFinding((v) => !v)} title="Find and replace (Ctrl+F)">
            Find…
          </button>
          <button type="button" onClick={() => setRevisions(true)}>
            History
          </button>
        </div>
      ) : (
        <div className={`toolbar ed-toolbar-calm${p.kind === 'song' || deckNotesStudio ? ' has-modes' : ''}`}>
          {/* Left Zone: Back, Inline-Editable Title, Unified Save + Revision History Pill, Undo/Redo */}
          <a className="btn small ghost" href="#/library">
            ← Library
          </a>
          <input
            aria-label="Presentation title"
            className="ed-inline-title"
            value={p.title}
            disabled={readOnly}
            onChange={(e) => change((q) => ({ ...q, title: e.target.value }), 'pres:title')}
          />
          <div className="ed-save-rev-group">
            <button
              type="button"
              className={ed.dirty || ed.saving ? 'primary small' : 'ed-saved-pill small'}
              aria-label={ed.saving ? 'Saving…' : ed.dirty ? 'Save' : 'Saved'}
              disabled={readOnly || !ed.dirty || ed.saving}
              onClick={() => void save()}
              title="Save presentation (Ctrl+S)"
            >
              {ed.saving ? 'Saving…' : ed.dirty ? 'Save' : 'Saved'}
            </button>
            <button
              type="button"
              className="small ghost ed-rev-btn"
              aria-label="History"
              title="Open visual revision history"
              onClick={() => setRevisions(true)}
            >
              rev {ed.base?.rev ?? p.rev} ▾
            </button>
          </div>

          {p.kind === 'song' && (
            <div className="ed-mode-switch">
              <button
                type="button"
                className={`small ${(songMode ?? 'reflow') === 'reflow' ? 'on' : 'ghost'}`}
                style={{ fontWeight: 600 }}
                onClick={() => setSongMode('reflow')}
              >
                Lyric Script
              </button>
              <button
                type="button"
                className={`small ${(songMode ?? 'reflow') === 'canvas' ? 'on' : 'ghost'}`}
                style={{ fontWeight: 600 }}
                onClick={() => setSongMode('canvas')}
              >
                Slide Canvas
              </button>
            </div>
          )}

          {deckNotesStudio && (
            <div className="ed-mode-switch">
              <button
                type="button"
                className="small on"
                style={{ fontWeight: 600 }}
                onClick={() => setDeckMode('notes')}
              >
                Presenter Notes
              </button>
              <button
                type="button"
                className="small ghost"
                style={{ fontWeight: 600 }}
                onClick={() => setDeckMode('canvas')}
              >
                Slide Canvas
              </button>
            </div>
          )}

          <button
            type="button"
            className="small ghost"
            disabled={readOnly || !ed.canUndo}
            onClick={undo}
            title="Undo (Ctrl+Z)"
          >
            ↶<span className="touch-label">Undo</span>
          </button>
          <button
            type="button"
            className="small ghost"
            disabled={readOnly || !ed.canRedo}
            onClick={redo}
            title="Redo (Ctrl+Y)"
          >
            ↷<span className="touch-label">Redo</span>
          </button>

          <span className="spacer" />

          {/* Center Zone: Clean Creation Island */}
          {!scriptStudio && (
            <div className="ed-insert-island" role="group" aria-label="Insert onto slide">
              <button
                type="button"
                className="small ghost"
                disabled={readOnly || !slide}
                onClick={() => {
                  setStageLens('canvas');
                  add(newText(theme));
                }}
                title="Add text box"
              >
                + Text
              </button>
              <button
                type="button"
                className="small ghost"
                disabled={readOnly || !slide}
                onClick={() => {
                  setStageLens('canvas');
                  setImagePick(true);
                }}
              >
                + Image
              </button>
              <button
                type="button"
                className="small ghost"
                disabled={readOnly || !slide}
                onClick={() => {
                  setStageLens('canvas');
                  setVideoPick(true);
                }}
                title="Add a video that plays in the slide"
              >
                + Video
              </button>
              <Menu
                label="Shapes"
                disabled={readOnly || !slide}
                items={[
                  {
                    label: 'Rectangle',
                    name: 'Rectangle',
                    onSelect: () => {
                      setStageLens('canvas');
                      add(newShape('rect'));
                    },
                  },
                  {
                    label: 'Ellipse',
                    name: 'Ellipse',
                    onSelect: () => {
                      setStageLens('canvas');
                      add(newShape('ellipse'));
                    },
                  },
                  {
                    label: 'Line',
                    name: 'Line',
                    onSelect: () => {
                      setStageLens('canvas');
                      add(newShape('line'));
                    },
                  },
                ]}
              />
              <TableInsertPicker
                theme={theme}
                disabled={readOnly || !slide}
                onInsert={(t) => {
                  setStageLens('canvas');
                  add(t);
                }}
              />
              <button
                type="button"
                className="small ghost"
                disabled={readOnly || !slide}
                onClick={() => setBgPick(true)}
                title="Choose slide background media"
              >
                Background
              </button>
            </div>
          )}

          <span className="spacer" />

          {/* Right Zone: Zoom, Find, the drawer triggers (folded into one Panels menu on a narrow window),
              Full screen. One unit: when the bar does not fit it wraps to a second row, kept at the right. */}
          <div className="ed-zone-right">
            {!scriptStudio && (
              <select
                aria-label="Canvas zoom"
                className="ed-zoom-select"
                value={String(zoom)}
                onChange={(e) => {
                  const v = e.target.value;
                  setZoom(v === 'fit' ? 'fit' : (Number(v) as 0.5 | 0.75 | 1));
                }}
                title="Canvas zoom"
              >
                <option value="fit">Fit</option>
                <option value="0.5">50%</option>
                <option value="0.75">75%</option>
                <option value="1">100%</option>
              </select>
            )}
            <button
              type="button"
              className={`small ghost ${finding ? 'on' : ''}`}
              onClick={() => setFinding((v) => !v)}
              title="Find and replace (Ctrl+F)"
            >
              Find…
            </button>
            {!scriptStudio &&
              (!drawerOpen ? (
                <>
                  <div
                    className="ed-drawer-triggers ed-panels-wide"
                    role="group"
                    aria-label="Inspector panels"
                  >
                    <button
                      type="button"
                      className="small ghost"
                      disabled={!slide}
                      onClick={() => openDrawerTab('slide')}
                      title="Slide cues, background, and notes"
                    >
                      Slide
                    </button>
                    <button
                      type="button"
                      className="small ghost"
                      onClick={() => openDrawerTab('presentation')}
                      title="Deck theme, arrangements, and PowerPoint settings"
                    >
                      Presentation
                    </button>
                    <button
                      type="button"
                      className="small ghost"
                      onClick={() => openDrawerTab(obj ? 'object' : 'slide')}
                      title="Open fine-tune inspector drawer"
                    >
                      Tune
                    </button>
                  </div>
                  {/* Below ~1,250 px (~1,450 px with a song's mode switch) the three triggers are one menu
                      (styles.css), so the bar keeps one calm row on a 1024 px booth PC (e2e/editor-fit.spec.ts). */}
                  <div className="ed-drawer-triggers ed-panels-menu">
                    <Menu
                      label="Panels"
                      align="right"
                      items={[
                        { label: 'Slide', disabled: !slide, onSelect: () => openDrawerTab('slide') },
                        { label: 'Presentation', onSelect: () => openDrawerTab('presentation') },
                        { label: 'Tune', onSelect: () => openDrawerTab(obj ? 'object' : 'slide') },
                      ]}
                    />
                  </div>
                </>
              ) : (
                <div className="ed-drawer-triggers" role="group" aria-label="Inspector panels">
                  <button
                    type="button"
                    className="small on"
                    aria-label="Tune"
                    aria-pressed={true}
                    onClick={() => setDrawerOpen(false)}
                    title="Close fine-tune inspector drawer"
                  >
                    Tune ✕
                  </button>
                </div>
              ))}
            <button
              type="button"
              className={`small ghost ${focusMode ? 'on' : ''}`}
              onClick={() => void toggleFullScreen()}
              title="Toggle full screen canvas (hide side panels)"
              aria-label={focusMode ? 'Exit Full Screen' : 'Full Screen'}
            >
              {focusMode ? 'Exit Full Screen' : '⛶'}
            </button>
          </div>
        </div>
      )}
      {reflow ? (
        <ErrorBoundary
          name="editor Lyric Script"
          resetKey={p}
          fallback={(retry) => <PaneError what="The Lyric Script" retry={retry} undo={undo} />}
        >
          <SongReflowEditor
            presentation={p}
            readOnly={readOnly}
            selectedSlideId={slide?.id}
            onSwitchToCanvas={() => setSongMode('canvas')}
            banners={
              <>
                {readOnly && (
                  <div className="banner" style={{ margin: '8px 16px 0' }} data-locked-banner>
                    {profile === 'edit'
                      ? 'This presentation is in the playlist that is live at the venue. It can be edited again after the service.'
                      : 'This presentation is in the live playlist. Editing is locked until End service.'}
                  </div>
                )}
                {changedElsewhere && (
                  <div className="banner blue row" style={{ margin: '8px 16px 0' }}>
                    <span className="grow">
                      Someone else saved this presentation (rev {libP.rev}) since you opened it. Saving
                      combines your changes with theirs.
                    </span>
                    <button type="button" className="small" onClick={() => void reloadLatest()}>
                      Reload theirs
                    </button>
                    <button type="button" className="small" onClick={() => setDismissedRev(libP.rev)}>
                      Keep editing
                    </button>
                  </div>
                )}
              </>
            }
          />
        </ErrorBoundary>
      ) : deckNotesStudio ? (
        <ErrorBoundary
          name="editor Presenter Notes Studio"
          resetKey={p}
          fallback={(retry) => <PaneError what="Presenter Notes Studio" retry={retry} undo={undo} />}
        >
          <Suspense fallback={<div className="center muted">Opening Presenter Notes Studio…</div>}>
            <DeckNotesEditor
              presentation={p}
              readOnly={readOnly}
              selectedSlideId={slide?.id}
              onSwitchToCanvas={() => setDeckMode('canvas')}
              banners={
                <>
                  {readOnly && (
                    <div className="banner" style={{ margin: '8px 16px 0' }} data-locked-banner>
                      {profile === 'edit'
                        ? 'This presentation is in the playlist that is live at the venue. It can be edited again after the service.'
                        : 'This presentation is in the live playlist. Editing is locked until End service.'}
                    </div>
                  )}
                  {changedElsewhere && (
                    <div className="banner blue row" style={{ margin: '8px 16px 0' }}>
                      <span className="grow">
                        Someone else saved this presentation (rev {libP.rev}) since you opened it. Saving
                        combines your changes with theirs.
                      </span>
                      <button type="button" className="small" onClick={() => void reloadLatest()}>
                        Reload theirs
                      </button>
                      <button type="button" className="small" onClick={() => setDismissedRev(libP.rev)}>
                        Keep editing
                      </button>
                    </div>
                  )}
                </>
              }
            />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <>
          <SlidesPanel
            p={p}
            readOnly={readOnly}
            onSwitchToReflow={p.kind === 'song' ? () => setSongMode('reflow') : undefined}
            onOpenDeckNotes={p.kind !== 'song' ? () => setDeckMode('notes') : undefined}
          />
          <div className="stagewrap">
            {/* Docked in the stage pane: it never covers the slide list or the open Tune drawer's tabs. */}
            {finding && findDocked && (
              <FindReplaceDialog readOnly={readOnly} onClose={() => setFinding(false)} />
            )}
            {readOnly && (
              <div className="banner" style={{ margin: 8 }} data-locked-banner>
                {profile === 'edit'
                  ? 'This presentation is in the playlist that is live at the venue. It can be edited again after the service.'
                  : 'This presentation is in the live playlist. Editing is locked until End service.'}
              </div>
            )}
            {loopDeck && !keepLoop && (
              <LoopDeckBanner
                readOnly={readOnly}
                onTreatAsSlides={() => change(treatAsSlides, 'kind')}
                onReport={() => {
                  setTab('presentation');
                  setDrawerOpen(true);
                }}
                onKeep={() => setKeepLoop(true)}
              />
            )}
            {changedElsewhere && (
              <div className="banner blue row" style={{ margin: 8 }}>
                <span className="grow">
                  Someone else saved this presentation (rev {libP.rev}) since you opened it. Saving combines
                  your changes with theirs.
                </span>
                <button type="button" className="small" onClick={() => void reloadLatest()}>
                  Reload theirs
                </button>
                <button type="button" className="small" onClick={() => setDismissedRev(libP.rev)}>
                  Keep editing
                </button>
              </div>
            )}
            {(slide?.pptx || slide?.imported) && !showProps && stageLens === 'canvas' && (
              <div className="ed-pptx-stage-pill" data-pptx-stage-pill>
                <span className="small muted">
                  {slide.imported ? `Imported page ${slide.imported.page}` : 'Imported PowerPoint slide'}
                </span>
                {slide.imported?.textBoxes?.length && !readOnly ? (
                  <button
                    type="button"
                    className="small primary"
                    onClick={() => void makeSlideEditable(slide, p, ed.dirty)}
                  >
                    Make editable
                  </button>
                ) : null}
                <button
                  type="button"
                  className="small"
                  onClick={() => {
                    setTab('slide');
                    setDrawerOpen(true);
                  }}
                >
                  PowerPoint options ▸
                </button>
              </div>
            )}
            {slide ? (
              <ErrorBoundary
                name="editor stage"
                resetKey={slide}
                fallback={(retry) => <PaneError what="This slide" retry={retry} undo={undo} />}
              >
                {activeLensLook ? (
                  <SingleLookStagePreview
                    look={activeLensLook}
                    presentation={p}
                    slideId={slide.id}
                    onBackToCanvas={() => setStageLens('canvas')}
                  />
                ) : (
                  <SlideCanvas
                    slide={slide}
                    backgroundMediaId={bgId}
                    media={media}
                    readOnly={readOnly}
                    zoom={zoom}
                    avoidTopRight={finding ? { w: 344, h: 430 } : undefined}
                    onEditText={editText}
                    objectTools={objectTools}
                    hasExternalTextEditor={showProps && tab === 'object'}
                    floatingBar={
                      !coarse && obj && !(drawerOpen && tab === 'object') ? (
                        // Its own boundary: an object the bar cannot read costs the bar, never the canvas.
                        <ErrorBoundary name="editor floating bar" resetKey={obj} fallback={() => null}>
                          <FloatingContextBar
                            readOnly={readOnly}
                            drawerOpen={drawerOpen && tab === 'object'}
                            onToggleDrawer={() => openDrawerTab('object')}
                          />
                        </ErrorBoundary>
                      ) : undefined
                    }
                    slideRect={p.source?.native?.slideRect}
                    onCanvasContextMenu={(e) => {
                      const st = useEditor.getState();
                      openContextMenu(
                        e,
                        buildCanvasContextMenu({
                          p,
                          slide,
                          theme,
                          readOnly,
                          objectIds: st.objectIds,
                          primaryId: st.objectId,
                          cell: st.cell,
                          cellRange: st.cellRange,
                          mediaLookup: media,
                          onPaste: (plainOnly) => void pasteFromUi(plainOnly),
                          onEditText: (objectId) => editText(objectId),
                          onOpenInspector: (t) => {
                            setTab(t);
                            setDrawerOpen(true);
                          },
                          onOpenBackgroundPicker: () => setBgPick(true),
                          onOpenImagePicker: () => setImagePick(true),
                          onOpenVideoPicker: () => setVideoPick(true),
                          onReplacePicture: (objectId) => setReplacePicId(objectId),
                          onReplaceVideo: (objectId) => setReplaceVidId(objectId),
                          onAddObject: add,
                          onToast: (msg, tone) => toast(msg, tone),
                        }),
                        { ariaLabel: 'Canvas actions' },
                      );
                    }}
                  />
                )}
              </ErrorBoundary>
            ) : (
              <div className="center muted">Add a slide to start.</div>
            )}

            {/* Proposal A Docked Speaker Notes Bar right under the slide canvas */}
            {slide && !coarse && (
              <SpeakerNotesDock
                slide={slide}
                presentation={p}
                readOnly={readOnly}
                open={effectiveNotesDockOpen}
                onToggleOpen={(open) => setNotesDockOpen(open)}
                onOpenStudio={p.kind !== 'song' ? () => setDeckMode('notes') : undefined}
                onPreviewStage={
                  stageLookId
                    ? () => setStageLens(stageLens === stageLookId ? 'canvas' : stageLookId)
                    : undefined
                }
              />
            )}

            {/* Proposal B Bottom Stage Bar: Floating Output View Lens + Optional 4-Up Strip */}
            {slide && (
              <div className="ed-lens-dock">
                <div className="ed-lens-pills" role="tablist" aria-label="Stage view lens">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={stageLens === 'canvas'}
                    className={`ed-lens-pill${stageLens === 'canvas' ? ' on' : ''}`}
                    onClick={() => setStageLens('canvas')}
                  >
                    Canvas
                  </button>
                  {shownLooks.map((look) => (
                    <button
                      key={look.id}
                      type="button"
                      role="tab"
                      aria-selected={stageLens === look.id}
                      className={`ed-lens-pill${stageLens === look.id ? ' on' : ''}`}
                      onClick={() => setStageLens(stageLens === look.id ? 'canvas' : look.id)}
                    >
                      {look.name}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className={`small ghost ed-all-looks-btn${looksShown ? ' on' : ''}`}
                  aria-expanded={looksShown}
                  onClick={() => {
                    const next = !looksShown;
                    setLooksOpen(next);
                    try {
                      localStorage.setItem(LOOKS_OPEN_KEY, next ? '1' : '0');
                    } catch {
                      /* private mode */
                    }
                  }}
                >
                  {looksShown ? 'Hide 4-screen tray ▾' : 'All 4 screens ▴'}
                </button>
              </div>
            )}

            {looksShown && (
              <div className="ed-looks" data-looks-tray>
                <ErrorBoundary
                  name="editor 4-screen tray"
                  resetKey={slide}
                  fallback={(retry) => <PaneError what="The 4-screen tray" retry={retry} />}
                >
                  <LookPreviews
                    presentation={p}
                    slideId={slide?.id}
                    compact
                    onSelectLook={(lookId) => setStageLens(stageLens === lookId ? 'canvas' : lookId)}
                  />
                </ErrorBoundary>
              </div>
            )}
          </div>
          {showProps && (
            <aside className={coarse ? 'props' : 'props ed-slideover-drawer'} aria-label="Inspector drawer">
              <div className="row ed-drawer-hdr">
                <div className="ed-seg-bar" style={{ flex: 1 }}>
                  <button
                    type="button"
                    className={`small ${tab === 'object' ? 'on' : ''}`}
                    disabled={!obj}
                    onClick={() => setTab('object')}
                  >
                    Object
                  </button>
                  <button
                    type="button"
                    className={`small ${tab === 'slide' ? 'on' : ''}`}
                    disabled={!slide}
                    onClick={() => setTab('slide')}
                  >
                    Slide
                  </button>
                  <button
                    type="button"
                    className={`small ${tab === 'presentation' ? 'on' : ''}`}
                    onClick={() => setTab('presentation')}
                  >
                    Presentation
                  </button>
                </div>
                {!coarse && (
                  <button
                    type="button"
                    className="small ghost"
                    aria-label="Close inspector"
                    title="Close inspector drawer"
                    onClick={() => setDrawerOpen(false)}
                  >
                    ✕
                  </button>
                )}
              </div>
              <ErrorBoundary
                key={`${tab}:${ed.objectId ?? ''}`}
                name={`editor ${tab} panel`}
                resetKey={slide}
                fallback={(retry) => <PaneError what="This panel" retry={retry} undo={undo} />}
              >
                {tab === 'object' && obj && <ObjectPanel o={obj} readOnly={readOnly} />}
                {tab === 'object' && !obj && <span className="muted">Select an object on the slide.</span>}
                {tab === 'slide' && slide && <SlidePanel slide={slide} p={p} readOnly={readOnly} />}
                {tab === 'presentation' && <PresentationPanel p={p} readOnly={readOnly} />}
              </ErrorBoundary>
            </aside>
          )}
        </>
      )}
      {revisions && <RevisionsDialog id={p.id} readOnly={readOnly} onClose={() => setRevisions(false)} />}
      {finding && !findDocked && <FindReplaceDialog readOnly={readOnly} onClose={() => setFinding(false)} />}
      {bgPick && slide && !readOnly && (
        <MediaPickerDialog
          title="Choose slide background"
          kinds={['image', 'video']}
          backgroundsFirst
          needsSize
          onClose={() => setBgPick(false)}
          onPick={(m) => {
            // The Slide panel's Replace… for this slide (one undo step): an imported slide's bottom
            // background shapes go, its background picture is re-cropped to the new one, a video becomes
            // the slide's motion background (writing backgroundMediaId alone left them drawn over it).
            replaceBackgroundWith(slide.id, m, 'slide');
            setBgPick(false);
          }}
        />
      )}
      {imagePick && (
        <MediaPickerDialog
          title="Insert an image"
          kinds={['image']}
          onClose={() => setImagePick(false)}
          onPick={(m) => {
            setImagePick(false);
            // An SVG starts at the size it declares (its media size is its still's, `insertBox`).
            void svgDeclared(m).then((declared) => {
              if (readOnlyNow.current) return;
              add(newImage(m.id, insertBox(m, declared)));
            });
          }}
        />
      )}
      {videoPick && (
        <MediaPickerDialog
          title="Add a video to the slide"
          kinds={['video']}
          onClose={() => setVideoPick(false)}
          onPick={(m) => {
            setVideoPick(false);
            if (!slide || readOnly || !mayAdd(slide.id, newVideo(m))) return;
            let added: ReturnType<typeof addVideo> | undefined;
            change((q) => {
              added = addVideo(q, slide.id, m);
              return added.p;
            });
            if (!added?.id) return;
            selectObject(added.id);
            if (added.playing)
              toast(
                `This slide already plays “${media(added.playing.play.mediaId)?.name ?? 'a video'}”. A slide plays one video, so the new one shows its poster: choose Play this one instead in its Video options to switch.`,
                'warn',
                10000,
              );
          }}
        />
      )}
      {replacePicId && !readOnly && (
        <MediaPickerDialog
          title="Replace image"
          kinds={['image']}
          needsSize
          onClose={() => setReplacePicId(null)}
          onPick={(m) => {
            replacePictureWith(replacePicId, m);
            setReplacePicId(null);
          }}
        />
      )}
      {replaceVidId && slide && !readOnly && (
        <MediaPickerDialog
          title="Replace video"
          kinds={['video']}
          onClose={() => setReplaceVidId(null)}
          onPick={(m) => {
            change((q) => updateObject(q, slide.id, replaceVidId, (x) => replaceVideo(x, m)));
            setReplaceVidId(null);
          }}
        />
      )}
      {/* A 409 the three-way merge could not resolve (M4 item H): what overlaps, Reload theirs, Save mine. */}
      {ed.conflict && <ConflictDialog />}
    </div>
  );
  return <DeckSwatchesSource.Provider value={swatchSource}>{page}</DeckSwatchesSource.Provider>;
}

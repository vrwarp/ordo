import { useEffect, useRef, useState } from 'react';
import { FindReplaceDialog } from './FindReplaceDialog.tsx';
import { installKeepVisible } from '../../components/keepVisible.ts';
import { Menu } from '../../components/Menu.tsx';
import { useCoarsePointer, useMedia } from '../../components/pointer.ts';
import { useLockedIds, useMediaLookup } from '../../hooks.ts';
import { useProfile } from '../../lib/capabilities.ts';
import { useLibrary } from '../../state/library.ts';
import { useSession } from '../../state/session.ts';
import { toast } from '../../state/toasts.ts';
import {
  copySelection,
  copyTextSelection,
  cutSelection,
  cutTextSelection,
  deleteSelection,
  duplicateSelection,
  handleTextPaste,
  moveSelection,
  reorderSelection,
  tryPasteObjectsFromClipboard,
  ungroupSelection,
  writeLastObjectClip,
} from './actions.ts';
import { previewLooks } from '../../lib/lookPreviews.ts';
import { uploadFiles } from '../library/MediaTab.tsx';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import { ConflictDialog } from './ConflictDialog.tsx';
import { historyKey, keyPlace, slideNavKey, stepSlide } from './editorKeys.ts';
import { FloatingContextBar } from './FloatingContextBar.tsx';
import { LookPreviews, SingleLookStagePreview } from './LookPreviews.tsx';
import { addVideo } from './mediaOps.ts';
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
import { addObject, getSlide, newImage, newShape, newText, themeOf, type ZOrder } from './ops.ts';
import { hasGroup, htmlToRichText, pasteRichText } from './ops/index.ts';
import { PresentationPanel } from './PresentationPanel.tsx';
import { RevisionsDialog } from './RevisionsDialog.tsx';
import { SlideCanvas } from './SlideCanvas.tsx';
import { makeSlideEditable, SlidePanel } from './SlidePanel.tsx';
import { SlidesPanel } from './SlidesPanel.tsx';
import { SongReflowEditor } from './SongReflowEditor.tsx';

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
  const [bgPick, setBgPick] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [songMode, setSongMode] = useState<'reflow' | 'canvas' | null>(null);
  const [zoom, setZoom] = useState<'fit' | 0.5 | 0.75 | 1>('fit');

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
    void loadPresentation(id, libP);
  }, [id]);
  useEffect(() => {
    if (ed.objectId) setTab('object');
  }, [ed.objectId]);

  const p = ed.id === id ? ed.draft : undefined;
  const readOnly = locked.has(id);
  const slide = p ? getSlide(p, ed.slideId) : undefined;
  const obj = slide?.objects.find((o) => o.id === ed.objectId);

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
      if (place === 'field' || place === 'dialog') return;
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
      const o = currentObject();

      // When nothing has focus (no object is selected on the canvas, and focus is not in a field or dialog),
      // Up/Down arrows and PageUp/PageDown navigate to the previous / next slide.
      if (!o && !st.inlineEditingId && st.draft) {
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

      if (!o || !st.slideId || readOnly) return;
      // The selection acts as one block: a group, or what Shift-click gathered (design/27 §11 item 5).
      if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (place === 'canvas' && !st.inlineEditingId && ctrl && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'c') {
          copySelection();
          return;
        }
        if (k === 'x') {
          cutSelection();
          return;
        }
      }
      if (place !== 'canvas' || ctrl || e.altKey) return;
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
      if (place === 'field' || place === 'dialog') return;
      const st = useEditor.getState();
      if (st.inlineEditingId && st.draft && st.slideId) {
        const s = getSlide(st.draft, st.slideId);
        const inlineObj = s?.objects.find((x) => x.id === st.inlineEditingId);
        if (inlineObj?.type === 'text') {
          if (copyTextSelection(inlineObj, st.textRange.start, st.textRange.end, e.clipboardData)) {
            e.preventDefault();
          }
          return;
        }
      }
      if (place === 'canvas') {
        if (copySelection(e.clipboardData) || writeLastObjectClip(e.clipboardData)) {
          e.preventDefault();
        }
      }
    };

    const onCut = (e: ClipboardEvent) => {
      if (e.defaultPrevented || readOnly) return;
      const place = keyPlace(e.target);
      if (place === 'field' || place === 'dialog') return;
      const st = useEditor.getState();
      if (st.inlineEditingId && st.draft && st.slideId) {
        const s = getSlide(st.draft, st.slideId);
        const inlineObj = s?.objects.find((x) => x.id === st.inlineEditingId);
        if (inlineObj?.type === 'text') {
          const caret = cutTextSelection(inlineObj, st.textRange.start, st.textRange.end, e.clipboardData);
          if (caret !== null) {
            e.preventDefault();
            setTextRange({ start: caret, end: caret, caret });
            syncInlineTextarea(caret);
          }
          return;
        }
      }
      if (place === 'canvas') {
        if (cutSelection(e.clipboardData) || writeLastObjectClip(e.clipboardData)) {
          e.preventDefault();
        }
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || readOnly) return;
      const place = keyPlace(e.target);
      if (place === 'field' || place === 'dialog') return;
      const st = useEditor.getState();
      if (!st.draft || !st.slideId) return;

      // 1. If inline editing a text box on the canvas, paste into that text box at `textRange`.
      if (st.inlineEditingId) {
        const s = getSlide(st.draft, st.slideId);
        const inlineObj = s?.objects.find((x) => x.id === st.inlineEditingId);
        if (inlineObj?.type === 'text') {
          const caret = handleTextPaste(inlineObj, st.textRange.start, st.textRange.end, e.clipboardData);
          if (caret !== null) {
            e.preventDefault();
            setTextRange({ start: caret, end: caret, caret });
            syncInlineTextarea(caret);
          }
          return;
        }
      }

      if (place !== 'canvas') return;

      // 2. Check for an image file/blob in the clipboard (e.g. screenshot or copied image).
      const items = [...(e.clipboardData?.items ?? [])];
      const imgItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
      const rawFile =
        imgItem?.getAsFile() ?? [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (rawFile) {
        e.preventDefault();
        const ext = rawFile.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        const named =
          !rawFile.name || rawFile.name === 'image.png'
            ? new File([rawFile], `pasted-${Date.now()}.${ext}`, { type: rawFile.type })
            : rawFile;
        const targetSlideId = st.slideId;
        void uploadFiles([named]).then((uploaded) => {
          const m = uploaded[0];
          if (!m) return;
          const w = m.width && m.height ? Math.min(1920, m.width) : 960;
          const h = m.width && m.height ? (w * m.height) / m.width : 540;
          const imgObj = newImage(m.id, {
            x: Math.round((1920 - w) / 2),
            y: Math.max(0, Math.round((1080 - h) / 2)),
            w: Math.round(w),
            h: Math.min(1080, Math.round(h)),
            rotation: 0,
          });
          change((q) => addObject(q, targetSlideId, imgObj));
          selectObject(imgObj.id);
        });
        return;
      }

      // 3. Check for copied Ordo slide objects (`data-ordo-objects` or in-memory object clipboard).
      const pastedIds = tryPasteObjectsFromClipboard(e.clipboardData);
      if (pastedIds?.length) {
        e.preventDefault();
        return;
      }

      // 4. Check for rich or plain text pasted directly onto the slide canvas -> create a new TextObject.
      const html = e.clipboardData?.getData('text/html') ?? '';
      const plain = e.clipboardData?.getData('text/plain') ?? '';
      const curTheme = themeOf(st.draft, useLibrary.getState().data.themes);
      const richSlice =
        (html && htmlToRichText(html, curTheme.textBoxDefaults)) || (plain ? { text: plain } : null);
      if (richSlice?.text.trim()) {
        e.preventDefault();
        const baseObj = newText(curTheme, '');
        const { object } = pasteRichText(baseObj, 0, 0, richSlice);
        const targetSlideId = st.slideId;
        change((q) => addObject(q, targetSlideId, object));
        selectObject(object.id);
      }
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
    };
  }, [readOnly]);

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
  const add = (o: Parameters<typeof addObject>[2]) => {
    if (!slide || readOnly) return;
    change((q) => addObject(q, slide.id, o));
    selectObject(o.id);
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

  return (
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
            disabled={readOnly || !obj}
            items={[
              { label: '⤒ Bring to front', name: 'Front', onSelect: () => z('front') },
              { label: '↑ Bring forward', name: 'Forward', onSelect: () => z('forward') },
              { label: '↓ Send backward', name: 'Backward', onSelect: () => z('backward') },
              { label: '⤓ Send to back', name: 'Back', onSelect: () => z('back') },
              { label: '⧉ Duplicate', name: 'Duplicate', onSelect: duplicate },
              { label: '🗑 Delete', name: 'Delete', danger: true, onSelect: remove },
              ...(grouped ? [{ label: 'Ungroup', onSelect: ungroupSelection }] : []),
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
        <div className="toolbar ed-toolbar-calm">
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
          {!(p.kind === 'song' && (songMode ?? 'reflow') === 'reflow') && (
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

          {/* Right Zone: Search, Zoom, On-Demand Drawer Triggers, Focus Mode */}
          {!(p.kind === 'song' && (songMode ?? 'reflow') === 'reflow') && (
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
          {!(p.kind === 'song' && (songMode ?? 'reflow') === 'reflow') && (
            <div className="ed-drawer-triggers" role="group" aria-label="Inspector panels">
              {!drawerOpen ? (
                <>
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
                </>
              ) : (
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
              )}
            </div>
          )}
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
      )}
      {p.kind === 'song' && (songMode ?? (coarse ? 'canvas' : 'reflow')) === 'reflow' ? (
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
            </>
          }
        />
      ) : (
        <>
          <SlidesPanel
            p={p}
            readOnly={readOnly}
            onSwitchToReflow={p.kind === 'song' ? () => setSongMode('reflow') : undefined}
          />
          <div className="stagewrap">
            {readOnly && (
              <div className="banner" style={{ margin: 8 }} data-locked-banner>
                {profile === 'edit'
                  ? 'This presentation is in the playlist that is live at the venue. It can be edited again after the service.'
                  : 'This presentation is in the live playlist. Editing is locked until End service.'}
              </div>
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
              activeLensLook ? (
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
                      <FloatingContextBar
                        readOnly={readOnly}
                        drawerOpen={drawerOpen && tab === 'object'}
                        onToggleDrawer={() => openDrawerTab('object')}
                      />
                    ) : undefined
                  }
                  slideRect={p.source?.native?.slideRect}
                />
              )
            ) : (
              <div className="center muted">Add a slide to start.</div>
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
                <LookPreviews
                  presentation={p}
                  slideId={slide?.id}
                  compact
                  onSelectLook={(lookId) => setStageLens(stageLens === lookId ? 'canvas' : lookId)}
                />
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
              {tab === 'object' && obj && <ObjectPanel o={obj} readOnly={readOnly} />}
              {tab === 'object' && !obj && <span className="muted">Select an object on the slide.</span>}
              {tab === 'slide' && slide && <SlidePanel slide={slide} p={p} readOnly={readOnly} />}
              {tab === 'presentation' && <PresentationPanel p={p} readOnly={readOnly} />}
            </aside>
          )}
        </>
      )}
      {revisions && <RevisionsDialog id={p.id} readOnly={readOnly} onClose={() => setRevisions(false)} />}
      {finding && <FindReplaceDialog readOnly={readOnly} onClose={() => setFinding(false)} />}
      {bgPick && slide && !readOnly && (
        <MediaPickerDialog
          title="Choose slide background"
          kinds={['image', 'video']}
          backgroundsFirst
          onClose={() => setBgPick(false)}
          onPick={(m) => {
            change((q) => ({
              ...q,
              sections: q.sections.map((sec) => ({
                ...sec,
                slides: sec.slides.map((sl) =>
                  sl.id === slide.id ? { ...sl, backgroundMediaId: m.id } : sl,
                ),
              })),
            }));
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
            const w = m.width && m.height ? Math.min(1920, m.width) : 960;
            const h = m.width && m.height ? (w * m.height) / m.width : 540;
            add(
              newImage(m.id, {
                x: (1920 - w) / 2,
                y: Math.max(0, (1080 - h) / 2),
                w,
                h: Math.min(1080, h),
                rotation: 0,
              }),
            );
            setImagePick(false);
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
            if (!slide || readOnly) return;
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
      {/* A 409 the three-way merge could not resolve (M4 item H): what overlaps, Reload theirs, Save mine. */}
      {ed.conflict && <ConflictDialog />}
    </div>
  );
}

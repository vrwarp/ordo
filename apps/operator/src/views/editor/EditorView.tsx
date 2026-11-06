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
  deleteSelection,
  duplicateSelection,
  moveSelection,
  reorderSelection,
  ungroupSelection,
} from './actions.ts';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import { ConflictDialog } from './ConflictDialog.tsx';
import { LookPreviews } from './LookPreviews.tsx';
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
  undo,
  useEditor,
} from './editorStore.ts';
// `window.__ordo.editor`, read by the end-to-end specs (e2e/editorhelpers.ts).
import './inspect.ts';
import { ObjectPanel } from './ObjectPanel.tsx';
import { addObject, getSlide, newImage, newShape, newText, themeOf, type ZOrder } from './ops.ts';
import { hasGroup } from './ops/group.ts';
import { PresentationPanel } from './PresentationPanel.tsx';
import { PreviewControl } from './PreviewControl.tsx';
import { RevisionsDialog } from './RevisionsDialog.tsx';
import { SlideCanvas } from './SlideCanvas.tsx';
import { SlidePanel } from './SlidePanel.tsx';
import { SlidesPanel } from './SlidesPanel.tsx';

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

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/** The full slide editor (prd/03, design/15). */
export function EditorView({ id }: { id: string }) {
  const ed = useEditor();
  const libP = useLibrary((s) => s.data.presentations.find((p) => p.id === id));
  const themes = useLibrary((s) => s.data.themes);
  const locked = useLockedIds();
  const media = useMediaLookup();
  const [tab, setTab] = useState<'object' | 'slide' | 'presentation'>('slide');
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
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!readOnly) void save();
        return;
      }
      if (isTyping(e)) return;
      if (ctrl && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFinding(true);
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (!readOnly) undo();
        return;
      }
      if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (!readOnly) redo();
        return;
      }
      const st = useEditor.getState();
      const o = currentObject();
      if (!o || !st.slideId || readOnly) return;
      // The selection acts as one block: a group, or what Shift-click gathered (design/27 §11 item 5).
      if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[
        e.key
      ];
      if (d) {
        e.preventDefault();
        nudge(d[0]!, d[1]!);
        return;
      }
      if (e.key === 'Enter' && o.type === 'text') {
        e.preventDefault();
        setTab('object');
        setTimeout(
          () => (document.getElementById('ordo-text-editor') as HTMLTextAreaElement | null)?.focus(),
          0,
        );
      }
      if (e.key === 'Escape') selectObject(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
    if (objectId && objectId !== ed.objectId) selectObject(objectId);
    setTab('object');
    focusTextEditor();
  };
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

  return (
    <div className="editor" ref={root}>
      {coarse ? (
        <div className="toolbar ed-toolbar-touch">
          <a className="btn small ghost" href="#/library">
            ← Library
          </a>
          <b className="ellipsis ed-title">{p.title}</b>
          <button
            type="button"
            className="primary"
            disabled={readOnly || !ed.dirty || ed.saving}
            onClick={() => void save()}
          >
            {ed.saving ? 'Saving…' : ed.dirty ? 'Save' : 'Saved'}
          </button>
          <button type="button" disabled={readOnly || !ed.canUndo} onClick={undo}>
            ↶<span className="touch-label">Undo</span>
          </button>
          <button type="button" disabled={readOnly || !ed.canRedo} onClick={redo}>
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
          <PreviewControl p={p} slideId={slide?.id} />
          <button type="button" onClick={() => setFinding(true)} title="Find and replace (Ctrl+F)">
            Find…
          </button>
          <button type="button" onClick={() => setRevisions(true)}>
            History
          </button>
        </div>
      ) : (
        <div className="toolbar">
          <a className="btn small ghost" href="#/library">
            ← Library
          </a>
          <b className="ellipsis" style={{ maxWidth: 260 }}>
            {p.title}
          </b>
          <span className="muted small">rev {ed.base?.rev}</span>
          <button
            type="button"
            className="primary"
            disabled={readOnly || !ed.dirty || ed.saving}
            onClick={() => void save()}
            title="Ctrl+S"
          >
            {ed.saving ? 'Saving…' : ed.dirty ? 'Save' : 'Saved'}
          </button>
          <button type="button" disabled={readOnly || !ed.canUndo} onClick={undo} title="Ctrl+Z">
            ↶<span className="touch-label">Undo</span>
          </button>
          <button type="button" disabled={readOnly || !ed.canRedo} onClick={redo} title="Ctrl+Y">
            ↷<span className="touch-label">Redo</span>
          </button>
          <span style={{ width: 10 }} />
          <button type="button" disabled={readOnly || !slide} onClick={() => add(newText(theme))}>
            + Text
          </button>
          <button type="button" disabled={readOnly || !slide} onClick={() => setImagePick(true)}>
            + Image
          </button>
          <button
            type="button"
            disabled={readOnly || !slide}
            onClick={() => setVideoPick(true)}
            title="Add a video that plays in the slide"
          >
            + Video
          </button>
          <button type="button" disabled={readOnly || !slide} onClick={() => add(newShape('rect'))}>
            + Rect
          </button>
          <button type="button" disabled={readOnly || !slide} onClick={() => add(newShape('ellipse'))}>
            + Ellipse
          </button>
          <button type="button" disabled={readOnly || !slide} onClick={() => add(newShape('line'))}>
            + Line
          </button>
          <span style={{ width: 10 }} />
          <button
            type="button"
            className="small"
            disabled={readOnly || !obj}
            onClick={() => z('front')}
            title="Bring to front"
          >
            ⤒<span className="touch-label">Front</span>
          </button>
          <button
            type="button"
            className="small"
            disabled={readOnly || !obj}
            onClick={() => z('forward')}
            title="Bring forward"
          >
            ↑<span className="touch-label">Forward</span>
          </button>
          <button
            type="button"
            className="small"
            disabled={readOnly || !obj}
            onClick={() => z('backward')}
            title="Send backward"
          >
            ↓<span className="touch-label">Backward</span>
          </button>
          <button
            type="button"
            className="small"
            disabled={readOnly || !obj}
            onClick={() => z('back')}
            title="Send to back"
          >
            ⤓<span className="touch-label">Back</span>
          </button>
          <button
            type="button"
            className="small"
            disabled={readOnly || !obj}
            title="Duplicate (Ctrl+D)"
            onClick={duplicate}
          >
            ⧉<span className="touch-label">Duplicate</span>
          </button>
          <button type="button" className="small" disabled={readOnly || !obj} title="Delete" onClick={remove}>
            🗑<span className="touch-label">Delete</span>
          </button>
          <button type="button" className="small" disabled={readOnly || !grouped} onClick={ungroupSelection}>
            Ungroup
          </button>
          <span className="spacer" />
          <PreviewControl p={p} slideId={slide?.id} />
          <button type="button" onClick={() => setFinding(true)} title="Find and replace (Ctrl+F)">
            Find…
          </button>
          <button type="button" onClick={() => setRevisions(true)}>
            History
          </button>
        </div>
      )}
      <SlidesPanel p={p} readOnly={readOnly} />
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
              Someone else saved this presentation (rev {libP.rev}) since you opened it. Saving combines your
              changes with theirs.
            </span>
            <button type="button" className="small" onClick={() => void reloadLatest()}>
              Reload theirs
            </button>
            <button type="button" className="small" onClick={() => setDismissedRev(libP.rev)}>
              Keep editing
            </button>
          </div>
        )}
        {slide ? (
          <SlideCanvas
            slide={slide}
            backgroundMediaId={bgId}
            media={media}
            readOnly={readOnly}
            onEditText={editText}
            objectTools={objectTools}
            slideRect={p.source?.native?.slideRect}
          />
        ) : (
          <div className="center muted">Add a slide to start.</div>
        )}
        <details
          className="ed-looks"
          open={looksShown}
          onToggle={(e) => {
            const open = (e.currentTarget as HTMLDetailsElement).open;
            if (open === looksShown) return;
            setLooksOpen(open);
            try {
              localStorage.setItem(LOOKS_OPEN_KEY, open ? '1' : '0');
            } catch {
              /* private mode: not remembered */
            }
          }}
        >
          <summary>Look previews</summary>
          {looksShown && <LookPreviews presentation={p} slideId={slide?.id} compact />}
        </details>
      </div>
      <div className="props">
        <div className="row" style={{ marginBottom: 8, gap: 4 }}>
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
        {tab === 'object' && obj && <ObjectPanel o={obj} readOnly={readOnly} />}
        {tab === 'object' && !obj && <span className="muted">Select an object on the slide.</span>}
        {tab === 'slide' && slide && <SlidePanel slide={slide} p={p} readOnly={readOnly} />}
        {tab === 'presentation' && <PresentationPanel p={p} readOnly={readOnly} />}
      </div>
      {revisions && <RevisionsDialog id={p.id} readOnly={readOnly} onClose={() => setRevisions(false)} />}
      {finding && <FindReplaceDialog readOnly={readOnly} onClose={() => setFinding(false)} />}
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

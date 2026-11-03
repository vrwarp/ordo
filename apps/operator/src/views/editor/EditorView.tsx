import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { useLockedIds, useMediaLookup } from '../../hooks.ts';
import { useLibrary } from '../../state/library.ts';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import {
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
import { ObjectPanel } from './ObjectPanel.tsx';
import {
  addObject,
  deleteObject,
  duplicateObject,
  getSlide,
  newImage,
  newShape,
  newText,
  reorderObject,
  themeOf,
  updateObject,
  type ZOrder,
} from './ops.ts';
import { PresentationPanel } from './PresentationPanel.tsx';
import { RevisionsDialog } from './RevisionsDialog.tsx';
import { SlideCanvas } from './SlideCanvas.tsx';
import { SlidePanel } from './SlidePanel.tsx';
import { SlidesPanel } from './SlidesPanel.tsx';

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
  const [dismissedRev, setDismissedRev] = useState(0);

  useEffect(() => {
    void loadPresentation(id, libP);
    // biome-ignore lint/correctness/useExhaustiveDependencies: load once per id
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
      if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        let newId: string | undefined;
        change((q) => {
          const r = duplicateObject(q, st.slideId!, o.id);
          newId = r.id;
          return r.p;
        });
        if (newId) selectObject(newId);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        change((q) => deleteObject(q, st.slideId!, o.id));
        selectObject(undefined);
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) {
        e.preventDefault();
        change(
          (q) => updateObject(q, st.slideId!, o.id, (x) => ({ ...x, box: { ...x.box, x: x.box.x + d[0]!, y: x.box.y + d[1]! } })),
          `nudge:${o.id}`,
        );
        return;
      }
      if (e.key === 'Enter' && o.type === 'text') {
        e.preventDefault();
        setTab('object');
        setTimeout(() => (document.getElementById('ordo-text-editor') as HTMLTextAreaElement | null)?.focus(), 0);
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
  const changedElsewhere = !!libP && !!ed.base && libP.rev > ed.base.rev && !ed.saving && libP.rev !== dismissedRev;
  const z = (zz: ZOrder) => obj && slide && change((q) => reorderObject(q, slide.id, obj.id, zz));
  const add = (o: Parameters<typeof addObject>[2]) => {
    if (!slide || readOnly) return;
    change((q) => addObject(q, slide.id, o));
    selectObject(o.id);
  };
  const bgId = slide?.backgroundMediaId ?? p.backgroundMediaId;

  return (
    <div className="editor">
      <div className="toolbar">
        <a className="btn small ghost" href="#/library">
          ← Library
        </a>
        <b className="ellipsis" style={{ maxWidth: 260 }}>
          {p.title}
        </b>
        <span className="muted small">rev {ed.base?.rev}</span>
        <button type="button" className="primary" disabled={readOnly || !ed.dirty || ed.saving} onClick={() => void save()} title="Ctrl+S">
          {ed.saving ? 'Saving…' : ed.dirty ? 'Save' : 'Saved'}
        </button>
        <button type="button" disabled={readOnly || !ed.canUndo} onClick={undo} title="Ctrl+Z">
          ↶
        </button>
        <button type="button" disabled={readOnly || !ed.canRedo} onClick={redo} title="Ctrl+Y">
          ↷
        </button>
        <span style={{ width: 10 }} />
        <button type="button" disabled={readOnly || !slide} onClick={() => add(newText(theme))}>
          + Text
        </button>
        <button type="button" disabled={readOnly || !slide} onClick={() => setImagePick(true)}>
          + Image
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
        <button type="button" className="small" disabled={readOnly || !obj} onClick={() => z('front')} title="Bring to front">
          ⤒
        </button>
        <button type="button" className="small" disabled={readOnly || !obj} onClick={() => z('forward')} title="Bring forward">
          ↑
        </button>
        <button type="button" className="small" disabled={readOnly || !obj} onClick={() => z('backward')} title="Send backward">
          ↓
        </button>
        <button type="button" className="small" disabled={readOnly || !obj} onClick={() => z('back')} title="Send to back">
          ⤓
        </button>
        <button
          type="button"
          className="small"
          disabled={readOnly || !obj}
          title="Duplicate (Ctrl+D)"
          onClick={() => {
            if (!obj || !slide) return;
            let nid: string | undefined;
            change((q) => {
              const r = duplicateObject(q, slide.id, obj.id);
              nid = r.id;
              return r.p;
            });
            if (nid) selectObject(nid);
          }}
        >
          ⧉
        </button>
        <button
          type="button"
          className="small"
          disabled={readOnly || !obj}
          title="Delete"
          onClick={() => {
            if (!obj || !slide) return;
            change((q) => deleteObject(q, slide.id, obj.id));
            selectObject(undefined);
          }}
        >
          🗑
        </button>
        <span className="spacer" />
        <button type="button" onClick={() => setRevisions(true)}>
          History
        </button>
      </div>
      <SlidesPanel p={p} readOnly={readOnly} />
      <div className="stagewrap">
        {readOnly && (
          <div className="banner" style={{ margin: 8 }}>
            This presentation is in the live playlist. Editing is locked until End service.
          </div>
        )}
        {changedElsewhere && (
          <div className="banner blue row" style={{ margin: 8 }}>
            <span className="grow">Someone else saved this presentation (rev {libP.rev}) since you opened it.</span>
            <button type="button" className="small" onClick={() => void reloadLatest()}>
              Reload theirs
            </button>
            <button type="button" className="small" onClick={() => setDismissedRev(libP.rev)}>
              Keep editing
            </button>
          </div>
        )}
        {slide ? (
          <SlideCanvas slide={slide} backgroundMediaId={bgId} media={media} readOnly={readOnly} />
        ) : (
          <div className="center muted">Add a slide to start.</div>
        )}
      </div>
      <div className="props">
        <div className="row" style={{ marginBottom: 8, gap: 4 }}>
          <button type="button" className={`small ${tab === 'object' ? 'on' : ''}`} disabled={!obj} onClick={() => setTab('object')}>
            Object
          </button>
          <button type="button" className={`small ${tab === 'slide' ? 'on' : ''}`} disabled={!slide} onClick={() => setTab('slide')}>
            Slide
          </button>
          <button type="button" className={`small ${tab === 'presentation' ? 'on' : ''}`} onClick={() => setTab('presentation')}>
            Presentation
          </button>
        </div>
        {tab === 'object' && obj && <ObjectPanel o={obj} readOnly={readOnly} />}
        {tab === 'object' && !obj && <span className="muted">Select an object on the slide.</span>}
        {tab === 'slide' && slide && <SlidePanel slide={slide} p={p} readOnly={readOnly} />}
        {tab === 'presentation' && <PresentationPanel p={p} readOnly={readOnly} />}
      </div>
      {revisions && <RevisionsDialog id={p.id} readOnly={readOnly} onClose={() => setRevisions(false)} />}
      {imagePick && (
        <MediaPickerDialog
          title="Insert an image"
          kinds={['image']}
          onClose={() => setImagePick(false)}
          onPick={(m) => {
            const w = m.width && m.height ? Math.min(1920, m.width) : 960;
            const h = m.width && m.height ? (w * m.height) / m.width : 540;
            add(newImage(m.id, { x: (1920 - w) / 2, y: Math.max(0, (1080 - h) / 2), w, h: Math.min(1080, h), rotation: 0 }));
            setImagePick(false);
          }}
        />
      )}
      {ed.conflict && (
        <Dialog
          title="Changed by someone else"
          onClose={() => useEditor.setState({ conflict: false })}
          footer={
            <>
              <button type="button" onClick={() => useEditor.setState({ conflict: false })}>
                Cancel
              </button>
              <button type="button" onClick={() => void reloadLatest()}>
                Reload theirs (discard mine)
              </button>
              <button type="button" className="primary" onClick={() => void save(true)}>
                Save mine anyway
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            This presentation was saved by someone else after you opened it. Saving yours replaces theirs (their version stays in the
            history), or reload to see their changes.
          </p>
        </Dialog>
      )}
    </div>
  );
}

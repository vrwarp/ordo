import type { Presentation, Slide } from '@ordo/domain';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { change } from './editorStore.ts';
import { applyNoteFormatting, handleSpeakerNoteKeyDown, type NoteFormatAction } from './noteEditing.ts';
import { updateSlide } from './ops.ts';

export { applyNoteFormatting, type NoteFormatAction };

const LS_DOCK_H = 'ordo.editor.notesDockH';

function initialDockHeight(): number {
  try {
    const v = Number(localStorage.getItem(LS_DOCK_H));
    if (Number.isFinite(v) && v >= 84 && v <= 340) return v;
  } catch {
    /* private mode */
  }
  return 118;
}

export function SpeakerNotesDock(props: {
  slide: Slide;
  presentation: Presentation;
  readOnly: boolean;
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  onOpenStudio?: () => void;
  onPreviewStage?: () => void;
}) {
  const { slide, presentation: p, readOnly, open, onToggleOpen, onOpenStudio, onPreviewStage } = props;
  const [height, setHeight] = useState<number>(initialDockHeight);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const notes = slide.notes ?? '';
  const trimmed = notes.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;

  const setNotes = (val: string, discrete = false) => {
    if (readOnly) return;
    change(
      (q) => updateSlide(q, slide.id, (s) => ({ ...s, notes: val || undefined })),
      discrete ? undefined : `notes:${slide.id}`,
    );
  };

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => {
      const nextH = Math.max(84, Math.min(340, Math.round(startH + (startY - ev.clientY))));
      setHeight(nextH);
      try {
        localStorage.setItem(LS_DOCK_H, String(nextH));
      } catch {
        /* private mode */
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!open) {
    return (
      <div className="ed-notes-dock collapsed" data-notes-dock="collapsed">
        <button
          type="button"
          className="ed-notes-collapsed-trigger"
          onClick={() => {
            onToggleOpen(true);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
          title="Open speaker notes dock (Alt+N)"
        >
          <span className="ed-notes-icon">📝</span>
          <strong className="ed-notes-label">Speaker Notes</strong>
          <span className={`ed-notes-snippet${trimmed ? ' has-text' : ''}`}>
            {trimmed
              ? trimmed.replace(/\s+/g, ' ')
              : p.kind === 'song'
                ? 'Add band chords or arrangement cues for the stage monitor (Alt+N)…'
                : 'Add preacher notes or cues for Stage & Pulpit Lectern (Alt+N)…'}
          </span>
        </button>
        {onOpenStudio && (
          <button
            type="button"
            className="small ghost ed-notes-studio-btn"
            onClick={onOpenStudio}
            title="Open full-deck Presenter Notes Studio"
          >
            Manuscript Studio ↗
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="ed-notes-dock expanded" style={{ height }} data-notes-dock="expanded">
      <div
        className="ed-notes-resize-handle"
        onPointerDown={onResizeStart}
        title="Drag to resize speaker notes"
      />
      <div className="ed-notes-hdr">
        <div className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
          <button
            type="button"
            className="small ghost"
            onClick={() => onToggleOpen(false)}
            title="Collapse speaker notes dock (Alt+N)"
            style={{ fontWeight: 700, padding: '2px 6px' }}
          >
            📝 Speaker Notes ▾
          </button>
          <span className="ed-notes-stage-hint">
            {p.kind === 'song' ? 'Stage: Band Cue · 42pt' : 'Stage: Preacher Split · 58pt'}
            {wordCount > 0 ? ` · ${wordCount}w` : ''}
          </span>
        </div>

        <div className="row" style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          {!readOnly && (
            <div className="ed-notes-fmt-group" role="group" aria-label="Stage note emphasis">
              <button
                type="button"
                className="small ghost"
                title="Toggle **highlight** on selected text (Cmd/Ctrl+B)"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyNoteFormatting(textareaRef.current, notes, 'highlight', setNotes)}
              >
                ★ Highlight
              </button>
              <button
                type="button"
                className="small ghost"
                title="Toggle bullet on current line"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyNoteFormatting(textareaRef.current, notes, 'bullet', setNotes)}
              >
                • Bullet
              </button>
              <button
                type="button"
                className="small ghost"
                title="Toggle [cue] badge"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyNoteFormatting(textareaRef.current, notes, 'cue', setNotes)}
              >
                [Cue]
              </button>
            </div>
          )}
          {onPreviewStage && (
            <button
              type="button"
              className="small ghost"
              onClick={onPreviewStage}
              title="Preview how this slide and its notes appear on the Stage screen"
            >
              Stage Preview
            </button>
          )}
          {onOpenStudio && (
            <button
              type="button"
              className="small ghost"
              onClick={onOpenStudio}
              title="Open continuous full-deck Presenter Notes Studio"
            >
              Manuscript Studio ↗
            </button>
          )}
        </div>
      </div>
      <textarea
        ref={textareaRef}
        aria-label="Speaker notes"
        className="ed-notes-textarea"
        value={notes}
        disabled={readOnly}
        onKeyDown={(e) =>
          handleSpeakerNoteKeyDown(e, {
            el: textareaRef.current,
            notes,
            readOnly,
            commit: setNotes,
          })
        }
        onChange={(e) => setNotes(e.target.value)}
        placeholder={
          p.kind === 'song'
            ? 'Type chords or band cues (e.g. Key: G · Capo 2 | **Build on bridge** | [HOLD])…'
            : 'Type speaker notes for the preacher… Use **asterisks** for yellow stage highlights, • for bullets, or [PAUSE] for cues.'
        }
      />
    </div>
  );
}

import { importedText, type Presentation, readableText, type Slide } from '@ordo/domain';
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from 'react';
import { useMediaLookup, useVisible } from '../../hooks.ts';
import { stillHash, useThumb } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import { change, selectSlide, useEditor } from './editorStore.ts';
import { LookPreviews } from './LookPreviews.tsx';
import { addSection, addSlide, themeOf, updateSlide } from './ops.ts';
import { applyNoteFormatting, type NoteFormatAction } from './SpeakerNotesDock.tsx';

function slideSummaryText(slide: Slide): string {
  for (const o of slide.objects) {
    if (o.type === 'text' && o.text.trim()) return readableText(o);
  }
  if (slide.scripture) return slide.scripture.text;
  return importedText(slide);
}

function ManuscriptSlideCard(props: {
  slide: Slide;
  presentation: Presentation;
  sectionLabel: string;
  slideNumber: number;
  selected: boolean;
  readOnly: boolean;
  onEditCanvas: () => void;
  registerTextarea: (slideId: string, el: HTMLTextAreaElement | null) => void;
  onStepSlide: (delta: -1 | 1) => void;
}) {
  const { slide, presentation: p, sectionLabel, slideNumber, selected, readOnly, onEditCanvas } = props;
  const media = useMediaLookup();
  const [cardRef, visible] = useVisible<HTMLDivElement>();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const bgId = slide.backgroundMediaId ?? p.backgroundMediaId;
  const thumbUrl = useThumb(
    slide,
    { isSong: p.kind === 'song', media, bg: bgId ? stillHash(media(bgId)) : undefined, width: 320 },
    visible,
  );
  const notes = slide.notes ?? '';
  const words = notes.trim() ? notes.trim().split(/\s+/).length : 0;
  const excerpt = slideSummaryText(slide).replace(/\s+/g, ' ').trim();

  const setNotes = (val: string) => {
    if (readOnly) return;
    change((q) => updateSlide(q, slide.id, (s) => ({ ...s, notes: val || undefined })), `notes:${slide.id}`);
  };

  const format = (action: NoteFormatAction) => {
    selectSlide(slide.id);
    applyNoteFormatting(taRef.current, notes, action, setNotes);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      format('highlight');
      return;
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      props.onStepSlide(e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const rows = Math.max(3, Math.min(18, notes.split('\n').length + 1));

  return (
    <div
      ref={cardRef}
      data-manuscript-slide={slide.id}
      onClick={() => selectSlide(slide.id)}
      className={`ed-ms-card${selected ? ' sel' : ''}${slide.hidden ? ' hidden-slide' : ''}`}
    >
      {/* Left Visual Slide Thumbnail & Slide Context */}
      <div className="ed-ms-left">
        <div className="ed-ms-thumb-box">
          {thumbUrl ? (
            <img src={thumbUrl} alt={`Slide ${slideNumber}`} draggable={false} />
          ) : (
            <div className="ph" />
          )}
          <span className="ed-ms-num-pill">#{slideNumber}</span>
          {slide.hidden && <span className="ed-ms-hidden-pill">Hidden</span>}
        </div>
        <div className="ed-ms-meta">
          <span className="ed-ms-sec">{sectionLabel}</span>
          {excerpt ? (
            <span className="ed-ms-excerpt" title={excerpt}>
              {excerpt}
            </span>
          ) : (
            <span className="ed-ms-excerpt muted">(Visual slide)</span>
          )}
        </div>
        <button
          type="button"
          className="small ghost ed-ms-canvas-btn"
          onClick={(e) => {
            e.stopPropagation();
            selectSlide(slide.id);
            onEditCanvas();
          }}
        >
          Edit on Canvas →
        </button>
      </div>

      {/* Right Full-Width Speaker Notes Manuscript Editor */}
      <div className="ed-ms-right">
        <div className="ed-ms-toolbar">
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <strong style={{ fontSize: 12.5 }}>Slide {slideNumber} Speaker Notes</strong>
            {words > 0 ? (
              <span className="muted small">
                {words} word{words === 1 ? '' : 's'} · ~{Math.max(5, Math.round((words / 135) * 60))}s
              </span>
            ) : (
              <span className="muted small">Empty</span>
            )}
          </div>
          {!readOnly && (
            <div
              className="ed-notes-fmt-group"
              role="group"
              aria-label={`Slide ${slideNumber} note formatting`}
            >
              <button
                type="button"
                className="small ghost"
                onClick={() => format('highlight')}
                title="Highlight key phrase (**bold**)"
              >
                ★ Highlight
              </button>
              <button
                type="button"
                className="small ghost"
                onClick={() => format('bullet')}
                title="Toggle bullet list"
              >
                • Bullet
              </button>
              <button
                type="button"
                className="small ghost"
                onClick={() => format('pause')}
                title="Insert [PAUSE] cue"
              >
                + [PAUSE]
              </button>
              <button
                type="button"
                className="small ghost"
                onClick={() => format('cue')}
                title="Insert [CUE: ...] badge"
              >
                + [CUE]
              </button>
            </div>
          )}
        </div>
        <textarea
          ref={(el) => {
            taRef.current = el;
            props.registerTextarea(slide.id, el);
          }}
          aria-label={`Slide ${slideNumber} speaker notes`}
          className="ed-ms-textarea"
          rows={rows}
          value={notes}
          disabled={readOnly}
          onFocus={() => selectSlide(slide.id)}
          onKeyDown={onKeyDown}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Write sermon manuscript, key quotes, or booth cues for this slide… (**highlight**, • bullet, [PAUSE])"
        />
      </div>
    </div>
  );
}

/**
 * Proposal B — Continuous 2-Column Sermon & Deck Presenter Notes Studio (`DeckNotesEditor`):
 * Lets pastors and producers author or review an entire presentation's speaker notes in one scrollable
 * manuscript alongside live 3-screen Audience, Stage Split, and Stream previews.
 */
export default function DeckNotesEditor(props: {
  presentation: Presentation;
  readOnly: boolean;
  selectedSlideId?: string;
  onSwitchToCanvas: () => void;
  banners?: ReactNode;
}) {
  const { presentation: p, readOnly, selectedSlideId, onSwitchToCanvas, banners } = props;
  const edSlideId = useEditor((s) => s.slideId);
  const themes = useLibrary((s) => s.data.themes);
  const theme = themeOf(p, themes);
  const [filter, setFilter] = useState<'all' | 'withNotes' | 'missing'>('all');
  const taMap = useRef(new Map<string, HTMLTextAreaElement>());

  const flat = useMemo(() => {
    const list: { slide: Slide; sectionId: string; sectionLabel: string; number: number }[] = [];
    let n = 1;
    for (const sec of p.sections) {
      for (const sl of sec.slides) {
        list.push({ slide: sl, sectionId: sec.id, sectionLabel: sec.label || 'Slides', number: n++ });
      }
    }
    return list;
  }, [p]);

  const stats = useMemo(() => {
    let notedSlides = 0;
    let totalWords = 0;
    for (const item of flat) {
      const t = item.slide.notes?.trim();
      if (t) {
        notedSlides++;
        totalWords += t.split(/\s+/).length;
      }
    }
    const estMinutes = totalWords > 0 ? Math.max(1, Math.round(totalWords / 135)) : 0;
    return { notedSlides, totalSlides: flat.length, totalWords, estMinutes };
  }, [flat]);

  const visibleRows = useMemo(() => {
    if (filter === 'withNotes') return flat.filter((r) => Boolean(r.slide.notes?.trim()));
    if (filter === 'missing') return flat.filter((r) => !r.slide.notes?.trim());
    return flat;
  }, [flat, filter]);

  const activeId = selectedSlideId ?? edSlideId ?? flat[0]?.slide.id;

  const stepFocus = (fromSlideId: string, delta: -1 | 1) => {
    const idx = visibleRows.findIndex((r) => r.slide.id === fromSlideId);
    const target = visibleRows[idx + delta];
    if (!target) return;
    selectSlide(target.slide.id);
    const el = taMap.current.get(target.slide.id);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  return (
    <div className="ed-ms-studio" data-deck-notes-studio>
      {/* Studio Summary & Filter Header */}
      <div className="ed-ms-studio-bar">
        <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
          <strong style={{ fontSize: 14 }}>Presenter Notes Studio</strong>
          <span className="tag">
            📝 {stats.notedSlides}/{stats.totalSlides} slides with notes
          </span>
          <span className="muted small">
            {stats.totalWords.toLocaleString()} words
            {stats.estMinutes > 0 ? ` · ~${stats.estMinutes} min speaking time (@ 135 wpm)` : ''}
          </span>
        </div>

        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <div className="ed-seg-bar">
            <button
              type="button"
              className={`small ${filter === 'all' ? 'on' : ''}`}
              onClick={() => setFilter('all')}
            >
              All ({flat.length})
            </button>
            <button
              type="button"
              className={`small ${filter === 'withNotes' ? 'on' : ''}`}
              onClick={() => setFilter('withNotes')}
            >
              With Notes ({stats.notedSlides})
            </button>
            <button
              type="button"
              className={`small ${filter === 'missing' ? 'on' : ''}`}
              onClick={() => setFilter('missing')}
            >
              Missing ({flat.length - stats.notedSlides})
            </button>
          </div>
          {!readOnly && p.sections[0] && (
            <button
              type="button"
              className="small"
              onClick={() => {
                const secId = p.sections[p.sections.length - 1]!.id;
                change((q) => addSlide(q, secId, theme));
              }}
            >
              + Add Slide
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className="small ghost"
              onClick={() =>
                change((q) =>
                  addSection(q, `Point ${q.sections.length + 1}`, `P${q.sections.length + 1}`, theme),
                )
              }
            >
              + Section
            </button>
          )}
        </div>
      </div>

      {banners}

      {/* Two-Column Workspace: Manuscript Cards (Left) + Live 3-Screen Output Previews (Right) */}
      <div className="ed-ms-columns">
        <div className="ed-ms-scroll">
          {visibleRows.length === 0 ? (
            <div className="card center muted" style={{ padding: 32 }}>
              No slides match this filter.
            </div>
          ) : (
            visibleRows.map((row) => (
              <ManuscriptSlideCard
                key={row.slide.id}
                slide={row.slide}
                presentation={p}
                sectionLabel={row.sectionLabel}
                slideNumber={row.number}
                selected={row.slide.id === activeId}
                readOnly={readOnly}
                onEditCanvas={onSwitchToCanvas}
                registerTextarea={(id, el) => {
                  if (el) taMap.current.set(id, el);
                  else taMap.current.delete(id);
                }}
                onStepSlide={(delta) => stepFocus(row.slide.id, delta)}
              />
            ))
          )}
        </div>

        <aside className="ed-ms-preview-rail" aria-label="Live screen previews">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 13 }}>Screen Previews</strong>
            <button type="button" className="small ghost" onClick={onSwitchToCanvas}>
              Slide Canvas →
            </button>
          </div>
          <span className="muted small" style={{ marginTop: -6 }}>
            Live preview across Audience, Stage Split, and Stream:
          </span>
          <LookPreviews presentation={p} slideId={activeId} compact />
        </aside>
      </div>
    </div>
  );
}

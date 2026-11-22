import {
  adaptStageRegions,
  arrangedSections,
  type Box,
  importedText,
  LOOK_STAGE,
  type Look,
  parseStageNoteLine,
  type Presentation,
  type PropBox,
  readableText,
  rgbaCss,
  type Slide,
  stageNotesEnabled,
  type TextStyle,
} from '@ordo/domain';
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { useMediaLookup, useVisible } from '../../hooks.ts';
import { stillHash, useThumb } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import { change, selectSlide, useEditor } from './editorStore.ts';
import { addSection, addSlide, themeOf, updateSlide } from './ops.ts';
import { applyNoteFormatting, type NoteFormatAction } from './SpeakerNotesDock.tsx';

function slideStageText(slide: Slide): string {
  const parts: string[] = [];
  for (const o of slide.objects) {
    if (o.type === 'text' && o.text.trim()) {
      const t = readableText(o).trim();
      if (t) parts.push(t);
    }
  }
  if (parts.length > 0) return parts.join('\n');
  if (slide.scripture?.text.trim()) return slide.scripture.text.trim();
  return importedText(slide).trim();
}

function boxStyle(b: Box): CSSProperties {
  return {
    left: b.x,
    top: b.y,
    width: b.w,
    height: b.h,
  };
}

function textStyleCss(s: TextStyle): CSSProperties {
  return {
    fontFamily: `"${s.fontFamily}", Inter, system-ui, sans-serif`,
    fontWeight: s.fontWeight,
    fontStyle: s.fontStyle,
    fontSize: s.fontSizePx,
    color: rgbaCss(s.color),
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing || undefined,
    textAlign: s.align,
    textTransform: s.transform === 'uppercase' ? 'uppercase' : undefined,
  };
}

function RichStageNotes(props: { text: string; placeholder: string }) {
  const trimmed = props.text.trim();
  if (!trimmed) {
    return <div className="ed-ms-stage-placeholder">{props.placeholder}</div>;
  }
  const paragraphs = props.text.replace(/\r\n?/g, '\n').split('\n');
  let linePos = 0;
  return (
    <div className="ed-ms-stage-notes-text">
      {paragraphs.map((p) => {
        const lineKey = `p-${linePos}`;
        linePos += p.length + 1;
        if (!p.trim()) {
          return <div key={lineKey} className="ed-ms-stage-para empty" />;
        }
        const parsed = parseStageNoteLine(p);
        if (parsed.plain) {
          return (
            <div key={lineKey} className="ed-ms-stage-para" dir="auto">
              {p}
            </div>
          );
        }
        let tokPos = 0;
        return (
          <div
            key={lineKey}
            className={parsed.bullet ? 'ed-ms-stage-para note-bullet' : 'ed-ms-stage-para'}
            dir="auto"
          >
            {parsed.bullet ? <span className="ed-stage-note-dot">{'• '}</span> : null}
            {parsed.tokens.map((tok) => {
              const tokKey = `t-${tokPos}`;
              tokPos += tok.text.length + 1;
              if (tok.kind === 'highlight') {
                return (
                  <strong key={tokKey} className="ed-stage-note-hl">
                    {tok.text}
                  </strong>
                );
              }
              if (tok.kind === 'cue') {
                return (
                  <span key={tokKey} className="ed-stage-note-cue">
                    {tok.text}
                  </span>
                );
              }
              return <Fragment key={tokKey}>{tok.text}</Fragment>;
            })}
          </div>
        );
      })}
    </div>
  );
}

function ManuscriptSlideRow(props: {
  slide: Slide;
  nextSlide?: Slide;
  presentation: Presentation;
  stageLook: Look;
  sectionLabel: string;
  slideNumber: number;
  selected: boolean;
  readOnly: boolean;
  onEditCanvas: () => void;
  registerTextarea: (slideId: string, el: HTMLTextAreaElement | null) => void;
  onStepSlide: (delta: -1 | 1) => void;
}) {
  const {
    slide,
    nextSlide,
    presentation: p,
    stageLook,
    sectionLabel,
    slideNumber,
    selected,
    readOnly,
    onEditCanvas,
  } = props;
  const media = useMediaLookup();
  const [cardRef, visible] = useVisible<HTMLDivElement>();
  const stageFrameRef = useRef<HTMLDivElement | null>(null);
  const richClipRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [stageScale, setStageScale] = useState(0.32);
  const [editing, setEditing] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const bgId = slide.backgroundMediaId ?? p.backgroundMediaId;
  const thumbUrl = useThumb(
    slide,
    { isSong: p.kind === 'song', media, bg: bgId ? stillHash(media(bgId)) : undefined, width: 640 },
    visible,
  );

  const notes = slide.notes ?? '';
  const words = notes.trim() ? notes.trim().split(/\s+/).length : 0;
  const currentText = useMemo(() => slideStageText(slide), [slide]);
  const nextText = useMemo(() => (nextSlide ? slideStageText(nextSlide) : ''), [nextSlide]);
  const stageNotesOn = stageNotesEnabled(stageLook);

  // Track the 16:9 Stage Display frame width so the 1920x1080 logical canvas scales cleanly.
  useEffect(() => {
    const el = stageFrameRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setStageScale(w / 1920);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute adaptive Stage regions matching `apps/stage` and `text2d.ts`, always keeping the notes
  // region visible so empty slides can be edited directly on the Stage Display.
  const adapted = useMemo(() => {
    const fallbackRule = LOOK_STAGE.layers.slide;
    const rule = stageLook.layers.slide.mode === 'lyricOnly' ? stageLook.layers.slide : fallbackRule;
    const isSong = p.kind === 'song';
    const customNotes = stageLook.layers.props.style.notes;
    const defaultNotesBox: PropBox = customNotes ?? {
      fontFamily: rule.mode === 'lyricOnly' ? rule.style.fontFamily : 'Inter',
      fontWeight: 400,
      fontStyle: 'normal',
      fontSizePx: 32,
      color: { r: 235, g: 235, b: 235, a: 1 },
      align: 'left',
      valign: 'top',
      lineHeight: 1.2,
      letterSpacing: 0,
      padding: 8,
      transform: 'none',
      fill: { color: { r: 255, g: 255, b: 255, a: 0.1 }, radius: 10 },
      box: { x: 60, y: 972, w: 1800, h: 92, rotation: 0 },
    };
    return adaptStageRegions({
      preset: stageLook.layers.props.stagePreset,
      notesScale: stageLook.layers.props.notesScale,
      isSong,
      hasNotes: true,
      notesEnabled: true,
      hasCustomNotesStyle: Boolean(customNotes),
      current:
        rule.mode === 'lyricOnly' && !(rule.nonSong === 'none' && !isSong)
          ? { box: rule.band, style: rule.style }
          : null,
      next:
        rule.mode === 'lyricOnly' && rule.nextSlide && p.kind !== 'loop'
          ? { box: rule.nextSlide.band, style: rule.nextSlide.style }
          : null,
      notes: defaultNotesBox,
    });
  }, [stageLook, p.kind]);

  // Detect whether the rich notes overflow the 1080p Stage notes box (where live Stage clips & fades).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when notes or adapted box changes
  useLayoutEffect(() => {
    const clip = richClipRef.current;
    const inner = clip?.firstElementChild as HTMLElement | null;
    if (!clip || !inner) {
      setOverflows(false);
      return;
    }
    setOverflows(Boolean(notes.trim()) && inner.scrollHeight > clip.clientHeight + 2);
  }, [notes, adapted.notes]);

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
    if (e.key === 'Escape') {
      e.preventDefault();
      taRef.current?.blur();
      return;
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      props.onStepSlide(e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const openCardMenu = (e: React.MouseEvent) => {
    selectSlide(slide.id);
    openContextMenu(
      e,
      [
        {
          label: 'Edit slide on Canvas',
          onSelect: () => {
            selectSlide(slide.id);
            onEditCanvas();
          },
        },
        ...(notes.trim()
          ? [
              { kind: 'separator' as const },
              {
                label: 'Copy speaker notes',
                onSelect: () => void navigator.clipboard?.writeText?.(notes),
              },
              {
                label: 'Clear speaker notes',
                danger: true,
                disabled: readOnly,
                onSelect: () => setNotes(''),
              },
            ]
          : []),
      ],
      { ariaLabel: `Slide ${slideNumber} notes actions` },
    );
  };

  const placeholder =
    p.kind === 'song'
      ? 'Click to add band cues (e.g. Key: G · **Build on bridge** · [HOLD])…'
      : 'Click to add speaker notes… (**highlight**, • bullet, [PAUSE])';

  const notesRegion = adapted.notes;
  const notesFontCss = notesRegion ? textStyleCss(notesRegion) : undefined;

  return (
    <div
      ref={cardRef}
      data-manuscript-slide={slide.id}
      onClick={() => selectSlide(slide.id)}
      className={`ed-ms-card${selected ? ' sel' : ''}${slide.hidden ? ' hidden-slide' : ''}`}
    >
      {/* Left Pane: Main Display */}
      <div className="ed-ms-main-pane" onContextMenu={openCardMenu}>
        <div className="ed-ms-pane-hdr">
          <div className="row" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
            <span className="ed-ms-num-badge">#{slideNumber}</span>
            <span className="ed-ms-sec" title={sectionLabel}>
              {sectionLabel}
            </span>
            {slide.hidden && <span className="ed-ms-hidden-tag">Hidden</span>}
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

        <div className="ed-ms-thumb-box">
          {thumbUrl ? (
            <img src={thumbUrl} alt={`Slide ${slideNumber} main display`} draggable={false} />
          ) : (
            <div className="ph" />
          )}
        </div>
      </div>

      {/* Right Pane: Directly Editable Stage Display */}
      <div className="ed-ms-stage-pane">
        <div className="ed-ms-toolbar">
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 12.5 }}>Stage Display</strong>
            {words > 0 ? (
              <span className="muted small">
                {words} word{words === 1 ? '' : 's'} · ~{Math.max(5, Math.round((words / 135) * 60))}s
              </span>
            ) : (
              <span className="muted small">Empty</span>
            )}
            {overflows && (
              <span
                className="ed-ms-overflow-pill"
                title="Notes exceed the Stage Display box height and will fade out at the bottom on stage"
              >
                Overflows stage box
              </span>
            )}
            {!stageNotesOn && (
              <span
                className="ed-ms-overflow-pill"
                title="Speaker notes are currently turned off in your Stage Look settings"
              >
                Notes off in Stage Look
              </span>
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
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format('highlight')}
                title="Highlight key phrase (**bold**)"
              >
                ★ Highlight
              </button>
              <button
                type="button"
                className="small ghost"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format('bullet')}
                title="Toggle bullet list"
              >
                • Bullet
              </button>
              <button
                type="button"
                className="small ghost"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format('pause')}
                title="Insert [PAUSE] cue"
              >
                + [PAUSE]
              </button>
              <button
                type="button"
                className="small ghost"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format('cue')}
                title="Insert [CUE: ...] badge"
              >
                + [CUE]
              </button>
            </div>
          )}
        </div>

        <div
          ref={stageFrameRef}
          className={`ed-ms-stage-frame${editing ? ' editing' : ''}`}
          style={{ background: rgbaCss(stageLook.clearColor) }}
        >
          <div
            className="ed-ms-stage-canvas"
            style={{
              transform: `scale(${stageScale})`,
              background: rgbaCss(stageLook.clearColor),
            }}
          >
            {adapted.current && (
              <div
                className="ed-ms-stage-region ed-ms-stage-current"
                style={{
                  ...boxStyle(adapted.current.box),
                  ...textStyleCss(adapted.current.style),
                  padding: adapted.current.style.padding,
                  background: adapted.current.style.fill
                    ? rgbaCss(adapted.current.style.fill.color)
                    : undefined,
                  borderRadius: adapted.current.style.fill?.radius,
                  justifyContent:
                    adapted.current.style.valign === 'middle'
                      ? 'center'
                      : adapted.current.style.valign === 'bottom'
                        ? 'flex-end'
                        : 'flex-start',
                }}
              >
                <div className="ed-ms-stage-slide-text" dir="auto">
                  {currentText || <span className="ed-ms-stage-empty-slide">(Visual slide)</span>}
                </div>
              </div>
            )}

            {adapted.next && nextText && (
              <div
                className="ed-ms-stage-region ed-ms-stage-next"
                style={{
                  ...boxStyle(adapted.next.box),
                  ...textStyleCss(adapted.next.style),
                  padding: adapted.next.style.padding,
                  background: adapted.next.style.fill ? rgbaCss(adapted.next.style.fill.color) : undefined,
                  borderRadius: adapted.next.style.fill?.radius,
                  justifyContent:
                    adapted.next.style.valign === 'middle'
                      ? 'center'
                      : adapted.next.style.valign === 'bottom'
                        ? 'flex-end'
                        : 'flex-start',
                }}
              >
                <div className="ed-ms-stage-slide-text" dir="auto">
                  {nextText}
                </div>
              </div>
            )}

            {notesRegion && (
              <div
                className={`ed-ms-stage-region ed-ms-stage-notes${editing ? ' editing' : ''}${
                  !notes.trim() ? ' is-empty' : ''
                }`}
                style={{
                  ...boxStyle(notesRegion.box),
                  background: notesRegion.fill ? rgbaCss(notesRegion.fill.color) : undefined,
                  borderRadius: notesRegion.fill?.radius,
                }}
              >
                <div
                  ref={richClipRef}
                  className="ed-ms-stage-notes-rich"
                  data-cut={overflows ? '1' : undefined}
                  style={{
                    ...notesFontCss,
                    padding: notesRegion.padding,
                  }}
                >
                  <RichStageNotes text={notes} placeholder={placeholder} />
                </div>

                <textarea
                  ref={(el) => {
                    taRef.current = el;
                    props.registerTextarea(slide.id, el);
                  }}
                  aria-label={`Slide ${slideNumber} speaker notes`}
                  className="ed-ms-stage-notes-input"
                  style={{
                    ...notesFontCss,
                    padding: notesRegion.padding,
                  }}
                  value={notes}
                  disabled={readOnly}
                  onFocus={() => {
                    setEditing(true);
                    selectSlide(slide.id);
                  }}
                  onBlur={() => setEditing(false)}
                  onKeyDown={onKeyDown}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={placeholder}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Continuous 2-Pane Presenter Notes Studio (`DeckNotesEditor`):
 * Each slide row pairs the Main Display (left) with a directly editable, 1:1 scaled Stage Display (right)
 * matching the live Stage monitor layout, rich note emphasis, and overflow behavior.
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
  const looks = useLibrary((s) => s.data.settings.looks);
  const theme = themeOf(p, themes);
  const stageLook = useMemo(() => looks.find((l) => l.kind === 'stage') ?? LOOK_STAGE, [looks]);
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

  // Match `slideAndNext` arrangement order for each slide's "Next" preview card on Stage.
  const nextBySlideId = useMemo(() => {
    const ordered = arrangedSections(p).flatMap((s) => s.slides);
    const map = new Map<string, Slide | undefined>();
    for (let i = 0; i < ordered.length; i++) {
      const id = ordered[i]!.id;
      if (!map.has(id)) {
        map.set(
          id,
          ordered.slice(i + 1).find((s) => !s.hidden),
        );
      }
    }
    return map;
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

      {/* Full-Width Scrollable 2-Pane Rows: Main Display (Left) + Editable Stage Display (Right) */}
      <div className="ed-ms-scroll">
        {visibleRows.length === 0 ? (
          <div className="card center muted" style={{ padding: 32 }}>
            No slides match this filter.
          </div>
        ) : (
          visibleRows.map((row) => (
            <ManuscriptSlideRow
              key={row.slide.id}
              slide={row.slide}
              nextSlide={nextBySlideId.get(row.slide.id)}
              presentation={p}
              stageLook={stageLook}
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
    </div>
  );
}

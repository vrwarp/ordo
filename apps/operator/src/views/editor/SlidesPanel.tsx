import { parseSectionLabel, type Presentation } from '@ordo/domain';
import { type PointerEvent as ReactPointerEvent, useEffect, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { DragHandle } from '../../components/Sortable.tsx';
import { useSortable } from '../../components/Sortable.tsx';
import { type FlatEntry, flatSlideMove } from '../../components/sortableMath.ts';
import { useMediaLookup, useVisible } from '../../hooks.ts';
import { stillHash, useThumb } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import { addSlideLike, setSlideHidden } from './actions.ts';
import { change, selectSlide, useEditor } from './editorStore.ts';
import {
  addSection,
  addSlide,
  deleteSection,
  deleteSlide,
  duplicateSlide,
  mergeWithNext,
  moveSection,
  moveSlide,
  renameSection,
  splitSlide,
  themeOf,
} from './ops.ts';
import type { Slide } from '@ordo/domain';

/** How a hidden slide's number and picture are dimmed in the slide list (design/27 §11 item 9). */
export const HIDDEN_DIM = { opacity: 0.4 } as const;

function SlideItem(props: {
  slide: Slide;
  p: Presentation;
  index: number;
  selected: boolean;
  readOnly: boolean;
  sort: {
    item: Record<string, unknown>;
    handle: Record<string, unknown>;
    mouseArea: { onPointerDown: (e: ReactPointerEvent) => void };
    cls: string;
  };
}) {
  const media = useMediaLookup();
  const [ref, visible] = useVisible<HTMLDivElement>();
  const bgId = props.slide.backgroundMediaId ?? props.p.backgroundMediaId;
  const url = useThumb(
    props.slide,
    { isSong: props.p.kind === 'song', media, bg: bgId ? stillHash(media(bgId)) : undefined, width: 320 },
    visible,
  );
  // A hidden slide is dimmed (its number and picture; the tag stays readable), as in the live slide grid.
  const hidden = !!props.slide.hidden;
  const dim = hidden ? HIDDEN_DIM : undefined;

  useEffect(() => {
    if (props.selected && ref.current?.scrollIntoView) {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [props.selected, ref]);
  return (
    <div
      ref={ref}
      {...props.sort.item}
      {...props.sort.mouseArea}
      data-slide-id={props.slide.id}
      className={`ed-slide ${props.selected ? 'sel' : ''} ${hidden ? 'hidden-slide' : ''} ${props.sort.cls}`}
      onClick={() => selectSlide(props.slide.id)}
    >
      <DragHandle label="Drag to reorder" disabled={props.readOnly} {...props.sort.handle} />
      <span className="muted small" style={{ width: 16, ...dim }}>
        {props.index + 1}
      </span>
      {url ? <img src={url} alt="" draggable={false} style={dim} /> : <div className="ph" style={dim} />}
      {props.slide.overrides?.length ? (
        <span className="override-mark" title="Overrides the theme">
          ●<span className="touch-label">Overrides theme</span>
        </span>
      ) : null}
      {props.slide.hidden ? (
        <span
          className="tag"
          title="Hidden: Next skips it during the service; a click in the slide grid shows it"
          data-hidden-slide
        >
          Hidden
        </span>
      ) : null}
    </div>
  );
}

/**
 * Sections and slides: add, rename, reorder (drag by the grip, mouse or touch, or the move buttons),
 * delete sections; add, duplicate, split, merge slides. Slides drag across sections: the slide list is one
 * flat sortable of section headers and slides (components/sortableMath.ts flatSlideMove).
 */
export function SlidesPanel({
  p,
  readOnly,
  onSwitchToReflow,
}: {
  p: Presentation;
  readOnly: boolean;
  onSwitchToReflow?: () => void;
}) {
  const slideId = useEditor((s) => s.slideId);
  const themes = useLibrary((s) => s.data.themes);
  const theme = themeOf(p, themes);
  const [newSection, setNewSection] = useState('');
  const edit = (fn: (q: Presentation) => Presentation) => !readOnly && change(fn);
  const addNamedSection = () => {
    const t = newSection.trim();
    if (!t) return;
    const parsed = parseSectionLabel(t);
    edit((q) => addSection(q, parsed?.label ?? t, parsed?.short ?? t.slice(0, 3).toUpperCase(), theme));
    setNewSection('');
  };
  const flat: FlatEntry[] = [];
  const flatIndex = new Map<string, number>();
  for (const sec of p.sections) {
    flatIndex.set(sec.id, flat.length);
    flat.push({ kind: 'section', id: sec.id });
    for (const sl of sec.slides) {
      flatIndex.set(sl.id, flat.length);
      flat.push({ kind: 'slide', id: sl.id });
    }
  }
  const moveFlat = (from: number, to: number) => {
    const m = flatSlideMove(flat, from, to);
    if (m) edit((q) => moveSlide(q, m.slideId, m.sectionId, m.index));
  };
  const slides = useSortable({ group: 'slides', axis: 'y', disabled: readOnly, onMove: moveFlat });
  const sections = useSortable({
    group: 'sections',
    axis: 'y',
    disabled: readOnly,
    onMove: (from, to) => edit((q) => moveSection(q, from, to)),
  });
  const selected = slideId
    ? p.sections.flatMap((sec) => sec.slides).find((x) => x.id === slideId)
    : undefined;
  const selFlat = slideId !== undefined ? flatIndex.get(slideId) : undefined;
  const selSection = slideId ? p.sections.findIndex((s) => s.slides.some((x) => x.id === slideId)) : -1;
  const slideUp = selFlat !== undefined ? flatSlideMove(flat, selFlat, selFlat - 1) : null;
  const slideDown = selFlat !== undefined ? flatSlideMove(flat, selFlat, selFlat + 1) : null;
  return (
    <div
      className="col ed-slides"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        borderRight: '1px solid var(--line)',
        background: 'var(--bg)',
        overflow: 'hidden',
      }}
    >
      {onSwitchToReflow && (
        <div style={{ padding: '8px 8px 4px' }}>
          <button
            type="button"
            className="small"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={onSwitchToReflow}
            title="Switch back to full-song lyric script view"
          >
            ← Lyric Script View
          </button>
        </div>
      )}
      <div
        ref={(el) => {
          slides.ref(el);
          sections.ref(el);
        }}
        className="col ed-slides-list"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: 8,
        }}
      >
        {p.sections.map((sec, si) => (
          <div
            key={sec.id}
            {...sections.item(si)}
            data-section-id={sec.id}
            className={`col ${sections.cls(si)}`}
            style={{ gap: 2 }}
          >
            <div
              {...slides.item(flatIndex.get(sec.id)!)}
              {...sections.mouseArea(si)}
              className="row ed-sec-head"
              style={{ cursor: readOnly ? undefined : 'grab' }}
            >
              <DragHandle label="Drag the section" disabled={readOnly} {...sections.handle(si)} />
              <span className="tag">{sec.short}</span>
              <input
                value={sec.label}
                disabled={readOnly}
                className="grow"
                style={{ minHeight: 28, padding: '2px 6px' }}
                onChange={(e) =>
                  edit((q) =>
                    renameSection(
                      q,
                      sec.id,
                      e.target.value,
                      parseSectionLabel(e.target.value)?.short ?? sec.short,
                    ),
                  )
                }
              />
              {!readOnly && (
                <div className="row" style={{ gap: 2, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="ghost small sec-delete-btn"
                    title="Move section up"
                    aria-label="Move section up"
                    disabled={si === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      edit((q) => moveSection(q, si, si - 1));
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="ghost small sec-delete-btn"
                    title="Move section down"
                    aria-label="Move section down"
                    disabled={si >= p.sections.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      edit((q) => moveSection(q, si, si + 1));
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="ghost small sec-delete-btn"
                    title="Delete section"
                    aria-label="Delete section"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (
                        await confirmDialog(
                          'Delete section',
                          `Delete “${sec.label}” and its ${sec.slides.length} slides? It is removed from every arrangement.`,
                          'Delete',
                          true,
                        )
                      )
                        edit((q) => deleteSection(q, sec.id));
                    }}
                  >
                    🗑
                  </button>
                </div>
              )}
            </div>
            {sec.slides.map((sl, i) => {
              const fi = flatIndex.get(sl.id)!;
              return (
                <SlideItem
                  key={sl.id}
                  slide={sl}
                  p={p}
                  index={i}
                  selected={sl.id === slideId}
                  readOnly={readOnly}
                  sort={{
                    item: slides.item(fi),
                    handle: slides.handle(fi),
                    mouseArea: slides.mouseArea(fi),
                    cls: slides.cls(fi),
                  }}
                />
              );
            })}
            {!readOnly && (
              <button
                type="button"
                className="small ghost"
                onClick={() => edit((q) => addSlide(q, sec.id, theme))}
              >
                + slide
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <div className="row" style={{ marginTop: 8, gap: 4 }}>
            <input
              className="grow"
              style={{ minWidth: 0 }}
              placeholder={
                p.kind === 'song'
                  ? 'New section (Verse 2, C, Bridge…)'
                  : p.kind === 'loop'
                    ? 'New section (Events, Giving, Youth…)'
                    : 'New section (Intro, Scripture, Points…)'
              }
              value={newSection}
              onChange={(e) => setNewSection(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addNamedSection()}
            />
            <button type="button" className="small" onClick={addNamedSection}>
              Add
            </button>
          </div>
        )}
      </div>

      {!readOnly && slideId && (
        <div
          className="col ed-sel-slide-dock ed-sel-slide-card"
          style={{
            flexShrink: 0,
            padding: '10px 10px 12px',
            borderTop: '1px solid var(--line)',
            background: 'var(--bg2)',
            gap: 8,
            boxSizing: 'border-box',
            maxWidth: '100%',
          }}
        >
          {/* Header: Slide index + Section tag + Compact reorder steppers + Delete */}
          <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <div className="row" style={{ alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                className="bold"
                style={{
                  fontSize: 12,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'var(--fg)',
                  whiteSpace: 'nowrap',
                }}
              >
                Slide {(selFlat ?? 0) + 1}
              </span>
              {selSection >= 0 && p.sections[selSection] && (
                <span
                  className="tag"
                  style={{
                    fontSize: 11,
                    maxWidth: 85,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={p.sections[selSection].label}
                >
                  {p.sections[selSection].short}
                </span>
              )}
            </div>
            <div className="row" style={{ alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <button
                type="button"
                className="ghost small"
                disabled={!slideUp}
                aria-label="Slide up"
                title="Move slide up"
                style={{ padding: '0 6px', minHeight: 24, minWidth: 24 }}
                onClick={() =>
                  slideUp && edit((q) => moveSlide(q, slideUp.slideId, slideUp.sectionId, slideUp.index))
                }
              >
                ↑
              </button>
              <button
                type="button"
                className="ghost small"
                disabled={!slideDown}
                aria-label="Slide down"
                title="Move slide down"
                style={{ padding: '0 6px', minHeight: 24, minWidth: 24 }}
                onClick={() =>
                  slideDown &&
                  edit((q) => moveSlide(q, slideDown.slideId, slideDown.sectionId, slideDown.index))
                }
              >
                ↓
              </button>
              <button
                type="button"
                className="ghost small danger"
                title="Delete slide"
                aria-label="Delete slide"
                style={{ padding: '0 6px', minHeight: 24, minWidth: 24, color: 'var(--red)' }}
                onClick={() => {
                  edit((q) => deleteSlide(q, slideId));
                  selectSlide(undefined);
                }}
              >
                🗑<span className="touch-label">Delete</span>
              </button>
            </div>
          </div>

          {/* Primary actions: Duplicate and New slide like this */}
          <div className="col" style={{ gap: 6 }}>
            <button
              type="button"
              className="small"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => edit((q) => duplicateSlide(q, slideId))}
              title="Duplicate this slide"
            >
              Duplicate
            </button>
            <button
              type="button"
              className="small"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => addSlideLike(slideId)}
              title="A copy with its text cleared, to type a new verse or notice in the same look"
              data-new-slide-like
            >
              New slide like this
            </button>
          </div>

          {/* Visibility toggle */}
          <HideSlideToggle hidden={!!selected?.hidden} onToggle={(h) => setSlideHidden(slideId, h)} />

          {/* Lyric flow actions (Songs only) */}
          {p.kind === 'song' && (
            <div className="col" style={{ gap: 4, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
              <span
                className="muted small bold"
                style={{ fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}
              >
                Lyric flow
              </span>
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="small grow"
                  style={{ justifyContent: 'center' }}
                  onClick={() => edit((q) => splitSlide(q, slideId))}
                  title="Split the lyric text into two slides"
                >
                  ✂ Split
                </button>
                <button
                  type="button"
                  className="small grow"
                  style={{ justifyContent: 'center' }}
                  onClick={() => edit((q) => mergeWithNext(q, slideId))}
                  title="Merge with the next slide"
                >
                  ⤹ Merge next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 'Hidden' for the selected slide (design/27 §11 item 9), a toggle button (`aria-pressed`): Next, Prev and
 * auto-advance skip a hidden slide during the service, a click in the slide grid still shows it.
 */
export function HideSlideToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: (hidden: boolean) => void;
}) {
  return (
    <div className="row" style={{ alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        className={`small ${hidden ? 'on' : ''}`}
        aria-pressed={hidden}
        onClick={() => onToggle(!hidden)}
        data-hide-slide
      >
        Hidden
      </button>
      <span className="muted small grow" style={{ lineHeight: 1.2 }}>
        {hidden ? 'Next skips this slide; a click in the slide grid shows it.' : 'Shown in the service.'}
      </span>
    </div>
  );
}

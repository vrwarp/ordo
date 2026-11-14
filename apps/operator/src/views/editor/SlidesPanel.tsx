import { parseSectionLabel, type Presentation, type Slide } from '@ordo/domain';
import { type PointerEvent as ReactPointerEvent, useEffect, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { Menu } from '../../components/Menu.tsx';
import { DragHandle, useSortable } from '../../components/Sortable.tsx';
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

/** How a hidden slide's number and picture are dimmed in the slide list (design/27 §11 item 9). */
export const HIDDEN_DIM = { opacity: 0.4 } as const;

function SlideItem(props: {
  slide: Slide;
  p: Presentation;
  index: number;
  selected: boolean;
  readOnly: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDuplicate: () => void;
  onNewLike: () => void;
  onToggleHidden: (hidden: boolean) => void;
  onSplit?: () => void;
  onMerge?: () => void;
  onDelete: () => void;
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
  const hidden = !!props.slide.hidden;
  const dim = hidden ? HIDDEN_DIM : undefined;
  const hasAudio = !!props.slide.audio;
  const hasMidi = (props.slide.midiCues?.length ?? 0) > 0;
  const loopSec =
    props.p.kind === 'loop' && props.slide.durationMs
      ? Math.round(props.slide.durationMs / 100) / 10
      : undefined;

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
      className={`ed-slide-card ${props.selected ? 'sel' : ''} ${hidden ? 'hidden-slide' : ''} ${props.sort.cls}`}
      onClick={() => selectSlide(props.slide.id)}
    >
      <div className={`ed-slide ${props.selected ? 'sel' : ''} ${hidden ? 'hidden-slide' : ''}`}>
        <DragHandle label="Drag to reorder" disabled={props.readOnly} {...props.sort.handle} />
        <span className="muted small" style={{ width: 16, ...dim }}>
          {props.index + 1}
        </span>
        <div className="ed-slide-thumb-wrap">
          {url ? <img src={url} alt="" draggable={false} style={dim} /> : <div className="ph" style={dim} />}
          {(hasAudio || hasMidi || loopSec !== undefined) && (
            <div className="ed-slide-cue-badges">
              {hasAudio && (
                <span className="ed-cue-badge" title="Slide has audio cue">
                  ♪
                </span>
              )}
              {hasMidi && (
                <span className="ed-cue-badge midi" title="Slide sends MIDI cue">
                  ⚡
                </span>
              )}
              {loopSec !== undefined && (
                <span className="ed-cue-badge" title={`Auto-advance after ${loopSec}s`}>
                  {loopSec}s
                </span>
              )}
            </div>
          )}
        </div>
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

      {/* Inline contextual actions directly on the selected slide card (replaces the stranded bottom footer) */}
      {props.selected && !props.readOnly && (
        <div
          className="ed-slide-inline-actions"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="small ghost"
            onClick={props.onDuplicate}
            title="Duplicate this slide"
          >
            Duplicate
          </button>
          <button
            type="button"
            className="small ghost"
            aria-label="New slide like this"
            title="A copy with its text cleared, to type a new verse or notice in the same look"
            data-new-slide-like
            onClick={props.onNewLike}
          >
            + Like
          </button>
          <HideSlideToggle hidden={hidden} onToggle={props.onToggleHidden} compact />
          <Menu
            label="⋯"
            align="right"
            items={[
              ...(props.onMoveUp
                ? [{ label: '↑ Move slide up', name: 'Slide up', onSelect: props.onMoveUp }]
                : []),
              ...(props.onMoveDown
                ? [{ label: '↓ Move slide down', name: 'Slide down', onSelect: props.onMoveDown }]
                : []),
              ...(props.onSplit ? [{ label: '✂ Split lyrics', name: 'Split', onSelect: props.onSplit }] : []),
              ...(props.onMerge
                ? [{ label: '⤹ Merge with next', name: 'Merge next', onSelect: props.onMerge }]
                : []),
              { label: '🗑 Delete slide', name: 'Delete slide', danger: true, onSelect: props.onDelete },
            ]}
          />
        </div>
      )}
    </div>
  );
}

const SECTION_PRESETS: Record<Presentation['kind'], readonly string[]> = {
  song: ['Verse 1', 'Chorus', 'Verse 2', 'Bridge', 'Tag'],
  loop: ['Welcome', 'Events', 'Giving', 'Next Steps'],
  slides: ['Intro', 'Scripture', 'Point 1', 'Conclusion'],
};

/**
 * Sections and slides: add, rename, reorder, and act inline directly on the selected slide card.
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
  const [addingSection, setAddingSection] = useState(false);
  const [newSection, setNewSection] = useState('');
  const edit = (fn: (q: Presentation) => Presentation) => !readOnly && change(fn);

  const commitSection = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    const parsed = parseSectionLabel(t);
    edit((q) => addSection(q, parsed?.label ?? t, parsed?.short ?? t.slice(0, 3).toUpperCase(), theme));
    setNewSection('');
    setAddingSection(false);
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
            style={{ gap: 4 }}
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
                style={{ minHeight: 26, padding: '2px 6px' }}
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
              const upMove = flatSlideMove(flat, fi, fi - 1);
              const downMove = flatSlideMove(flat, fi, fi + 1);
              return (
                <SlideItem
                  key={sl.id}
                  slide={sl}
                  p={p}
                  index={i}
                  selected={sl.id === slideId}
                  readOnly={readOnly}
                  onMoveUp={
                    upMove
                      ? () => edit((q) => moveSlide(q, upMove.slideId, upMove.sectionId, upMove.index))
                      : undefined
                  }
                  onMoveDown={
                    downMove
                      ? () => edit((q) => moveSlide(q, downMove.slideId, downMove.sectionId, downMove.index))
                      : undefined
                  }
                  onDuplicate={() => edit((q) => duplicateSlide(q, sl.id))}
                  onNewLike={() => addSlideLike(sl.id)}
                  onToggleHidden={(h) => setSlideHidden(sl.id, h)}
                  onSplit={p.kind === 'song' ? () => edit((q) => splitSlide(q, sl.id)) : undefined}
                  onMerge={p.kind === 'song' ? () => edit((q) => mergeWithNext(q, sl.id)) : undefined}
                  onDelete={() => {
                    edit((q) => deleteSlide(q, sl.id));
                    selectSlide(undefined);
                  }}
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

        {/* Clean On-Demand Section Creator with Worship/Sermon Presets */}
        {!readOnly && (
          <div className="col" style={{ marginTop: 6, gap: 6 }}>
            {addingSection ? (
              <div className="ed-add-sec-popover col" style={{ gap: 6 }}>
                <div className="row wrap" style={{ gap: 4 }}>
                  {SECTION_PRESETS[p.kind].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className="small ghost"
                      style={{ minHeight: 24, padding: '2px 7px', fontSize: 11 }}
                      onClick={() => commitSection(preset)}
                    >
                      + {preset}
                    </button>
                  ))}
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <input
                    autoFocus
                    style={{ flex: 1, minWidth: 0 }}
                    placeholder="Custom section name…"
                    value={newSection}
                    onChange={(e) => setNewSection(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitSection(newSection);
                      else if (e.key === 'Escape') setAddingSection(false);
                    }}
                  />
                  <button
                    type="button"
                    className="small primary"
                    disabled={!newSection.trim()}
                    onClick={() => commitSection(newSection)}
                  >
                    Add
                  </button>
                  <button type="button" className="small ghost" onClick={() => setAddingSection(false)}>
                    ✕
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="small ghost"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => setAddingSection(true)}
              >
                + Add section
              </button>
            )}
          </div>
        )}
      </div>
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
  compact = false,
}: {
  hidden: boolean;
  onToggle: (hidden: boolean) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`small ed-vis-pill ${hidden ? 'is-hidden' : 'is-visible'}`}
      aria-pressed={hidden}
      aria-label={hidden ? 'Hidden in service' : 'Visible in service'}
      onClick={() => onToggle(!hidden)}
      title={hidden ? 'Next skips this slide; a click in the slide grid shows it.' : 'Shown in the service.'}
      data-hide-slide
    >
      {compact ? (hidden ? 'Hidden' : 'Visible') : hidden ? 'Hidden in service' : 'Visible in service'}
    </button>
  );
}

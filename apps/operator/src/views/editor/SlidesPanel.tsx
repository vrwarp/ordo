import { parseSectionLabel, type Presentation } from '@ordo/domain';
import { type PointerEvent as ReactPointerEvent, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { DragHandle } from '../../components/Sortable.tsx';
import { useSortable } from '../../components/Sortable.tsx';
import { type FlatEntry, flatSlideMove } from '../../components/sortableMath.ts';
import { useMediaLookup, useVisible } from '../../hooks.ts';
import { stillHash, useThumb } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
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
  return (
    <div
      ref={ref}
      {...props.sort.item}
      {...props.sort.mouseArea}
      data-slide-id={props.slide.id}
      className={`ed-slide ${props.selected ? 'sel' : ''} ${props.sort.cls}`}
      onClick={() => selectSlide(props.slide.id)}
    >
      <DragHandle label="Drag to reorder" disabled={props.readOnly} {...props.sort.handle} />
      <span className="muted small" style={{ width: 16 }}>
        {props.index + 1}
      </span>
      {url ? <img src={url} alt="" draggable={false} /> : <div className="ph" />}
      {props.slide.overrides?.length ? (
        <span className="override-mark" title="Overrides the theme">
          ●<span className="touch-label">Overrides theme</span>
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
export function SlidesPanel({ p, readOnly }: { p: Presentation; readOnly: boolean }) {
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
  const selFlat = slideId !== undefined ? flatIndex.get(slideId) : undefined;
  const selSection = slideId ? p.sections.findIndex((s) => s.slides.some((x) => x.id === slideId)) : -1;
  const slideUp = selFlat !== undefined ? flatSlideMove(flat, selFlat, selFlat - 1) : null;
  const slideDown = selFlat !== undefined ? flatSlideMove(flat, selFlat, selFlat + 1) : null;
  return (
    <div
      ref={(el) => {
        slides.ref(el);
        sections.ref(el);
      }}
      className="col ed-slides"
      style={{ gap: 6, padding: 8, overflow: 'auto', borderRight: '1px solid var(--line)', minHeight: 0 }}
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
              <button
                type="button"
                className="ghost small"
                title="Delete section"
                aria-label="Delete section"
                onClick={async () => {
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
                ✕
              </button>
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
        <div className="row" style={{ marginTop: 8 }}>
          <input
            className="grow"
            placeholder="New section (Verse 2, C, Bridge…)"
            value={newSection}
            onChange={(e) => setNewSection(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNamedSection()}
          />
          <button type="button" className="small" onClick={addNamedSection}>
            Add
          </button>
        </div>
      )}
      {!readOnly && slideId && (
        <div className="col" style={{ marginTop: 10, gap: 4 }}>
          <h4>Selected slide</h4>
          <div className="row wrap" style={{ gap: 4 }}>
            <button type="button" className="small" onClick={() => edit((q) => duplicateSlide(q, slideId))}>
              Duplicate
            </button>
            <button
              type="button"
              className="small"
              onClick={() => edit((q) => splitSlide(q, slideId))}
              title="Split the lyric text into two slides"
            >
              Split
            </button>
            <button
              type="button"
              className="small"
              onClick={() => edit((q) => mergeWithNext(q, slideId))}
              title="Merge with the next slide"
            >
              Merge next
            </button>
            <button
              type="button"
              className="small danger"
              onClick={() => {
                edit((q) => deleteSlide(q, slideId));
                selectSlide(undefined);
              }}
            >
              Delete
            </button>
          </div>
          <div className="row wrap" style={{ gap: 4 }}>
            <button
              type="button"
              className="small"
              disabled={!slideUp}
              onClick={() =>
                slideUp && edit((q) => moveSlide(q, slideUp.slideId, slideUp.sectionId, slideUp.index))
              }
            >
              ↑ Slide up
            </button>
            <button
              type="button"
              className="small"
              disabled={!slideDown}
              onClick={() =>
                slideDown &&
                edit((q) => moveSlide(q, slideDown.slideId, slideDown.sectionId, slideDown.index))
              }
            >
              ↓ Slide down
            </button>
          </div>
          <div className="row wrap" style={{ gap: 4 }}>
            <button
              type="button"
              className="small"
              disabled={selSection <= 0}
              onClick={() => edit((q) => moveSection(q, selSection, selSection - 1))}
            >
              ↑ Section up
            </button>
            <button
              type="button"
              className="small"
              disabled={selSection < 0 || selSection >= p.sections.length - 1}
              onClick={() => edit((q) => moveSection(q, selSection, selSection + 1))}
            >
              ↓ Section down
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

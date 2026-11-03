import { parseSectionLabel, type Presentation } from '@ordo/domain';
import { useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
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
  onDragStart: () => void;
  onDrop: () => void;
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
      className={`ed-slide ${props.selected ? 'sel' : ''}`}
      draggable
      onDragStart={props.onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.stopPropagation();
        props.onDrop();
      }}
      onClick={() => selectSlide(props.slide.id)}
    >
      <span className="muted small" style={{ width: 16 }}>
        {props.index + 1}
      </span>
      {url ? <img src={url} alt="" /> : <div className="ph" />}
      {props.slide.overrides?.length ? (
        <span className="override-mark" title="Overrides the theme">
          ●
        </span>
      ) : null}
    </div>
  );
}

/** Sections and slides: add, rename, reorder (drag), delete sections; add, duplicate, split, merge slides. */
export function SlidesPanel({ p, readOnly }: { p: Presentation; readOnly: boolean }) {
  const slideId = useEditor((s) => s.slideId);
  const themes = useLibrary((s) => s.data.themes);
  const theme = themeOf(p, themes);
  const [drag, setDrag] = useState<{ slideId?: string; section?: number } | null>(null);
  const [newSection, setNewSection] = useState('');
  const edit = (fn: (q: Presentation) => Presentation) => !readOnly && change(fn);
  const addNamedSection = () => {
    const t = newSection.trim();
    if (!t) return;
    const parsed = parseSectionLabel(t);
    edit((q) => addSection(q, parsed?.label ?? t, parsed?.short ?? t.slice(0, 3).toUpperCase(), theme));
    setNewSection('');
  };
  return (
    <div
      className="col"
      style={{ gap: 6, padding: 8, overflow: 'auto', borderRight: '1px solid var(--line)', minHeight: 0 }}
    >
      {p.sections.map((sec, si) => (
        <div
          key={sec.id}
          className="col"
          style={{ gap: 2 }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (drag?.slideId) edit((q) => moveSlide(q, drag.slideId!, sec.id, sec.slides.length));
            else if (drag?.section !== undefined) edit((q) => moveSection(q, drag.section!, si));
            setDrag(null);
          }}
        >
          <div
            className="row"
            draggable={!readOnly}
            onDragStart={() => setDrag({ section: si })}
            style={{ cursor: readOnly ? undefined : 'grab' }}
          >
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
          {sec.slides.map((sl, i) => (
            <SlideItem
              key={sl.id}
              slide={sl}
              p={p}
              index={i}
              selected={sl.id === slideId}
              onDragStart={() => setDrag({ slideId: sl.id })}
              onDrop={() => {
                if (drag?.slideId && drag.slideId !== sl.id)
                  edit((q) => moveSlide(q, drag.slideId!, sec.id, i));
                setDrag(null);
              }}
            />
          ))}
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
        </div>
      )}
    </div>
  );
}

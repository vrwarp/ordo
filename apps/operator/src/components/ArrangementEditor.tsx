import {
  type Arrangement,
  DEFAULT_THEME,
  lyricSlide,
  newId,
  type Presentation,
  type Section,
  type TextObject,
} from '@ordo/domain';
import { useState } from 'react';
import { DragHandle, useSortable } from './Sortable.tsx';
import { arrangementLabel, insertSection, moveAt, parseArrangement, removeAt } from '../lib/arrangement.ts';

function getSectionLyrics(s: Section): string {
  const parts: string[] = [];
  for (const sl of s.slides ?? []) {
    for (const obj of sl.objects ?? []) {
      if (obj.type === 'text' && obj.text?.trim()) {
        parts.push(obj.text.trim());
      }
    }
  }
  return parts.join('\n');
}

/**
 * Edit one arrangement: vertical stack of draggable section cards with lyric previews,
 * sequence text box at the top, and option to add custom verses/lyrics.
 */
export function ArrangementEditor(props: {
  presentation: Pick<Presentation, 'sections'> & { id?: string };
  value: Arrangement;
  onChange: (a: Arrangement) => void;
  onAddSection?: (sec: Section) => void;
  disabled?: boolean;
}) {
  const { presentation: p, value: a } = props;
  const [picked, setPicked] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customLabel, setCustomLabel] = useState('');
  const [customShort, setCustomShort] = useState('');
  const [customLyrics, setCustomLyrics] = useState('');

  const byId = new Map(p.sections.map((s) => [s.id, s]));
  const typed = text !== null ? parseArrangement(text, p) : null;
  const sel = picked !== null && picked < a.sectionIds.length ? picked : null;

  const move = (from: number, to: number) => {
    props.onChange(moveAt(a, from, to));
    if (sel === from) setPicked(to);
  };
  const sort = useSortable({ group: 'arrangement', axis: 'y', disabled: props.disabled, onMove: move });

  const handleCreateCustom = () => {
    const trimmed = customLyrics.trim();
    if (!trimmed) return;
    const label = customLabel.trim() || 'Custom Verse';
    const short = customShort.trim() || label.slice(0, 2).toUpperCase();

    // Check if any existing slide has style/box to mirror
    const sampleTextObj = p.sections
      .flatMap((sec) => sec.slides)
      .flatMap((sl) => sl.objects)
      .find((obj): obj is TextObject => obj.type === 'text');

    const theme = sampleTextObj ? { lyricBox: sampleTextObj.box, text: sampleTextObj.style } : DEFAULT_THEME;

    const stanzas = trimmed
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const slides = (stanzas.length > 0 ? stanzas : [trimmed]).map((st) => lyricSlide(st, theme));

    const newSec: Section = {
      id: newId(),
      label,
      short,
      slides,
    };

    if (props.onAddSection) {
      props.onAddSection(newSec);
    }
    props.onChange(insertSection(a, newSec.id));
    setCustomLabel('');
    setCustomShort('');
    setCustomLyrics('');
    setShowCustom(false);
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      {/* 1. Sequence typing input at the top */}
      {!props.disabled && (
        <div className="col" style={{ gap: 4 }}>
          <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="small muted bold" style={{ fontSize: 11, letterSpacing: '0.04em' }}>
              ARRANGEMENT SEQUENCE
            </span>
            {typed && typed.unknown.length > 0 && (
              <span className="small" style={{ color: 'var(--amber)' }}>
                Unknown: {typed.unknown.join(', ')}
              </span>
            )}
          </div>
          <input
            className="grow"
            placeholder="Type an order, e.g. V1 C V2 C B C C"
            value={text ?? arrangementLabel(a, p)}
            onFocus={() => setText(arrangementLabel(a, p))}
            onChange={(e) => {
              const val = e.target.value;
              setText(val);
              const parsed = parseArrangement(val, p);
              if (parsed && !parsed.unknown.length) {
                props.onChange({ ...a, sectionIds: parsed.sectionIds });
              }
            }}
            onBlur={() => setText(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (typed && !typed.unknown.length) {
                  props.onChange({ ...a, sectionIds: typed.sectionIds });
                }
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
      )}

      {/* 2. Add section buttons and + Custom verse */}
      {!props.disabled && (
        <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
          <span className="muted small">Add:</span>
          {p.sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className="small"
              onClick={() => props.onChange(insertSection(a, s.id))}
              title={`Add ${s.label}`}
            >
              + {s.short || s.label}
            </button>
          ))}
          {props.onAddSection && (
            <button
              type="button"
              className="small ghost"
              style={{ border: '1px dashed var(--line)' }}
              onClick={() => setShowCustom(!showCustom)}
              title="Add a custom one-off verse or spontaneous lyric"
            >
              + Custom verse…
            </button>
          )}
        </div>
      )}

      {/* Custom verse inline builder */}
      {showCustom && !props.disabled && (
        <div
          className="card col"
          style={{
            gap: 8,
            padding: 10,
            background: 'var(--bg3)',
            border: '1px solid var(--accent)',
            borderRadius: 8,
          }}
        >
          <span className="bold small">Add Custom Lyric Slide</span>
          <div className="row" style={{ gap: 6 }}>
            <input
              className="grow"
              placeholder="Section label (e.g. Verse 4, Tag, Spontaneous)"
              value={customLabel}
              onChange={(e) => {
                setCustomLabel(e.target.value);
                if (!customShort || customShort === customLabel.slice(0, 2).toUpperCase()) {
                  setCustomShort(e.target.value.slice(0, 2).toUpperCase());
                }
              }}
            />
            <input
              style={{ width: 80 }}
              placeholder="Code (V4)"
              value={customShort}
              onChange={(e) => setCustomShort(e.target.value)}
            />
          </div>
          <textarea
            rows={3}
            placeholder="Type custom lyrics for this slide (blank line splits slides)..."
            value={customLyrics}
            onChange={(e) => setCustomLyrics(e.target.value)}
            style={{ resize: 'vertical', minHeight: 60, fontSize: 13, fontFamily: 'inherit' }}
          />
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" className="small" onClick={() => setShowCustom(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="small primary"
              disabled={!customLyrics.trim()}
              onClick={handleCreateCustom}
            >
              Add to song & arrangement
            </button>
          </div>
        </div>
      )}

      {/* 3. Vertical stack of draggable boxes with lyrics */}
      <div className="col arr-stack" style={{ gap: 6 }} ref={sort.ref}>
        {a.sectionIds.map((id, i) => {
          const s = byId.get(id);
          const occurrence = a.sectionIds.slice(0, i).filter((x) => x === id).length;
          const chipKey = `${id}#${occurrence}`;
          const lyrics = s ? getSectionLyrics(s) : '';
          return (
            <div
              key={chipKey}
              {...sort.item(i)}
              {...sort.mouseArea(i)}
              data-arr-card={i}
              className={`card col arr-card ${sel === i ? 'picked' : ''} ${sort.cls(i)}`}
              style={{
                padding: '8px 10px',
                background: sel === i ? 'var(--bg3)' : 'var(--bg2)',
                border: sel === i ? '1px solid var(--accent)' : '1px solid var(--line)',
                borderRadius: 6,
                gap: 6,
                cursor: props.disabled ? undefined : 'grab',
                userSelect: 'none',
              }}
              onClick={() => !props.disabled && setPicked(sel === i ? null : i)}
            >
              <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <div className="row" style={{ alignItems: 'center', gap: 6 }}>
                  <DragHandle label="Drag to reorder" disabled={props.disabled} {...sort.handle(i)} />
                  <span className="tag" style={{ fontWeight: 600, fontSize: 12 }}>
                    {s?.short || s?.label || '?'}
                  </span>
                  <span className="bold small" style={{ color: 'var(--fg)' }}>
                    {s?.label || 'Untitled Section'}
                  </span>
                </div>
                {!props.disabled && (
                  <button
                    type="button"
                    className="ghost small danger"
                    style={{ padding: '0 6px', minHeight: 24, minWidth: 24, fontSize: 13 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onChange(removeAt(a, i));
                      if (sel === i) setPicked(null);
                    }}
                    title="Remove from arrangement"
                    aria-label="Remove from arrangement"
                  >
                    ✕
                  </button>
                )}
              </div>
              {lyrics ? (
                <div
                  className="muted small"
                  style={{
                    fontSize: 12,
                    lineHeight: 1.35,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 64,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    fontStyle: 'italic',
                    opacity: 0.85,
                    paddingLeft: 22,
                  }}
                >
                  {lyrics}
                </div>
              ) : (
                <div className="muted small" style={{ fontStyle: 'italic', opacity: 0.5, paddingLeft: 22 }}>
                  (No lyrics)
                </div>
              )}
            </div>
          );
        })}
        {a.sectionIds.length === 0 && (
          <div className="card muted small center" style={{ padding: 12, border: '1px dashed var(--line)' }}>
            No sections in this arrangement. Add sections above or type a sequence.
          </div>
        )}
      </div>
    </div>
  );
}

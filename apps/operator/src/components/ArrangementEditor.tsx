import type { Arrangement, Presentation } from '@ordo/domain';
import { useState } from 'react';
import { DragHandle, useSortable } from './Sortable.tsx';
import {
  arrangementLabel,
  duplicateAt,
  insertSection,
  moveAt,
  parseArrangement,
  removeAt,
} from '../lib/arrangement.ts';

/**
 * Edit one arrangement: section chips (drag by the grip to reorder, mouse or touch; or select a chip and
 * move it with the Earlier/Later buttons), + to repeat, × to remove, add buttons, or type "V1 C V2 C".
 */
export function ArrangementEditor(props: {
  presentation: Pick<Presentation, 'sections'>;
  value: Arrangement;
  onChange: (a: Arrangement) => void;
  disabled?: boolean;
}) {
  const { presentation: p, value: a } = props;
  const [picked, setPicked] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const byId = new Map(p.sections.map((s) => [s.id, s]));
  const typed = text !== null ? parseArrangement(text, p) : null;
  const sel = picked !== null && picked < a.sectionIds.length ? picked : null;
  const move = (from: number, to: number) => {
    props.onChange(moveAt(a, from, to));
    if (sel === from) setPicked(to);
  };
  const sort = useSortable({ group: 'arrangement', axis: 'xy', disabled: props.disabled, onMove: move });
  const selSection = sel !== null ? byId.get(a.sectionIds[sel]!) : undefined;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap arr-chips" style={{ gap: 4 }} ref={sort.ref}>
        {a.sectionIds.map((id, i) => {
          const s = byId.get(id);
          const occurrence = a.sectionIds.slice(0, i).filter((x) => x === id).length;
          const chipKey = `${id}#${occurrence}`;
          return (
            <span
              key={chipKey}
              {...sort.item(i)}
              {...sort.mouseArea(i)}
              data-arr-chip={i}
              className={`tag arr-chip ${sel === i ? 'picked' : ''} ${sort.cls(i)}`}
              style={{ padding: '4px 8px', fontSize: 13, cursor: 'grab', background: 'var(--bg4)' }}
              title={s?.label}
            >
              <DragHandle label="Drag to reorder" disabled={props.disabled} {...sort.handle(i)} />
              <button
                type="button"
                className="ghost small arr-chip-label"
                data-sort-grab
                aria-pressed={sel === i}
                onClick={() => !props.disabled && setPicked(sel === i ? null : i)}
              >
                {s?.short || s?.label || '?'}
              </button>
              {!props.disabled && (
                <>
                  <button
                    type="button"
                    className="ghost small touch-hide"
                    style={{ minHeight: 16, padding: '0 2px' }}
                    onClick={() => props.onChange(duplicateAt(a, i))}
                    title="Repeat"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="ghost small touch-hide"
                    style={{ minHeight: 16, padding: '0 2px' }}
                    onClick={() => props.onChange(removeAt(a, i))}
                    title="Remove"
                  >
                    ×
                  </button>
                </>
              )}
            </span>
          );
        })}
        {a.sectionIds.length === 0 && <span className="muted small">Empty: add sections below.</span>}
      </div>
      {!props.disabled && a.sectionIds.length > 0 && (
        <div className="row wrap arr-move" style={{ gap: 4 }}>
          <span className="muted small">
            {selSection
              ? `Move ${selSection.short || selSection.label} (${sel! + 1} of ${a.sectionIds.length}):`
              : 'Select a section to move it:'}
          </span>
          <button
            type="button"
            className="small"
            disabled={sel === null || sel === 0}
            onClick={() => sel !== null && move(sel, sel - 1)}
          >
            ← Earlier
          </button>
          <button
            type="button"
            className="small"
            disabled={sel === null || sel === a.sectionIds.length - 1}
            onClick={() => sel !== null && move(sel, sel + 1)}
          >
            Later →
          </button>
          {/* Touch: the chips' small + and × become these (one row of big targets for the picked chip). */}
          <button
            type="button"
            className="small touch-only"
            disabled={sel === null}
            onClick={() => sel !== null && props.onChange(duplicateAt(a, sel))}
          >
            + Repeat
          </button>
          <button
            type="button"
            className="small touch-only"
            disabled={sel === null}
            onClick={() => {
              if (sel === null) return;
              props.onChange(removeAt(a, sel));
              setPicked(null);
            }}
          >
            × Remove
          </button>
        </div>
      )}
      {!props.disabled && (
        <>
          <div className="row wrap" style={{ gap: 4 }}>
            <span className="muted small">Add:</span>
            {p.sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className="small"
                onClick={() => props.onChange(insertSection(a, s.id))}
                title={s.label}
              >
                {s.short || s.label}
              </button>
            ))}
          </div>
          <div className="row">
            <input
              className="grow"
              placeholder="Type an order, e.g. V1 C V2 C B C C"
              value={text ?? arrangementLabel(a, p)}
              onFocus={() => setText(arrangementLabel(a, p))}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => setText(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typed && !typed.unknown.length) {
                  props.onChange({ ...a, sectionIds: typed.sectionIds });
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </div>
          {typed && typed.unknown.length > 0 && (
            <span className="small" style={{ color: 'var(--amber)' }}>
              Unknown: {typed.unknown.join(', ')}
            </span>
          )}
        </>
      )}
    </div>
  );
}

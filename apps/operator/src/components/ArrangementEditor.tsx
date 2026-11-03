import type { Arrangement, Presentation } from '@ordo/domain';
import { useState } from 'react';
import {
  arrangementLabel,
  duplicateAt,
  insertSection,
  moveAt,
  parseArrangement,
  removeAt,
} from '../lib/arrangement.ts';

/** Edit one arrangement: section chips (drag to reorder, × to remove), add buttons, or type "V1 C V2 C". */
export function ArrangementEditor(props: {
  presentation: Pick<Presentation, 'sections'>;
  value: Arrangement;
  onChange: (a: Arrangement) => void;
  disabled?: boolean;
}) {
  const { presentation: p, value: a } = props;
  const [drag, setDrag] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const byId = new Map(p.sections.map((s) => [s.id, s]));
  const typed = text !== null ? parseArrangement(text, p) : null;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 4 }}>
        {a.sectionIds.map((id, i) => {
          const s = byId.get(id);
          return (
            <span
              key={`${id}-${i}`}
              className="tag"
              draggable={!props.disabled}
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (drag !== null) props.onChange(moveAt(a, drag, i));
                setDrag(null);
              }}
              style={{ padding: '4px 8px', fontSize: 13, cursor: 'grab', background: 'var(--bg4)' }}
              title={s?.label}
            >
              {s?.short || s?.label || '?'}
              {!props.disabled && (
                <>
                  <button type="button" className="ghost small" style={{ minHeight: 16, padding: '0 2px' }} onClick={() => props.onChange(duplicateAt(a, i))} title="Repeat">
                    +
                  </button>
                  <button type="button" className="ghost small" style={{ minHeight: 16, padding: '0 2px' }} onClick={() => props.onChange(removeAt(a, i))} title="Remove">
                    ×
                  </button>
                </>
              )}
            </span>
          );
        })}
        {a.sectionIds.length === 0 && <span className="muted small">Empty: add sections below.</span>}
      </div>
      {!props.disabled && (
        <>
          <div className="row wrap" style={{ gap: 4 }}>
            <span className="muted small">Add:</span>
            {p.sections.map((s) => (
              <button key={s.id} type="button" className="small" onClick={() => props.onChange(insertSection(a, s.id))} title={s.label}>
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
          {typed && typed.unknown.length > 0 && <span className="small" style={{ color: 'var(--amber)' }}>Unknown: {typed.unknown.join(', ')}</span>}
        </>
      )}
    </div>
  );
}

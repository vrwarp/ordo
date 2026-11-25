import { arrangementFor, type Presentation } from '@ordo/domain';
import { useEffect, useState } from 'react';
import { Icon } from './Icons.tsx';
import { DragHandle, useSortable } from './Sortable.tsx';
import { moveItem } from '../lib/arrangement.ts';
import { sectionTone } from '../lib/sectionColors.ts';

/**
 * Compact horizontal section-order strip for song items (ADR 0015 / design/28 §3.5).
 * Edits write to `PlaylistItem.sections` (per-service override) without polluting the shared song.
 * In Live mode, editing is guarded behind an explicit `Arrange` toggle and disabled while the item is ON AIR.
 */
export function InlineArrangementStrip({
  presentation,
  arrangementId,
  sectionsOverride,
  liveMode,
  locked,
  onChangeSections,
  onArrangeOpenChange,
  onPromoteToSong,
}: {
  presentation: Presentation;
  arrangementId?: string;
  sectionsOverride?: readonly string[];
  liveMode?: boolean;
  /** True when the item is currently ON AIR or the user cannot edit. */
  locked?: boolean;
  onChangeSections: (sections: string[] | null) => void;
  onArrangeOpenChange?: (open: boolean) => void;
  onPromoteToSong?: (sectionIds: string[]) => void;
}) {
  const [editingLive, setEditingLive] = useState(false);

  // If the item becomes locked (e.g. went ON AIR), close live editing immediately.
  useEffect(() => {
    if (locked && editingLive) {
      setEditingLive(false);
      onArrangeOpenChange?.(false);
    }
  }, [locked, editingLive, onArrangeOpenChange]);

  const baseArr = arrangementFor(presentation, arrangementId);
  const activeIds = sectionsOverride ?? baseArr.sectionIds;
  const byId = new Map(presentation.sections.map((s) => [s.id, s]));
  const validIds = activeIds.filter((id) => byId.has(id));
  const isCustom = sectionsOverride !== undefined;
  const canEdit = !locked && (!liveMode || editingLive);

  const sort = useSortable({
    group: `inline-arr-${presentation.id}`,
    axis: 'xy',
    disabled: !canEdit,
    onMove: (from, to) => {
      onChangeSections(moveItem(validIds, from, to));
    },
  });

  const toggleLiveEdit = () => {
    const next = !editingLive;
    setEditingLive(next);
    onArrangeOpenChange?.(next);
  };

  return (
    <div
      className="row wrap"
      style={{
        gap: 6,
        alignItems: 'center',
        padding: '4px 8px',
        background: canEdit && liveMode ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg2)',
        borderBottom: '1px solid var(--line)',
        fontSize: 11.5,
      }}
      data-arrangement-strip
    >
      <span
        className="muted small"
        style={{ fontSize: 10.5, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}
      >
        Order
      </span>
      <div className="row wrap" ref={sort.ref} style={{ gap: 4, alignItems: 'center', flex: 1, minWidth: 0 }}>
        {validIds.map((id, i) => {
          const sec = byId.get(id)!;
          const tone = sectionTone(sec.label, sec.short);
          const occ = validIds.slice(0, i).filter((x) => x === id).length;
          return (
            <span
              key={`${id}#${occ}`}
              {...sort.item(i)}
              {...sort.mouseArea(i)}
              className={`tag row ${sort.cls(i)}`}
              style={{
                gap: 4,
                alignItems: 'center',
                padding: '1px 6px',
                cursor: canEdit ? 'grab' : 'default',
                userSelect: 'none',
                borderLeft: `3px solid ${tone.border}`,
                background: 'var(--bg3)',
                color: 'var(--fg)',
              }}
              title={sec.label}
              data-arr-strip-chip={i}
            >
              {canEdit && <DragHandle label={`Drag ${sec.label}`} {...sort.handle(i)} />}
              <span>{sec.short || sec.label}</span>
              {canEdit && validIds.length > 1 && (
                <button
                  type="button"
                  className="ghost"
                  style={{ padding: 0, minHeight: 16, minWidth: 16, fontSize: 11, lineHeight: 1 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChangeSections(validIds.filter((_, idx) => idx !== i));
                  }}
                  aria-label={`Remove ${sec.label}`}
                  title="Remove occurrence"
                >
                  <Icon name="close" size={10} />
                </button>
              )}
            </span>
          );
        })}
        {validIds.length === 0 && <span className="muted small">Empty</span>}
        {canEdit && (
          <span className="row wrap" style={{ gap: 3, marginLeft: 4 }}>
            {presentation.sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className="ghost small"
                style={{
                  padding: '0 5px',
                  fontSize: 10.5,
                  border: '1px dashed var(--line-strong)',
                  minHeight: 20,
                }}
                onClick={() => onChangeSections([...validIds, s.id])}
                title={`Append ${s.label}`}
              >
                +{s.short || s.label}
              </button>
            ))}
          </span>
        )}
      </div>

      <div className="row" style={{ gap: 4, alignItems: 'center', flexShrink: 0 }}>
        {isCustom && (
          <span className="tag amber" style={{ fontSize: 10, padding: '1px 5px' }}>
            {liveMode ? 'edited live' : 'custom'}
          </span>
        )}
        {isCustom && canEdit && (
          <button
            type="button"
            className="ghost small"
            style={{ fontSize: 11 }}
            onClick={() => onChangeSections(null)}
            title="Reset back to the song's arrangement"
          >
            Reset
          </button>
        )}
        {isCustom && !liveMode && !locked && onPromoteToSong && (
          <button
            type="button"
            className="ghost small"
            style={{ fontSize: 11 }}
            onClick={() => onPromoteToSong(validIds)}
            title="Save this section order as a reusable arrangement on the song"
          >
            Save to song…
          </button>
        )}
        {liveMode && (
          <button
            type="button"
            className={editingLive ? 'primary small' : 'small'}
            disabled={locked}
            onClick={toggleLiveEdit}
            title={locked ? 'Locked while this song is ON AIR' : 'Adjust section order for this service'}
            data-arrange-toggle
          >
            <Icon name={editingLive ? 'check' : 'arrange'} size={12} />
            {editingLive ? 'Done' : 'Arrange'}
          </button>
        )}
      </div>
    </div>
  );
}

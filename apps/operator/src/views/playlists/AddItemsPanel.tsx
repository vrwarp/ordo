import { type ActionId, newId, type PlaylistItem } from '@ordo/domain';
import { useMemo, useState } from 'react';
import { SlidePreviewRoll } from '../../components/SlidePreviewRoll.tsx';
import { Select } from '../../components/fields.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { useLibrary } from '../../state/library.ts';
import { useSearch } from '../../services/search.ts';
import { stateTag } from '../library/MediaTab.tsx';

const ACTIONS: { value: ActionId; label: string }[] = [
  { value: 'clearAll', label: 'Clear all to black' },
  { value: 'clearSlide', label: 'Clear slide' },
  { value: 'clearLowerThird', label: 'Clear lower third' },
  { value: 'clearProps', label: 'Clear props' },
  { value: 'clearMedia', label: 'Clear media' },
  { value: 'clearBackground', label: 'Clear background' },
  { value: 'logo', label: 'Show logo' },
];

/** Insert presentations (with arrangement), media, timers and actions into a playlist. */
export function AddItemsPanel({ onAdd }: { onAdd: (items: PlaylistItem[]) => void }) {
  const lib = useLibrary((s) => s.data);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'presentation' | 'media'>('presentation');
  const [time, setTime] = useState('10:00');
  const [label, setLabel] = useState('');
  const [action, setAction] = useState<ActionId>('clearAll');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [previewArrId, setPreviewArrId] = useState<string>('');
  const pres = useMemo(() => new Map(lib.presentations.map((p) => [p.id, p])), [lib.presentations]);
  const media = useMemo(() => new Map(lib.media.map((m) => [m.id, m])), [lib.media]);
  const results = useSearch(q, { kind, limit: 500 });
  return (
    <div className="add-items" style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', height: '100%' }}>
      <div className="col" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
        <h4>Add to playlist</h4>
        <div className="row">
          <button
            type="button"
            className={`small ${kind === 'presentation' ? 'on' : ''}`}
            onClick={() => setKind('presentation')}
          >
            Songs and slides
          </button>
          <button
            type="button"
            className={`small ${kind === 'media' ? 'on' : ''}`}
            onClick={() => setKind('media')}
          >
            Media
          </button>
        </div>
        <input
          placeholder="Search title, lyrics, CCLI, tag"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <VirtualList
        items={results}
        rowHeight={(d) => (d.kind === 'presentation' && expandedId === d.id ? 390 : 46)}
        rowClass={(d) => (d.kind === 'presentation' && expandedId === d.id ? 'expanded' : '')}
        keyOf={(d) => d.id}
        render={(d) => {
          if (d.kind === 'presentation') {
            const p = pres.get(d.id);
            if (!p) return null;
            const isExpanded = expandedId === p.id;
            return (
              <>
                <div className="row" style={{ alignItems: 'center', gap: 8, width: '100%', minHeight: 36 }}>
                  <button
                    type="button"
                    className="ghost small"
                    style={{
                      width: 22,
                      height: 22,
                      padding: 0,
                      fontSize: 12,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedId(isExpanded ? null : p.id);
                      setPreviewArrId(p.arrangements[0]?.id ?? '');
                    }}
                    title={isExpanded ? 'Collapse preview' : 'Preview slides'}
                  >
                    {isExpanded ? '▾' : '▸'}
                  </button>
                  <span
                    className="col grow"
                    style={{ gap: 0, cursor: 'pointer' }}
                    onClick={() => {
                      setExpandedId(isExpanded ? null : p.id);
                      setPreviewArrId(p.arrangements[0]?.id ?? '');
                    }}
                    title={isExpanded ? 'Collapse preview' : 'Click to preview slides'}
                  >
                    <span className="ellipsis">{p.title}</span>
                    <span className="muted small">{p.kind}</span>
                  </span>
                  <select
                    defaultValue=""
                    title="Arrangement"
                    style={{ maxWidth: 110 }}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      onAdd([
                        {
                          id: newId(),
                          kind: 'presentation',
                          presentationId: p.id,
                          arrangementId: e.target.value || undefined,
                        },
                      ]);
                      e.target.value = '';
                    }}
                  >
                    <option value="" disabled>
                      Add with…
                    </option>
                    {p.arrangements.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="small primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAdd([
                        {
                          id: newId(),
                          kind: 'presentation',
                          presentationId: p.id,
                          arrangementId: p.arrangements[0]?.id,
                        },
                      ]);
                    }}
                  >
                    Add
                  </button>
                </div>
                {isExpanded && (
                  <div
                    className="col"
                    style={{
                      width: '100%',
                      marginTop: 6,
                      padding: '10px 12px',
                      background: 'var(--bg)',
                      borderRadius: 8,
                      border: '1px solid var(--line)',
                      gap: 10,
                      boxSizing: 'border-box',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <SlidePreviewRoll
                      p={p}
                      compact={true}
                      selectedArrangementId={previewArrId || p.arrangements[0]?.id}
                      onSelectArrangement={(arrId) => setPreviewArrId(arrId)}
                    />
                    <div
                      className="row"
                      style={{
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingTop: 6,
                        borderTop: '1px solid var(--line)',
                        flexShrink: 0,
                      }}
                    >
                      <button type="button" className="small" onClick={() => setExpandedId(null)}>
                        Close
                      </button>
                      <button
                        type="button"
                        className="small primary"
                        onClick={() => {
                          onAdd([
                            {
                              id: newId(),
                              kind: 'presentation',
                              presentationId: p.id,
                              arrangementId: previewArrId || p.arrangements[0]?.id,
                            },
                          ]);
                        }}
                      >
                        + Add to Playlist
                      </button>
                    </div>
                  </div>
                )}
              </>
            );
          }
          const m = media.get(d.id);
          if (!m) return null;
          const ready = m.state === 'ready';
          return (
            <>
              <span className="col grow" style={{ gap: 0 }}>
                <span className="ellipsis">{m.name}</span>
                <span className="muted small">
                  {m.kind} {!ready && stateTag(m)}
                </span>
              </span>
              <button
                type="button"
                className="small primary"
                disabled={!ready}
                title={ready ? undefined : 'Available when processing has finished'}
                onClick={() =>
                  onAdd([{ id: newId(), kind: 'media', mediaId: m.id, loop: m.loop, onEnd: 'hold' }])
                }
              >
                Add
              </button>
            </>
          );
        }}
      />
      <div className="col" style={{ padding: 10, borderTop: '1px solid var(--line)' }}>
        <h4>Timer</h4>
        <div className="row wrap">
          <input
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="grow"
          />
        </div>
        <div className="row wrap">
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          <button
            type="button"
            className="small"
            onClick={() =>
              onAdd([
                {
                  id: newId(),
                  kind: 'timer',
                  timer: { kind: 'countdownTo', timeOfDay: time, label: label.trim() || undefined },
                },
              ])
            }
          >
            Add countdown
          </button>
          <button
            type="button"
            className="small"
            onClick={() =>
              onAdd([
                { id: newId(), kind: 'timer', timer: { kind: 'elapsed', label: label.trim() || undefined } },
              ])
            }
          >
            Add elapsed timer
          </button>
        </div>
        <h4 style={{ marginTop: 6 }}>Action</h4>
        <div className="row">
          <Select value={action} options={ACTIONS} onChange={setAction} style={{ flex: 1 }} />
          <button
            type="button"
            className="small"
            onClick={() => onAdd([{ id: newId(), kind: 'action', action }])}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

export { ACTIONS };

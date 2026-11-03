import { type ActionId, newId, type PlaylistItem } from '@ordo/domain';
import { useMemo, useState } from 'react';
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
  const pres = useMemo(() => new Map(lib.presentations.map((p) => [p.id, p])), [lib.presentations]);
  const media = useMemo(() => new Map(lib.media.map((m) => [m.id, m])), [lib.media]);
  const results = useSearch(q, { kind, limit: 500 });
  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', height: '100%' }}>
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
        rowHeight={46}
        keyOf={(d) => d.id}
        render={(d) => {
          if (d.kind === 'presentation') {
            const p = pres.get(d.id);
            if (!p) return null;
            return (
              <>
                <span className="col grow" style={{ gap: 0 }}>
                  <span className="ellipsis">{p.title}</span>
                  <span className="muted small">{p.kind}</span>
                </span>
                <select
                  defaultValue=""
                  title="Arrangement"
                  style={{ maxWidth: 110 }}
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
                  onClick={() =>
                    onAdd([
                      {
                        id: newId(),
                        kind: 'presentation',
                        presentationId: p.id,
                        arrangementId: p.arrangements[0]?.id,
                      },
                    ])
                  }
                >
                  Add
                </button>
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

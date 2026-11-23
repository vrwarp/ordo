import type { Playlist } from '@ordo/domain';
import { useState } from 'react';
import { openContextMenu } from './ContextMenu.tsx';
import { isPastServiceDate, sortPlaylistsUpcoming } from '../lib/playlists.ts';

/**
 * Shared playlist picker used by Playlists (`variant="sidebar"`) and Live (`variant="compact"`).
 * Always sorts upcoming/today's services first and flags past service dates so volunteers don't go live on
 * last week's plan by accident.
 */
export function PlaylistPicker({
  variant,
  playlists,
  selectedId,
  liveId,
  locked,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
  trailing,
}: {
  variant: 'sidebar' | 'compact';
  playlists: readonly Playlist[];
  selectedId?: string;
  liveId?: string;
  locked?: boolean;
  onSelect: (id: string) => void;
  onCreate?: (name: string) => void;
  onDuplicate?: (p: Playlist) => void;
  onDelete?: (p: Playlist) => void;
  trailing?: React.ReactNode;
}) {
  const [name, setName] = useState('');
  const sorted = sortPlaylistsUpcoming(playlists);
  const current = playlists.find((p) => p.id === selectedId);
  const pastSelected = current && !locked && isPastServiceDate(current.serviceDate);

  if (variant === 'compact') {
    return (
      <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
        <div className="row" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
          {locked ? (
            <b className="grow ellipsis" title={current?.name}>
              {current?.name ?? '—'}
            </b>
          ) : (
            <select
              className="grow"
              aria-label="Select service playlist"
              value={current?.id ?? ''}
              onChange={(e) => onSelect(e.target.value)}
            >
              {sorted.length === 0 && <option value="">No playlists</option>}
              {sorted.map((p) => {
                const datePart = p.serviceDate ? `${p.serviceDate} · ` : '';
                const livePart = p.id === liveId ? '● ' : '';
                return (
                  <option key={p.id} value={p.id}>
                    {livePart}
                    {datePart}
                    {p.name} ({p.items.length})
                  </option>
                );
              })}
            </select>
          )}
          {trailing}
        </div>
        {current && (current.serviceDate || pastSelected || (!locked && (onCreate || onDuplicate))) && (
          <div className="row wrap" style={{ gap: 6, alignItems: 'center', fontSize: 11 }}>
            {current.serviceDate && <span className="muted">{current.serviceDate}</span>}
            <span className="muted">· {current.items.length} items</span>
            {pastSelected && (
              <span
                className="tag amber"
                style={{ fontSize: 10, padding: '0 5px' }}
                title="This playlist's service date is in the past"
                data-past-date-warning
              >
                Past date
              </span>
            )}
            <span className="spacer" />
            {!locked && onDuplicate && (
              <button
                type="button"
                className="ghost small"
                style={{ fontSize: 11, padding: '1px 5px' }}
                onClick={() => onDuplicate(current)}
                title="Duplicate this playlist for next service"
                data-compact-duplicate-playlist
              >
                Duplicate
              </button>
            )}
            {!locked && onCreate && (
              <button
                type="button"
                className="ghost small"
                style={{ fontSize: 11, padding: '1px 5px' }}
                onClick={() => onCreate('')}
                title="Create a new service playlist"
                data-compact-new-playlist
              >
                + New
              </button>
            )}
          </div>
        )}
        {!current && !locked && onCreate && (
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              className="ghost small"
              style={{ fontSize: 11, padding: '1px 5px' }}
              onClick={() => onCreate('')}
              data-compact-new-playlist
            >
              + New playlist
            </button>
          </div>
        )}
      </div>
    );
  }

  // Sidebar variant (PlaylistsView)
  const submitCreate = () => {
    if (!onCreate) return;
    onCreate(name);
    setName('');
  };

  return (
    <div className="side col" style={{ gap: 4 }}>
      <h4>Playlists</h4>
      {onCreate && (
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            className="grow"
            placeholder="New playlist name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitCreate()}
          />
          <button type="button" className="primary" onClick={submitCreate} title="Create playlist">
            +
          </button>
        </div>
      )}
      {sorted.map((p) => {
        const past = isPastServiceDate(p.serviceDate);
        return (
          <a
            key={p.id}
            href={`#/playlists/${p.id}`}
            className={p.id === current?.id ? 'active' : ''}
            onClick={(e) => {
              e.preventDefault();
              onSelect(p.id);
            }}
            onContextMenu={(e) => {
              const isThisLive = p.id === liveId;
              openContextMenu(
                e,
                [
                  { label: 'Open playlist', onSelect: () => onSelect(p.id) },
                  ...(onDuplicate
                    ? [{ label: 'Duplicate for next service', onSelect: () => onDuplicate(p) }]
                    : []),
                  ...(onDelete
                    ? [
                        { kind: 'separator' as const },
                        {
                          label: 'Delete playlist…',
                          danger: true,
                          disabled: isThisLive,
                          onSelect: () => onDelete(p),
                        },
                      ]
                    : []),
                ],
                { ariaLabel: `${p.name} playlist actions` },
              );
            }}
          >
            <span className="col grow" style={{ gap: 2 }}>
              <span className="ellipsis">
                {p.id === liveId && <span style={{ color: 'var(--live)' }}>● </span>}
                {p.name}
              </span>
              <span className="muted small row" style={{ gap: 4, alignItems: 'center' }}>
                <span>
                  {p.serviceDate ?? 'No date'} · {p.items.length} items
                </span>
                {past && p.id !== liveId && <span style={{ opacity: 0.7 }}>(past)</span>}
              </span>
            </span>
          </a>
        );
      })}
    </div>
  );
}

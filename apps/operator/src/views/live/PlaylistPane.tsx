import type { PlaylistItem } from '@ordo/domain';
import { VirtualList } from '../../components/VirtualList.tsx';
import { itemGoTarget } from '../../lib/sections.ts';
import { startService } from '../../lib/startService.ts';
import { controller } from '../../services/controller.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { setUi, useUi } from '../../state/ui.ts';
import { navigate } from '../../useRoute.ts';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

const KIND_ICON: Record<PlaylistItem['kind'], string> = {
  presentation: '♪',
  media: '▶',
  timer: '⏱',
  action: '⚡',
};

export function itemTitle(it: PlaylistItem, op: Pick<OperatorPlaylist, 'presentation' | 'media'>): string {
  switch (it.kind) {
    case 'presentation':
      return op.presentation(it.presentationId)?.title ?? 'Missing presentation';
    case 'media':
      return op.media(it.mediaId)?.name ?? 'Missing media';
    case 'timer':
      return (
        it.timer.label ??
        (it.timer.kind === 'elapsed' ? 'Elapsed timer' : `Countdown to ${it.timer.timeOfDay}`)
      );
    case 'action':
      return `Action: ${it.action}`;
  }
}

export function itemSubtitle(it: PlaylistItem, op: Pick<OperatorPlaylist, 'presentation' | 'media'>): string {
  if (it.kind === 'presentation') {
    const p = op.presentation(it.presentationId);
    const a = p?.arrangements.find((x) => x.id === it.arrangementId) ?? p?.arrangements[0];
    return a ? a.name : '';
  }
  if (it.kind === 'media') {
    const m = op.media(it.mediaId);
    if (!m) return '';
    const st = m.state !== 'ready' ? ` · ${m.state}` : '';
    return `${m.kind}${(it.loop ?? m.loop) ? ' · loop' : ''}${st}`;
  }
  return '';
}

export function PlaylistPane({ op, viewItem }: { op: OperatorPlaylist; viewItem: number }) {
  const playlists = useLibrary((s) => s.data.playlists);
  const live = useLive((s) => s.state);
  const selectedId = useUi((s) => s.selectedPlaylistId);
  const items = op.playlist?.items ?? [];
  const liveItem = live.live !== undefined ? live.cues[live.live]?.itemIndex : undefined;
  const firstCueOf = (itemIndex: number) => (op.live ? itemGoTarget(op.cues, itemIndex) : undefined);
  return (
    <div className="pane" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="pane-head">
        {op.live ? (
          <b className="grow ellipsis">{op.playlist?.name}</b>
        ) : (
          <select
            className="grow"
            value={op.playlist?.id ?? ''}
            onChange={(e) =>
              setUi({ selectedPlaylistId: e.target.value, viewItemIndex: 0, followLive: true })
            }
          >
            {playlists.length === 0 && <option value="">No playlists</option>}
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {op.playlist && (
          <button
            type="button"
            className="small"
            onClick={() => navigate({ name: 'playlists', id: op.playlist!.id })}
          >
            {op.live ? 'View' : 'Edit'}
          </button>
        )}
      </div>
      {!op.live && op.playlist && (
        <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
          <button
            type="button"
            className="primary big"
            style={{ width: '100%' }}
            onClick={() => startService(op.playlist!.id)}
          >
            Go live with this playlist
          </button>
          {selectedId === undefined && (
            <div className="muted small" style={{ marginTop: 6 }}>
              Pick the service playlist above.
            </div>
          )}
        </div>
      )}
      <VirtualList
        items={items}
        rowHeight={52}
        style={{ flex: 1 }}
        keyOf={(it) => it.id}
        scrollToIndex={liveItem}
        rowClass={(_it, i) =>
          `pl-item ${i === viewItem ? 'sel' : ''} ${op.live && i === liveItem ? 'live' : ''}`
        }
        onRowClick={(_it, i) => setUi({ viewItemIndex: i, followLive: false })}
        onRowDoubleClick={(_it, i) => {
          const c = firstCueOf(i);
          if (c !== undefined) controller()?.go(c);
        }}
        render={(it) => (
          <>
            <span className="kind">{KIND_ICON[it.kind]}</span>
            <span className="col grow" style={{ gap: 0 }}>
              <span className="ellipsis">{itemTitle(it, op)}</span>
              <span className="muted small ellipsis">{itemSubtitle(it, op)}</span>
            </span>
          </>
        )}
      />
      {items.length === 0 && (
        <div className="muted" style={{ padding: 16 }}>
          This playlist is empty.
        </div>
      )}
    </div>
  );
}

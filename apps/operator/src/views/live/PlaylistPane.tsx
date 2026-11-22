import type { PlaylistItem } from '@ordo/domain';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { midiTriggerBadge } from '../../components/MidiTriggerPicker.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { itemSubtitle, itemTitle } from '../../lib/playlistItems.ts';
import { itemGoTarget } from '../../lib/sections.ts';
import { startService } from '../../lib/startService.ts';
import { controller } from '../../services/controller.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { useUnsaved } from '../../state/unsaved.ts';
import { requestScrollToPlaylistItem, setUi, useUi } from '../../state/ui.ts';
import { navigate } from '../../useRoute.ts';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

export const KIND_ICON: Record<PlaylistItem['kind'], string> = {
  presentation: '♪',
  media: '▶',
  timer: '⏱',
  action: '⚡',
};

// Re-exported from their own module (lib/playlistItems.ts), which the playlist editor imports without the
// live view's controller and startService.
export { itemSubtitle, itemTitle };

export function PlaylistPane({ op, viewItem }: { op: OperatorPlaylist; viewItem: number }) {
  const playlists = useLibrary((s) => s.data.playlists);
  const live = useLive((s) => s.state);
  const selectedId = useUi((s) => s.selectedPlaylistId);
  const unsavedItems = useUnsaved((s) => s.items);
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
            onChange={(e) => {
              setUi({ selectedPlaylistId: e.target.value, followLive: true });
              requestScrollToPlaylistItem(0);
            }}
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
            onClick={() => void startService(op.playlist!.id)}
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
        onRowClick={(_it, i) => requestScrollToPlaylistItem(i)}
        onRowDoubleClick={(_it, i) => {
          const c = firstCueOf(i);
          if (c !== undefined) controller()?.go(c);
        }}
        onRowContextMenu={(e, it, i) => {
          const first = firstCueOf(i);
          openContextMenu(
            e,
            [
              {
                label: 'Go to first cue',
                disabled: first === undefined,
                onSelect: () => {
                  if (first !== undefined) controller()?.go(first);
                },
              },
              {
                label: 'Arm first cue',
                disabled: first === undefined,
                onSelect: () => {
                  if (first !== undefined) controller()?.select(first);
                },
              },
              {
                label: 'Scroll to item',
                onSelect: () => requestScrollToPlaylistItem(i),
              },
              ...(it.kind === 'presentation'
                ? [
                    { kind: 'separator' as const },
                    {
                      label: 'Edit presentation…',
                      onSelect: () => navigate({ name: 'edit', id: it.presentationId }),
                    },
                  ]
                : []),
              ...(op.playlist
                ? [
                    { kind: 'separator' as const },
                    {
                      label: op.live ? 'View playlist…' : 'Edit playlist…',
                      onSelect: () => navigate({ name: 'playlists', id: op.playlist!.id }),
                    },
                  ]
                : []),
            ],
            { ariaLabel: `${itemTitle(it, op)} actions` },
          );
        }}
        render={(it, i) => {
          const isItemLive = op.live && i === liveItem;
          const presets = op.live
            ? live.resolved?.midiPresets
            : useLibrary.getState().data.settings.surfaces.midiPresets;
          const midiBadge = it.kind !== 'action' && it.midi ? midiTriggerBadge(it.midi, presets) : null;
          const bgBadge =
            it.kind === 'presentation'
              ? (() => {
                  const p = op.presentation(it.presentationId);
                  const effBgId = it.backgroundMediaId ?? p?.backgroundMediaId;
                  const effBg = effBgId ? op.media(effBgId) : undefined;
                  return effBg?.midi ? midiTriggerBadge(effBg.midi, presets) : null;
                })()
              : null;
          return (
            <>
              <span className={`kind ${isItemLive ? 'live' : ''}`}>
                {isItemLive ? '●' : KIND_ICON[it.kind]}
              </span>
              <span className="col grow" style={{ gap: 0 }}>
                <span className="ellipsis row" style={{ gap: 6, alignItems: 'center' }}>
                  <span className="ellipsis">{itemTitle(it, op)}</span>
                  {isItemLive && <span className="live-pill-mini">ON AIR</span>}
                  {it.kind === 'presentation' && Boolean(unsavedItems[`pres:${it.presentationId}`]) && (
                    <span
                      className="tag amber"
                      style={{ fontSize: 9.5, padding: '1px 4px' }}
                      title="Unsaved edits in editor"
                    >
                      unsaved
                    </span>
                  )}
                  {bgBadge && (
                    <span
                      className="tag"
                      title={`From background: ${bgBadge.title}`}
                      style={{
                        fontSize: 9.5,
                        padding: '1px 4px',
                        borderLeft: bgBadge.color ? `3px solid ${bgBadge.color}` : undefined,
                        opacity: 0.85,
                      }}
                    >
                      ● {bgBadge.label}
                    </span>
                  )}
                  {midiBadge && (
                    <span
                      className="tag"
                      title={midiBadge.title}
                      style={{
                        fontSize: 9.5,
                        padding: '1px 4px',
                        borderLeft: midiBadge.color ? `3px solid ${midiBadge.color}` : undefined,
                      }}
                    >
                      💡 {midiBadge.label}
                    </span>
                  )}
                </span>
                <span className="muted small ellipsis">{itemSubtitle(it, op)}</span>
              </span>
            </>
          );
        }}
      />
      {items.length === 0 && (
        <div className="muted" style={{ padding: 16 }}>
          This playlist is empty.
        </div>
      )}
    </div>
  );
}

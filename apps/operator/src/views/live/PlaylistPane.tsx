import type { Playlist, PlaylistItem } from '@ordo/domain';
import { useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { PlaylistItemRowContent } from '../../components/PlaylistItemRow.tsx';
import { PlaylistPicker } from '../../components/PlaylistPicker.tsx';
import { PlaylistReadinessStrip } from '../../components/PlaylistReadinessStrip.tsx';
import { DragHandle, useSortable } from '../../components/Sortable.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { moveItem } from '../../lib/arrangement.ts';
import { KIND_ICON, itemSubtitle, itemTitle } from '../../lib/playlistItems.ts';
import { itemGoTarget } from '../../lib/sections.ts';
import { startService } from '../../lib/startService.ts';
import { controller } from '../../services/controller.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { flushPlaylist, updatePlaylistDraft } from '../../state/playlistOutbox.ts';
import { useUnsaved } from '../../state/unsaved.ts';
import { requestScrollToPlaylistItem, setUi, useUi } from '../../state/ui.ts';
import { navigate } from '../../useRoute.ts';
import { AddItemsPanel } from '../playlists/AddItemsPanel.tsx';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

// Re-exported from their own module (lib/playlistItems.ts), which the playlist editor imports without the
// live view's controller and startService.
export { KIND_ICON, itemSubtitle, itemTitle };

export function PlaylistPane({ op, viewItem }: { op: OperatorPlaylist; viewItem: number }) {
  const lib = useLibrary((s) => s.data);
  const playlists = lib.playlists;
  const live = useLive((s) => s.state);
  const selectedId = useUi((s) => s.selectedPlaylistId);
  const unsavedItems = useUnsaved((s) => s.items);
  const [showAdd, setShowAdd] = useState(false);

  const items = op.playlist?.items ?? [];
  const liveItem = live.live !== undefined ? live.cues[live.live]?.itemIndex : undefined;
  const firstCueOf = (itemIndex: number) => (op.live ? itemGoTarget(op.cues, itemIndex) : undefined);

  const presets = op.live ? live.resolved?.midiPresets : lib.settings.surfaces.midiPresets;
  const storedBase: Playlist | undefined = op.playlist
    ? (playlists.find((p) => p.id === op.playlist!.id) ?? op.playlist)
    : undefined;

  const updatePreview = (fn: (p: Playlist) => Playlist) => {
    if (op.live || !storedBase) return;
    updatePlaylistDraft(storedBase, fn);
  };

  const sort = useSortable({
    group: 'live-preview-items',
    axis: 'y',
    disabled: op.live || !storedBase,
    onMove: (from, to) => updatePreview((p) => ({ ...p, items: moveItem(p.items, from, to) })),
  });

  const addPreviewItems = (newItems: PlaylistItem[]) => {
    if (op.live || !storedBase) return;
    const at = Math.min(items.length, Math.max(0, viewItem + 1));
    updatePreview((p) => {
      const list = [...p.items];
      list.splice(items.length === 0 ? 0 : at, 0, ...newItems);
      return { ...p, items: list };
    });
    requestScrollToPlaylistItem(items.length === 0 ? 0 : at);
  };

  const handleGoLive = async () => {
    if (!op.playlist) return;
    await flushPlaylist(op.playlist.id);
    await startService(op.playlist.id);
  };

  const isItemActive = (itemIndex: number) => {
    if (!op.live) return false;
    if (liveItem === itemIndex) return true;
    if (live.layers.slide.content && live.cues[live.layers.slide.content.cueIndex]?.itemIndex === itemIndex)
      return true;
    if (live.layers.media.content && live.cues[live.layers.media.content.cueIndex]?.itemIndex === itemIndex)
      return true;
    if (live.audio.content && live.cues[live.audio.content.cueIndex]?.itemIndex === itemIndex) return true;
    return false;
  };

  const openRowMenu = (e: React.MouseEvent, it: PlaylistItem, i: number) => {
    const first = firstCueOf(i);
    const active = isItemActive(i);
    openContextMenu(
      e,
      [
        ...(op.live
          ? [
              {
                label: it.skipped ? 'Go to first cue (unskips item)' : 'Go to first cue',
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
                label: it.skipped ? 'Include item in service' : 'Skip item in service',
                disabled: !it.skipped && active,
                onSelect: () => controller()?.skipItem(it.id, !it.skipped),
              },
            ]
          : [
              {
                label: it.skipped ? 'Include item' : 'Skip item',
                onSelect: () =>
                  updatePreview((p) => ({
                    ...p,
                    items: p.items.map((x) => {
                      if (x.id !== it.id) return x;
                      if (it.skipped) {
                        const { skipped: _s, ...rest } = x;
                        return rest;
                      }
                      return { ...x, skipped: true };
                    }),
                  })),
              },
              {
                label: 'Remove from playlist',
                danger: true,
                onSelect: () =>
                  updatePreview((p) => ({ ...p, items: p.items.filter((x) => x.id !== it.id) })),
              },
            ]),
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
                label: op.live ? 'View playlist…' : 'Open in Playlists…',
                onSelect: () => navigate({ name: 'playlists', id: op.playlist!.id }),
              },
            ]
          : []),
      ],
      { ariaLabel: `${itemTitle(it, op)} actions` },
    );
  };

  return (
    <div className="pane" style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div className="pane-head" style={{ alignItems: 'flex-start' }}>
        <PlaylistPicker
          variant="compact"
          playlists={playlists}
          selectedId={op.playlist?.id}
          liveId={op.live ? op.playlist?.id : undefined}
          locked={op.live}
          onSelect={(id) => {
            setUi({ selectedPlaylistId: id, followLive: true });
            requestScrollToPlaylistItem(0);
          }}
          trailing={
            op.playlist && (
              <button
                type="button"
                className="small"
                onClick={() => navigate({ name: 'playlists', id: op.playlist!.id })}
              >
                {op.live ? 'View' : 'Edit'}
              </button>
            )
          }
        />
      </div>
      {!op.live && op.playlist && (
        <>
          <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
            <button
              type="button"
              className="primary big"
              style={{ width: '100%' }}
              disabled={items.length === 0}
              onClick={() => void handleGoLive()}
            >
              Go live with this playlist
            </button>
            {selectedId === undefined && (
              <div className="muted small" style={{ marginTop: 6 }}>
                Auto-selected next service. Confirm the date above before going live.
              </div>
            )}
          </div>
          <PlaylistReadinessStrip
            playlist={op.playlist}
            presentations={lib.presentations}
            media={lib.media}
            unsavedItems={unsavedItems}
            compact
          />
        </>
      )}

      {op.live ? (
        <VirtualList
          items={items}
          rowHeight={52}
          style={{ flex: 1 }}
          keyOf={(it) => it.id}
          scrollToIndex={liveItem}
          rowClass={(_it, i) => `pl-item ${i === viewItem ? 'sel' : ''} ${i === liveItem ? 'live' : ''}`}
          onRowClick={(_it, i) => requestScrollToPlaylistItem(i)}
          onRowDoubleClick={(_it, i) => {
            const c = firstCueOf(i);
            if (c !== undefined) controller()?.go(c);
          }}
          onRowContextMenu={(e, it, i) => openRowMenu(e, it, i)}
          render={(it, i) => {
            const active = isItemActive(i);
            return (
              <PlaylistItemRowContent
                item={it}
                index={i}
                lookup={op}
                presets={presets}
                isLive={i === liveItem}
                unsaved={it.kind === 'presentation' && Boolean(unsavedItems[`pres:${it.presentationId}`])}
                trailing={
                  !active && (
                    <button
                      type="button"
                      className="ghost small"
                      style={{ fontSize: 11, padding: '2px 6px', flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        controller()?.skipItem(it.id, !it.skipped);
                      }}
                      title={it.skipped ? 'Include this item again' : 'Skip this item during sequential play'}
                      data-skip-item={it.id}
                    >
                      {it.skipped ? 'Unskip' : 'Skip'}
                    </button>
                  )
                }
              />
            );
          }}
        />
      ) : (
        <div ref={sort.ref} className="col" style={{ flex: 1, minHeight: 0, overflow: 'auto', gap: 0 }}>
          {items.map((it, i) => (
            <div
              key={it.id}
              {...sort.item(i)}
              {...sort.mouseArea(i)}
              data-playlist-item={it.id}
              className={`pl-item ${i === viewItem ? 'sel' : ''} ${sort.cls(i)}`}
              style={{ cursor: 'grab' }}
              onClick={() => requestScrollToPlaylistItem(i)}
              onContextMenu={(e) => openRowMenu(e, it, i)}
            >
              <PlaylistItemRowContent
                item={it}
                index={i}
                lookup={op}
                presets={presets}
                unsaved={it.kind === 'presentation' && Boolean(unsavedItems[`pres:${it.presentationId}`])}
                leading={<DragHandle label="Drag to reorder" {...sort.handle(i)} />}
                trailing={
                  <button
                    type="button"
                    className="ghost small"
                    style={{ padding: '2px 5px', flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      updatePreview((p) => ({ ...p, items: p.items.filter((x) => x.id !== it.id) }));
                    }}
                    title="Remove from playlist"
                    aria-label={`Remove ${itemTitle(it, op)}`}
                  >
                    ✕
                  </button>
                }
              />
            </div>
          ))}
          {items.length === 0 && (
            <div className="muted" style={{ padding: 16 }}>
              This playlist is empty.
            </div>
          )}
        </div>
      )}

      {!op.live && op.playlist && (
        <div style={{ padding: 8, borderTop: '1px solid var(--line)' }}>
          <button
            type="button"
            className="small"
            style={{ width: '100%' }}
            onClick={() => setShowAdd((v) => !v)}
            data-live-add-toggle
          >
            {showAdd ? 'Close add panel' : '+ Add song, media, timer…'}
          </button>
        </div>
      )}

      {op.live && (
        <div
          className="muted small"
          style={{
            padding: '6px 10px',
            borderTop: '1px solid var(--line)',
            fontSize: 11,
            lineHeight: 1.35,
          }}
        >
          Assets are cached for offline resilience. End service to add brand-new items.
        </div>
      )}

      {!op.live && showAdd && op.playlist && (
        <div
          className="card"
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 46,
            top: 56,
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
            padding: 0,
          }}
          data-live-add-popover
        >
          <div
            className="row"
            style={{
              padding: '8px 10px',
              borderBottom: '1px solid var(--line)',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <b className="small">Add to {op.playlist.name}</b>
            <button type="button" className="ghost small" onClick={() => setShowAdd(false)}>
              Done
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <AddItemsPanel onAdd={addPreviewItems} />
          </div>
        </div>
      )}
    </div>
  );
}

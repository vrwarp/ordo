import { api, DEMO } from '@ordo/client';
import { type Arrangement, newId, type Playlist, type PlaylistItem } from '@ordo/domain';
import { useEffect, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { midiTriggerBadge } from '../../components/MidiTriggerPicker.tsx';
import { DragHandle, useSortable } from '../../components/Sortable.tsx';
import { moveItem } from '../../lib/arrangement.ts';
import { deviceProfile } from '../../lib/capabilities.ts';
import { navigate } from '../../useRoute.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { flushPlaylist, updatePlaylistDraft, usePlaylistOutbox } from '../../state/playlistOutbox.ts';
import { currentRole } from '../../state/session.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { useUnsaved } from '../../state/unsaved.ts';
import { itemSubtitle, itemTitle } from '../../lib/playlistItems.ts';
import { AddItemsPanel } from './AddItemsPanel.tsx';
import { ItemSettings } from './ItemSettings.tsx';
import { startService } from '../../lib/startService.ts';
import { OfflineControl } from './OfflineControl.tsx';

/**
 * Build a service: rename, reorder (drag by the handle, touch included, or the arrow buttons), add from the library, per-item settings, go live (prd/02).
 * Changes save automatically (debounced) with the playlist's rev; the live playlist is read-only.
 */
export function PlaylistEditor(props: {
  playlist: Playlist;
  locked: boolean;
  canOperate: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const lib = useLibrary((s) => s.data);
  const isLive = useLive((s) => s.state.mode === 'live');
  const outboxEntry = usePlaylistOutbox((s) => s.entries[props.playlist.id]);
  const unsavedItems = useUnsaved((s) => s.items);
  const draft = outboxEntry ? outboxEntry.draft : props.playlist;
  const saving = outboxEntry ? outboxEntry.status : 'idle';
  const [sel, setSel] = useState<string | undefined>(draft.items[0]?.id);

  // Flush any debounced playlist save immediately when switching away from this playlist.
  useEffect(() => () => void flushPlaylist(props.playlist.id), [props.playlist.id]);

  const update = (fn: (p: Playlist) => Playlist) => {
    if (props.locked) return;
    updatePlaylistDraft(props.playlist, fn);
  };
  const sort = useSortable({
    group: 'playlist-items',
    axis: 'y',
    disabled: props.locked,
    onMove: (from, to) => update((p) => ({ ...p, items: moveItem(p.items, from, to) })),
  });
  const setItem = (id: string, fn: (it: PlaylistItem) => PlaylistItem) =>
    update((p) => ({ ...p, items: p.items.map((it) => (it.id === id ? fn(it) : it)) }));
  const addItems = (items: PlaylistItem[]) => {
    const at = sel ? draft.items.findIndex((it) => it.id === sel) + 1 : draft.items.length;
    update((p) => {
      const list = [...p.items];
      list.splice(at <= 0 ? list.length : at, 0, ...items);
      return { ...p, items: list };
    });
    if (items[0]) setSel(items[0].id);
  };
  const saveArrangement = async (presentationId: string, a: Arrangement): Promise<boolean> => {
    const p = lib.presentations.find((x) => x.id === presentationId);
    if (!p) return false;
    const i = p.arrangements.findIndex((x) => x.id === a.id);
    const arrangements = i >= 0 ? p.arrangements.map((x) => (x.id === a.id ? a : x)) : [...p.arrangements, a];
    try {
      const saved = await api<typeof p>(`/presentations/${p.id}`, {
        method: 'PUT',
        json: { ...p, arrangements },
      });
      upsertLocal('presentations', saved);
      return true;
    } catch (e) {
      toast(`Could not save the arrangement: ${errorText(e)}`, 'error');
      return false;
    }
  };

  const op = {
    presentation: (id: string) => lib.presentations.find((p) => p.id === id),
    media: (id: string) => lib.media.find((m) => m.id === id),
  };
  const selected = draft.items.find((it) => it.id === sel);
  return (
    <div
      style={{
        display: 'grid',
        height: '100%',
        minHeight: 0,
      }}
      className={`pl-editor ${props.locked ? 'locked' : ''}`}
    >
      <div className="col" style={{ minHeight: 0, overflow: 'auto', padding: 14, gap: 10 }}>
        {props.locked && (
          <div className="banner">
            {deviceProfile(currentRole()) === 'edit' ? (
              <>
                This playlist is <b>live</b> at the venue. It and its presentations can be edited again after
                the service.
              </>
            ) : (
              <>
                This playlist is <b>live</b>. It is locked until End service; its presentations are locked
                too.
              </>
            )}
          </div>
        )}
        <div className="row wrap">
          <input
            style={{ fontSize: 18, fontWeight: 600, flex: 1, minWidth: 200 }}
            value={draft.name}
            disabled={props.locked}
            onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
          />
          <input
            type="date"
            value={draft.serviceDate ?? ''}
            disabled={props.locked}
            onChange={(e) => update((p) => ({ ...p, serviceDate: e.target.value || undefined }))}
          />
          <span className="muted small" style={{ width: 70 }}>
            {saving === 'pending'
              ? 'Unsaved'
              : saving === 'saving'
                ? 'Saving…'
                : saving === 'error'
                  ? 'Not saved'
                  : 'Saved'}
          </span>
        </div>
        <div className="row wrap">
          {props.canOperate && !props.locked && (
            <button
              type="button"
              className="primary big"
              disabled={isLive || draft.items.length === 0}
              title={isLive ? 'Another playlist is live: End service first' : undefined}
              onClick={async () => {
                if (await startService(draft.id)) {
                  location.hash = '#/live';
                }
              }}
            >
              Go live
            </button>
          )}
          {props.canOperate && props.locked && (
            <button type="button" className="big" onClick={() => (location.hash = '#/live')}>
              Open operator view
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={props.onDuplicate}>
            Duplicate
          </button>
          <button type="button" className="danger" disabled={props.locked} onClick={props.onDelete}>
            Delete
          </button>
        </div>
        {props.canOperate && !DEMO && <OfflineControl playlistId={draft.id} rev={draft.rev} />}
        <div
          ref={sort.ref}
          className="col pl-list"
          style={{ gap: 0, border: '1px solid var(--line)', borderRadius: 8 }}
        >
          {draft.items.map((it, i) => (
            <div
              key={it.id}
              {...sort.item(i)}
              {...sort.mouseArea(i)}
              data-playlist-item={it.id}
              className={`pl-item ${it.id === sel ? 'sel' : ''} ${sort.cls(i)}`}
              onClick={() => setSel(it.id)}
              onContextMenu={(e) => {
                setSel(it.id);
                const locked = props.locked;
                openContextMenu(
                  e,
                  [
                    ...(it.kind === 'presentation'
                      ? [
                          {
                            label: 'Edit presentation…',
                            onSelect: () => navigate(`#/edit/${it.presentationId}`),
                          },
                          { kind: 'separator' as const },
                        ]
                      : []),
                    {
                      label: 'Duplicate item',
                      disabled: locked,
                      onSelect: () => {
                        const copy = { ...structuredClone(it), id: newId() };
                        update((p) => {
                          const list = [...p.items];
                          list.splice(i + 1, 0, copy);
                          return { ...p, items: list };
                        });
                        setSel(copy.id);
                      },
                    },
                    ...(it.kind === 'presentation' && it.backgroundMediaId
                      ? [
                          {
                            label: 'Clear background override',
                            disabled: locked,
                            onSelect: () =>
                              setItem(it.id, (x) =>
                                x.kind === 'presentation' ? { ...x, backgroundMediaId: undefined } : x,
                              ),
                          },
                        ]
                      : []),
                    { kind: 'separator' },
                    ...(i > 0
                      ? [
                          {
                            label: 'Move to top',
                            disabled: locked,
                            onSelect: () => update((p) => ({ ...p, items: moveItem(p.items, i, 0) })),
                          },
                          {
                            label: 'Move up',
                            disabled: locked,
                            onSelect: () => update((p) => ({ ...p, items: moveItem(p.items, i, i - 1) })),
                          },
                        ]
                      : []),
                    ...(i < draft.items.length - 1
                      ? [
                          {
                            label: 'Move down',
                            disabled: locked,
                            onSelect: () => update((p) => ({ ...p, items: moveItem(p.items, i, i + 1) })),
                          },
                          {
                            label: 'Move to bottom',
                            disabled: locked,
                            onSelect: () =>
                              update((p) => ({ ...p, items: moveItem(p.items, i, p.items.length - 1) })),
                          },
                        ]
                      : []),
                    { kind: 'separator' },
                    {
                      label: 'Remove from playlist',
                      danger: true,
                      disabled: locked,
                      onSelect: () => update((p) => ({ ...p, items: p.items.filter((x) => x.id !== it.id) })),
                    },
                  ],
                  { ariaLabel: `${itemTitle(it, op)} actions` },
                );
              }}
              style={{ cursor: props.locked ? 'pointer' : 'grab' }}
            >
              <DragHandle label="Drag to reorder" disabled={props.locked} {...sort.handle(i)} />
              <span className="muted small" style={{ width: 22 }}>
                {i + 1}
              </span>
              <span className="kind">
                {it.kind === 'presentation'
                  ? '♪'
                  : it.kind === 'media'
                    ? '▶'
                    : it.kind === 'timer'
                      ? '⏱'
                      : '⚡'}
              </span>
              <span className="col grow" style={{ gap: 0 }}>
                <span className="ellipsis row" style={{ gap: 6, alignItems: 'center' }}>
                  <span className="ellipsis">{itemTitle(it, op)}</span>
                  {it.kind === 'presentation' && Boolean(unsavedItems[`pres:${it.presentationId}`]) && (
                    <span
                      className="tag amber"
                      style={{ fontSize: 10, padding: '1px 5px' }}
                      title="Unsaved edits in editor"
                    >
                      unsaved
                    </span>
                  )}
                  {it.kind === 'presentation' &&
                    (() => {
                      const p = op.presentation(it.presentationId);
                      const effBgId = it.backgroundMediaId ?? p?.backgroundMediaId;
                      const effBg = effBgId ? op.media(effBgId) : undefined;
                      const bgb = effBg?.midi
                        ? midiTriggerBadge(effBg.midi, lib.settings.surfaces.midiPresets)
                        : null;
                      if (!bgb) return null;
                      return (
                        <span
                          className="tag"
                          title={`From background (${effBg!.name}): ${bgb.title}`}
                          style={{
                            fontSize: 10,
                            padding: '1px 5px',
                            borderLeft: bgb.color ? `3px solid ${bgb.color}` : undefined,
                            opacity: 0.85,
                          }}
                        >
                          ● {bgb.label}
                        </span>
                      );
                    })()}
                  {it.kind !== 'action' &&
                    it.midi &&
                    (() => {
                      const b = midiTriggerBadge(it.midi, lib.settings.surfaces.midiPresets);
                      if (!b) return null;
                      return (
                        <span
                          className="tag"
                          title={b.title}
                          style={{
                            fontSize: 10,
                            padding: '1px 5px',
                            borderLeft: b.color ? `3px solid ${b.color}` : undefined,
                            color: b.missing ? 'var(--warn, #d97706)' : undefined,
                          }}
                        >
                          💡 {b.label}
                        </span>
                      );
                    })()}
                </span>
                <span className="muted small ellipsis">{itemSubtitle(it, op)}</span>
              </span>
              {!props.locked && (
                <>
                  <button
                    type="button"
                    className="ghost small"
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      update((p) => ({ ...p, items: moveItem(p.items, i, i - 1) }));
                    }}
                    aria-label="Move up"
                  >
                    ↑<span className="touch-label">Up</span>
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    disabled={i === draft.items.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      update((p) => ({ ...p, items: moveItem(p.items, i, i + 1) }));
                    }}
                    aria-label="Move down"
                  >
                    ↓<span className="touch-label">Down</span>
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={(e) => {
                      e.stopPropagation();
                      update((p) => ({ ...p, items: p.items.filter((x) => x.id !== it.id) }));
                    }}
                    title="Remove"
                  >
                    ✕<span className="touch-label">Remove</span>
                  </button>
                </>
              )}
            </div>
          ))}
          {draft.items.length === 0 && (
            <div className="muted" style={{ padding: 16 }}>
              Add songs, media, timers and actions from the panel on the right.
            </div>
          )}
        </div>
        {selected && (
          <div className="card">
            <ItemSettings
              key={selected.id}
              item={selected}
              disabled={props.locked}
              onChange={(it) => setItem(selected.id, () => it)}
              onSaveArrangement={saveArrangement}
            />
          </div>
        )}
      </div>
      {!props.locked && (
        <div className="pl-add" style={{ minHeight: 0, overflow: 'hidden' }}>
          <AddItemsPanel onAdd={addItems} />
        </div>
      )}
    </div>
  );
}

export function newPresentationItem(presentationId: string, arrangementId?: string): PlaylistItem {
  return { id: newId(), kind: 'presentation', presentationId, arrangementId };
}

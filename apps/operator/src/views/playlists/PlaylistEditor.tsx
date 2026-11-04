import { api, ApiFailure } from '@ordo/client';
import { type Arrangement, newId, type Playlist, type PlaylistItem } from '@ordo/domain';
import { useEffect, useRef, useState } from 'react';
import { DragHandle, useSortable } from '../../components/Sortable.tsx';
import { moveItem } from '../../lib/arrangement.ts';
import { controller } from '../../services/controller.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { itemSubtitle, itemTitle } from '../live/PlaylistPane.tsx';
import { AddItemsPanel } from './AddItemsPanel.tsx';
import { ItemSettings } from './ItemSettings.tsx';

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
  const [draft, setDraft] = useState<Playlist>(props.playlist);
  const [sel, setSel] = useState<string | undefined>(draft.items[0]?.id);
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saving' | 'error'>('idle');
  const latest = useRef(draft);
  const rev = useRef(props.playlist.rev);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirty = useRef(false);

  // Follow remote changes when we have nothing unsaved.
  useEffect(() => {
    if (!dirty.current && props.playlist.rev !== rev.current) {
      rev.current = props.playlist.rev;
      setDraft(props.playlist);
      latest.current = props.playlist;
    }
  }, [props.playlist]);

  const flush = async () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    setSaving('saving');
    try {
      const saved = await api<Playlist>(`/playlists/${latest.current.id}`, {
        method: 'PUT',
        json: { ...latest.current, rev: rev.current },
      });
      rev.current = saved.rev;
      upsertLocal('playlists', saved);
      setSaving(dirty.current ? 'pending' : 'idle');
    } catch (e) {
      setSaving('error');
      if (e instanceof ApiFailure && e.status === 423)
        toast('This playlist is live and locked until End service.', 'warn');
      else if (e instanceof ApiFailure && e.status === 409) {
        toast(
          'The playlist was changed elsewhere. Reloaded the latest version; redo your last change.',
          'warn',
          8000,
        );
        try {
          const fresh = await api<Playlist>(`/playlists/${latest.current.id}`);
          rev.current = fresh.rev;
          latest.current = fresh;
          setDraft(fresh);
          upsertLocal('playlists', fresh);
          setSaving('idle');
        } catch {
          /* keep error */
        }
      } else toast(`Could not save the playlist: ${errorText(e)}`, 'error');
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency list
  useEffect(() => () => void flush(), []);

  const update = (fn: (p: Playlist) => Playlist) => {
    if (props.locked) return;
    const next = fn(latest.current);
    latest.current = next;
    setDraft(next);
    dirty.current = true;
    setSaving('pending');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 600);
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
      className="pl-editor"
    >
      <div className="col" style={{ minHeight: 0, overflow: 'auto', padding: 14, gap: 10 }}>
        {props.locked && (
          <div className="banner">
            This playlist is <b>live</b>. It is locked until End service; its presentations are locked too.
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
                await flush();
                controller()?.goLive(draft.id);
                location.hash = '#/live';
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
                <span className="ellipsis">{itemTitle(it, op)}</span>
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
              item={selected}
              disabled={props.locked}
              onChange={(it) => setItem(selected.id, () => it)}
              onSaveArrangement={saveArrangement}
            />
          </div>
        )}
      </div>
      <div className="pl-add" style={{ minHeight: 0, overflow: 'hidden' }}>
        {props.locked ? (
          <div className="muted" style={{ padding: 16 }}>
            Adding items is disabled while live.
          </div>
        ) : (
          <AddItemsPanel onAdd={addItems} />
        )}
      </div>
    </div>
  );
}

export function newPresentationItem(presentationId: string, arrangementId?: string): PlaylistItem {
  return { id: newId(), kind: 'presentation', presentationId, arrangementId };
}

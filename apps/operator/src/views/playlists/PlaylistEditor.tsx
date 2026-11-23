import { api, DEMO } from '@ordo/client';
import {
  type Arrangement,
  type Cue,
  expandCues,
  isHiddenCue,
  newId,
  type Playlist,
  type PlaylistItem,
  type Presentation,
  type Slide,
  withoutBackdrops,
} from '@ordo/domain';
import { useEffect, useMemo, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { InlineArrangementStrip } from '../../components/InlineArrangementStrip.tsx';
import { PlaylistItemRowContent } from '../../components/PlaylistItemRow.tsx';
import { PlaylistReadinessStrip } from '../../components/PlaylistReadinessStrip.tsx';
import { DragHandle, useSortable } from '../../components/Sortable.tsx';
import { moveItem } from '../../lib/arrangement.ts';
import { deviceProfile } from '../../lib/capabilities.ts';
import { itemTitle } from '../../lib/playlistItems.ts';
import { groupCues } from '../../lib/sections.ts';
import { startService } from '../../lib/startService.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { flushPlaylist, updatePlaylistDraft, usePlaylistOutbox } from '../../state/playlistOutbox.ts';
import { currentRole } from '../../state/session.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { setUi } from '../../state/ui.ts';
import { useUnsaved } from '../../state/unsaved.ts';
import { navigate } from '../../useRoute.ts';
import { SlideThumb } from '../live/SlideThumb.tsx';
import { AddItemsPanel } from './AddItemsPanel.tsx';
import { ItemSettings } from './ItemSettings.tsx';
import { OfflineControl } from './OfflineControl.tsx';

/**
 * Read-only slide preview of the selected playlist item on the Playlists page (N3: build with your eyes).
 * Compact-safe: renders SlideThumb directly without importing the live controller.
 */
function SelectedItemSlidePreview({
  item,
  playlistName,
  locked,
  presentation,
  op,
  onChangeSections,
  onToggleHiddenSlide,
  onPromoteToSong,
}: {
  item: PlaylistItem;
  playlistName: string;
  locked: boolean;
  presentation?: Presentation;
  op: {
    presentation: (id: string) => Presentation | undefined;
    media: (id: string) => import('@ordo/domain').Media | undefined;
    presentationsMap: Record<string, Presentation>;
    mediaMap: Record<string, import('@ordo/domain').Media>;
  };
  onChangeSections: (sections: string[] | null) => void;
  onToggleHiddenSlide: (slideId: string) => void;
  onPromoteToSong: (sectionIds: string[]) => void;
}) {
  const cues: Cue[] = useMemo(() => {
    const mini: Playlist = { id: '__preview', rev: 1, name: playlistName, items: [item] };
    return expandCues({
      playlist: mini,
      presentations: op.presentationsMap,
      media: op.mediaMap,
    });
  }, [item, playlistName, op.presentationsMap, op.mediaMap]);

  const groups = useMemo(() => groupCues(cues), [cues]);
  const isSong = presentation?.kind === 'song';

  const slideOf = (c: Cue): Slide | undefined => {
    if (!c.presentationId || !c.slideId || !presentation) return undefined;
    for (const s of presentation.sections) for (const sl of s.slides) if (sl.id === c.slideId) return sl;
    return undefined;
  };

  return (
    <div className="card col" style={{ gap: 8, padding: 0, overflow: 'hidden' }} data-playlist-slide-preview>
      <div
        className="row"
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--line)',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--bg2)',
        }}
      >
        <span className="small bold">
          Slide preview · {itemTitle(item, op)} ({cues.length} {cues.length === 1 ? 'cue' : 'cues'})
        </span>
        {presentation && (
          <a className="btn small" href={`#/edit/${presentation.id}`}>
            Edit slides…
          </a>
        )}
      </div>
      {isSong && presentation && presentation.sections.length > 0 && item.kind === 'presentation' && (
        <InlineArrangementStrip
          presentation={presentation}
          arrangementId={item.arrangementId}
          sectionsOverride={item.sections}
          locked={locked}
          onChangeSections={onChangeSections}
          onPromoteToSong={onPromoteToSong}
        />
      )}
      <div className="col" style={{ gap: 8, padding: 10, maxHeight: 280, overflow: 'auto' }}>
        {groups.map((g) => (
          <div key={g.pos} className="col" style={{ gap: 4 }}>
            {g.pos >= 0 && (
              <div className="row" style={{ gap: 6, alignItems: 'center', fontSize: 11 }}>
                <span className="tag">{g.short || g.label}</span>
                <span className="muted">{g.label}</span>
              </div>
            )}
            <div
              className="slide-grid"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
            >
              {g.cues.map((c) => {
                if (c.kind === 'slide') {
                  const own = slideOf(c);
                  const slide = c.backgroundOverride && own ? withoutBackdrops(own) : own;
                  const hidden = isHiddenCue(c);
                  const hiddenByService =
                    item.kind === 'presentation' &&
                    Boolean(c.slideId && item.hiddenSlides?.includes(c.slideId));
                  return (
                    <SlideThumb
                      key={c.index}
                      slide={slide}
                      isSong={Boolean(isSong)}
                      bgMediaId={c.backgroundMediaId}
                      media={op.media}
                      label={c.label}
                      number={(c.slideIndexInSection ?? 0) + 1}
                      marks={{ live: false, armed: false }}
                      width={140}
                      hidden={hidden}
                      onContextMenu={
                        !locked && c.slideId && item.kind === 'presentation'
                          ? (e) =>
                              openContextMenu(
                                e,
                                [
                                  {
                                    label: hiddenByService
                                      ? 'Include slide in this service'
                                      : 'Skip slide in this service',
                                    onSelect: () => onToggleHiddenSlide(c.slideId!),
                                  },
                                ],
                                { ariaLabel: `Slide ${c.label} actions` },
                              )
                          : undefined
                      }
                      footer={
                        hidden ? (
                          <span className="tag">{hiddenByService ? 'skipped' : 'hidden'}</span>
                        ) : undefined
                      }
                    />
                  );
                }
                return (
                  <SlideThumb
                    key={c.index}
                    bgMediaId={c.mediaId}
                    media={op.media}
                    isSong={false}
                    label={c.label}
                    marks={{ live: false, armed: false }}
                    width={140}
                    footer={<span className="tag">{c.kind === 'media' ? c.mediaKind : c.kind}</span>}
                  />
                );
              })}
            </div>
          </div>
        ))}
        {cues.length === 0 && <div className="muted small">Nothing to preview for this item.</div>}
      </div>
    </div>
  );
}

/**
 * Build a service: rename, reorder (drag by the handle, touch included, or the arrow buttons), add from the
 * library, preview slides, per-item settings, go live (prd/02).
 * Changes save automatically (debounced) with the playlist's rev; the live playlist is read-only here.
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

  const op = useMemo(() => {
    const presentationsMap: Record<string, Presentation> = {};
    for (const p of lib.presentations) presentationsMap[p.id] = p;
    const mediaMap: Record<string, (typeof lib.media)[number]> = {};
    for (const m of lib.media) mediaMap[m.id] = m;
    return {
      presentation: (id: string) => presentationsMap[id],
      media: (id: string) => mediaMap[id],
      presentationsMap,
      mediaMap,
    };
  }, [lib.presentations, lib.media]);

  const selected = draft.items.find((it) => it.id === sel);
  const selectedPres =
    selected?.kind === 'presentation' ? op.presentation(selected.presentationId) : undefined;

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
                This playlist is <b>live</b>. Use the Live view to skip items, arrange upcoming songs, or
                hotfix off-air text; End service to add new items.
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
            <>
              <button
                type="button"
                className="primary big"
                disabled={isLive || draft.items.length === 0}
                title={isLive ? 'Another playlist is live: End service first' : undefined}
                onClick={async () => {
                  await flushPlaylist(draft.id);
                  if (await startService(draft.id)) {
                    location.hash = '#/live';
                  }
                }}
              >
                Go live
              </button>
              <button
                type="button"
                className="big"
                onClick={() => {
                  setUi({ selectedPlaylistId: draft.id, followLive: true });
                  navigate({ name: 'live' });
                }}
              >
                Open on Live
              </button>
            </>
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
        <PlaylistReadinessStrip
          playlist={draft}
          presentations={lib.presentations}
          media={lib.media}
          unsavedItems={unsavedItems}
        />
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
                      label: it.skipped ? 'Include item' : 'Skip item',
                      disabled: locked,
                      onSelect: () =>
                        setItem(it.id, (x) => {
                          if (x.skipped) {
                            const { skipped: _s, ...rest } = x;
                            return rest;
                          }
                          return { ...x, skipped: true };
                        }),
                    },
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
              <PlaylistItemRowContent
                item={it}
                index={i}
                lookup={op}
                presets={lib.settings.surfaces.midiPresets}
                unsaved={it.kind === 'presentation' && Boolean(unsavedItems[`pres:${it.presentationId}`])}
                leading={<DragHandle label="Drag to reorder" disabled={props.locked} {...sort.handle(i)} />}
                trailing={
                  !props.locked && (
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
                  )
                }
              />
            </div>
          ))}
          {draft.items.length === 0 && (
            <div className="muted" style={{ padding: 16 }}>
              Add songs, media, timers and actions from the panel on the right.
            </div>
          )}
        </div>
        {selected && (
          <SelectedItemSlidePreview
            item={selected}
            playlistName={draft.name}
            locked={props.locked}
            presentation={selectedPres}
            op={op}
            onChangeSections={(sections) =>
              setItem(selected.id, (it) => {
                if (it.kind !== 'presentation') return it;
                if (sections === null) {
                  const { sections: _s, ...rest } = it;
                  return rest;
                }
                return { ...it, sections };
              })
            }
            onToggleHiddenSlide={(slideId) =>
              setItem(selected.id, (it) => {
                if (it.kind !== 'presentation') return it;
                const cur = it.hiddenSlides ?? [];
                const next = cur.includes(slideId) ? cur.filter((x) => x !== slideId) : [...cur, slideId];
                if (!next.length) {
                  const { hiddenSlides: _h, ...rest } = it;
                  return rest;
                }
                return { ...it, hiddenSlides: next };
              })
            }
            onPromoteToSong={async (sectionIds) => {
              if (!selectedPres) return;
              const arr: Arrangement = {
                id: newId(),
                name: draft.name,
                sectionIds,
              };
              if (await saveArrangement(selectedPres.id, arr)) {
                setItem(selected.id, (it) => {
                  if (it.kind !== 'presentation') return it;
                  const { sections: _s, ...rest } = it;
                  return { ...rest, arrangementId: arr.id };
                });
                toast(`Saved "${arr.name}" to ${selectedPres.title}`);
              }
            }}
          />
        )}
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

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
import { DateField } from '../../components/fields.tsx';
import { Icon } from '../../components/Icons.tsx';
import { InlineArrangementStrip } from '../../components/InlineArrangementStrip.tsx';
import { Menu } from '../../components/Menu.tsx';
import { PlaylistItemRowContent } from '../../components/PlaylistItemRow.tsx';
import { PlaylistReadinessStrip } from '../../components/PlaylistReadinessStrip.tsx';
import { DragHandle, useSortable } from '../../components/Sortable.tsx';
import { SplitPane } from '../../components/SplitPane.tsx';
import { moveItem } from '../../lib/arrangement.ts';
import { deviceProfile } from '../../lib/capabilities.ts';
import { itemTitle } from '../../lib/playlistItems.ts';
import { sectionTone } from '../../lib/sectionColors.ts';
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
 * Flush slide preview pane for the selected playlist item (design/30 §5.2).
 * Renders continuous multi-column color-banded SlideThumbs with collapsible Arrange strip.
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
  const [showArrange, setShowArrange] = useState(false);
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
  const hasCustomOrder = item.kind === 'presentation' && item.sections !== undefined;

  const slideOf = (c: Cue): Slide | undefined => {
    if (!c.presentationId || !c.slideId || !presentation) return undefined;
    for (const s of presentation.sections) for (const sl of s.slides) if (sl.id === c.slideId) return sl;
    return undefined;
  };

  if (item.kind === 'timer' || item.kind === 'action') {
    return (
      <div className="pl-pane" data-playlist-slide-preview>
        <div className="pl-pane-head">
          <span className="small bold ellipsis grow">{itemTitle(item, op)}</span>
          <span className="tag">{item.kind}</span>
        </div>
        <div className="center muted small" style={{ padding: 20 }}>
          Configure this {item.kind} cue in the inspector below.
        </div>
      </div>
    );
  }

  return (
    <div className="pl-pane" data-playlist-slide-preview>
      <div className="pl-pane-head">
        <span className="small bold ellipsis grow">
          {itemTitle(item, op)}{' '}
          <span className="muted" style={{ fontWeight: 400 }}>
            · {cues.length} {cues.length === 1 ? 'cue' : 'cues'}
          </span>
        </span>
        {isSong && presentation && presentation.sections.length > 0 && item.kind === 'presentation' && (
          <button
            type="button"
            className={showArrange || hasCustomOrder ? 'on small' : 'ghost small'}
            onClick={() => setShowArrange((v) => !v)}
            title="Show or hide song section order"
          >
            <Icon name="arrange" size={12} />
            Arrange
          </button>
        )}
        {presentation && (
          <a className="btn small" href={`#/edit/${presentation.id}`}>
            <Icon name="edit" size={11} />
            Edit slides…
          </a>
        )}
      </div>
      {isSong &&
        presentation &&
        presentation.sections.length > 0 &&
        item.kind === 'presentation' &&
        (showArrange || hasCustomOrder) && (
          <InlineArrangementStrip
            presentation={presentation}
            arrangementId={item.arrangementId}
            sectionsOverride={item.sections}
            locked={locked}
            onChangeSections={onChangeSections}
            onPromoteToSong={onPromoteToSong}
          />
        )}
      <div className="pl-pane-scroll" style={{ padding: 10 }}>
        <div className="slide-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))' }}>
          {groups.flatMap((g) => {
            const tone = g.pos >= 0 ? sectionTone(g.label, g.short) : undefined;
            return g.cues.map((c, idxInGroup) => {
              const band =
                tone && g.pos >= 0
                  ? { label: g.label, short: g.short, tone, isFirst: idxInGroup === 0 }
                  : undefined;
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
                    width={148}
                    hidden={hidden}
                    sectionBand={band}
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
                  width={148}
                  footer={<span className="tag">{c.kind === 'media' ? c.mediaKind : c.kind}</span>}
                />
              );
            });
          })}
        </div>
        {cues.length === 0 && <div className="muted small">Nothing to preview for this item.</div>}
      </div>
    </div>
  );
}

/**
 * Fixed 3-pane docked playlist editor (combined with PlaylistsView's sidebar for the 4-pane desktop workspace,
 * design/30 §5.2): Rundown | Vertical Split(Slide Preview + Docked 2-col Inspector) | Library/Insert Browser.
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

  const selected = draft.items.find((it) => it.id === sel) ?? draft.items[0];
  const selectedPres =
    selected?.kind === 'presentation' ? op.presentation(selected.presentationId) : undefined;

  const rundownPane = (
    <div className="pl-pane pl-pane-alt">
      <div className="col" style={{ padding: '6px 8px', gap: 6, borderBottom: '1px solid var(--line)' }}>
        <div className="row" style={{ gap: 4, alignItems: 'center' }}>
          <input
            className="grow"
            style={{ fontWeight: 600, fontSize: 13, minWidth: 0 }}
            value={draft.name}
            disabled={props.locked}
            aria-label="Playlist name"
            onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
          />
          <Menu
            label="⋯"
            align="right"
            items={[
              ...(props.canOperate && !props.locked
                ? [
                    {
                      label: 'Open on Live',
                      onSelect: () => {
                        setUi({ selectedPlaylistId: draft.id, followLive: true });
                        navigate({ name: 'live' });
                      },
                    },
                  ]
                : []),
              ...(props.canOperate && props.locked
                ? [{ label: 'Open operator view', onSelect: () => (location.hash = '#/live') }]
                : []),
              { label: 'Duplicate playlist', onSelect: props.onDuplicate },
              { label: 'Delete playlist', danger: true, disabled: props.locked, onSelect: props.onDelete },
            ]}
          />
        </div>
        <div className="row" style={{ gap: 5, alignItems: 'center' }}>
          <DateField
            value={draft.serviceDate ?? ''}
            disabled={props.locked}
            onChange={(iso) => update((p) => ({ ...p, serviceDate: iso || undefined }))}
          />
          <span className="muted" style={{ fontSize: 10.5 }}>
            {saving === 'pending'
              ? 'Unsaved'
              : saving === 'saving'
                ? 'Saving…'
                : saving === 'error'
                  ? 'Not saved'
                  : 'Saved'}
          </span>
          <span className="spacer" />
          {props.canOperate && !props.locked && (
            <button
              type="button"
              className="primary small"
              disabled={isLive || draft.items.length === 0}
              title={isLive ? 'Another playlist is live: End service first' : 'Go live with this playlist'}
              onClick={async () => {
                await flushPlaylist(draft.id);
                if (await startService(draft.id)) {
                  location.hash = '#/live';
                }
              }}
            >
              <Icon name="live" size={12} />
              Go live
            </button>
          )}
          {props.canOperate && props.locked && (
            <button type="button" className="small" onClick={() => (location.hash = '#/live')}>
              Open Live
            </button>
          )}
        </div>
      </div>

      {props.locked && (
        <div className="banner" style={{ margin: 6, padding: '6px 8px', fontSize: 11.5 }}>
          {deviceProfile(currentRole()) === 'edit' ? (
            <>
              This playlist is <b>live</b> at the venue. It and its presentations can be edited again after
              the service.
            </>
          ) : (
            <>
              This playlist is <b>live</b>. Use the Live view to skip items, arrange upcoming songs, or hotfix
              off-air text; End service to add new items.
            </>
          )}
        </div>
      )}

      <PlaylistReadinessStrip
        playlist={draft}
        presentations={lib.presentations}
        media={lib.media}
        unsavedItems={unsavedItems}
        compact
        offlineSlot={
          props.canOperate && !DEMO ? <OfflineControl playlistId={draft.id} rev={draft.rev} /> : undefined
        }
      />

      <div
        ref={sort.ref}
        className="pl-pane-scroll pl-list"
        tabIndex={0}
        onKeyDown={(e) => {
          if (props.locked || !selected) return;
          if (e.key === 'Delete' || e.key === 'Backspace') {
            const target = e.target as HTMLElement | null;
            if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
            e.preventDefault();
            update((p) => ({ ...p, items: p.items.filter((x) => x.id !== selected.id) }));
          }
        }}
      >
        {draft.items.map((it, i) => (
          <div
            key={it.id}
            {...sort.item(i)}
            {...sort.mouseArea(i)}
            data-playlist-item={it.id}
            className={`pl-item ${it.id === selected?.id ? 'sel' : ''} ${sort.cls(i)}`}
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
                  <span className="row row-hover-actions" style={{ gap: 1, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="ghost icon-btn"
                      disabled={i === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        update((p) => ({ ...p, items: moveItem(p.items, i, i - 1) }));
                      }}
                      aria-label="Move up"
                      title="Move up"
                    >
                      <Icon name="arrowUp" size={11} />
                      <span className="touch-label">Up</span>
                    </button>
                    <button
                      type="button"
                      className="ghost icon-btn"
                      disabled={i === draft.items.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        update((p) => ({ ...p, items: moveItem(p.items, i, i + 1) }));
                      }}
                      aria-label="Move down"
                      title="Move down"
                    >
                      <Icon name="arrowDown" size={11} />
                      <span className="touch-label">Down</span>
                    </button>
                    <button
                      type="button"
                      className="ghost icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        update((p) => ({ ...p, items: p.items.filter((x) => x.id !== it.id) }));
                      }}
                      title="Remove"
                      aria-label="Remove"
                    >
                      <Icon name="close" size={11} />
                      <span className="touch-label">Remove</span>
                    </button>
                  </span>
                )
              }
            />
          </div>
        ))}
        {draft.items.length === 0 && (
          <div className="muted" style={{ padding: 14, fontSize: 11.5 }}>
            Add songs, media, timers, or actions from the Library Browser on the right.
          </div>
        )}
      </div>
    </div>
  );

  const centerWorkspace = selected ? (
    <SplitPane
      storageKey="playlists-item-split"
      direction="vertical"
      panels={[
        {
          id: 'item-slides',
          content: (
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
          ),
        },
        {
          id: 'item-inspector',
          size: 310,
          min: 160,
          max: 540,
          content: (
            <div className="pl-pane pl-pane-alt">
              <div className="pl-pane-head">
                <span className="prop-section-title" style={{ margin: 0 }}>
                  Inspector · {itemTitle(selected, op)}
                </span>
              </div>
              <div className="pl-pane-scroll">
                <ItemSettings
                  key={selected.id}
                  item={selected}
                  disabled={props.locked}
                  onChange={(it) => setItem(selected.id, () => it)}
                  onSaveArrangement={saveArrangement}
                />
              </div>
            </div>
          ),
        },
      ]}
    />
  ) : (
    <div className="pl-pane center muted small">Select an item in the rundown to preview and inspect.</div>
  );

  return (
    <div className={`pl-editor ${props.locked ? 'locked' : ''}`} style={{ height: '100%', minHeight: 0 }}>
      <SplitPane
        storageKey="playlists-inner"
        panels={[
          { id: 'rundown', size: 254, min: 200, max: 380, content: rundownPane },
          { id: 'workspace', content: centerWorkspace },
          ...(!props.locked
            ? [
                {
                  id: 'browser',
                  size: 268,
                  min: 210,
                  max: 420,
                  className: 'pl-add',
                  content: <AddItemsPanel onAdd={addItems} />,
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

export function newPresentationItem(presentationId: string, arrangementId?: string): PlaylistItem {
  return { id: newId(), kind: 'presentation', presentationId, arrangementId };
}

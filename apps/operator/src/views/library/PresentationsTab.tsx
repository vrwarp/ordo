import { api, ApiFailure } from '@ordo/client';
import { DEFAULT_THEME, newId, type Playlist, type Presentation, type PresentationKind } from '@ordo/domain';
import type { Folder } from '@ordo/protocol';
import { useMemo, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { PropertyRow, Select } from '../../components/fields.tsx';
import { Icon, playlistItemIconName } from '../../components/Icons.tsx';
import { SlidePreviewRoll, slidePreviewRollHeight } from '../../components/SlidePreviewRoll.tsx';
import { SplitPane } from '../../components/SplitPane.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { useLivePlaylistId, useLockedIds } from '../../hooks.ts';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { useSearch } from '../../services/search.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { setUi, useUi } from '../../state/ui.ts';
import { useUnsaved } from '../../state/unsaved.ts';
import { navigate } from '../../useRoute.ts';
import { NewSongDialog } from './NewSongDialog.tsx';

export function explainSaveError(e: unknown): string {
  if (e instanceof ApiFailure && e.status === 423)
    return 'It is used by the live playlist and locked until End service.';
  if (e instanceof ApiFailure && e.status === 409)
    return 'Someone else changed it meanwhile. Reload and try again.';
  return errorText(e);
}

export async function savePresentation(p: Presentation): Promise<Presentation | undefined> {
  try {
    const saved = await api<Presentation>(`/presentations/${p.id}`, { method: 'PUT', json: p });
    upsertLocal('presentations', saved);
    return saved;
  } catch (e) {
    toast(`Could not save “${p.title}”: ${explainSaveError(e)}`, 'error');
    return undefined;
  }
}

export async function createPresentation(kind: PresentationKind, folderId?: string): Promise<void> {
  const p: Presentation = {
    id: newId(),
    rev: 1,
    title: kind === 'loop' ? 'New announcement loop' : 'New presentation',
    kind,
    meta: { tags: [] },
    folderId,
    sections: [
      {
        id: newId(),
        label: kind === 'loop' ? 'Announcements' : 'Slides',
        short: 'S',
        slides: [{ id: newId(), objects: [] }],
      },
    ],
    arrangements: [],
    loop: kind === 'loop' ? { defaultSlideMs: 8000 } : undefined,
    themeId: DEFAULT_THEME.id,
    archived: false,
    source: { kind: 'manual' },
  };
  try {
    const saved = await api<Presentation>('/presentations', { method: 'POST', json: p });
    upsertLocal('presentations', saved);
    navigate({ name: 'edit', id: saved.id });
  } catch (e) {
    toast(`Could not create: ${errorText(e)}`, 'error');
  }
}

function FolderSide(props: {
  folders: Folder[];
  tags: string[];
  tag?: string;
  setTag: (t?: string) => void;
}) {
  const folderId = useUi((s) => s.libraryFolderId);
  const [name, setName] = useState('');
  const addFolder = async () => {
    if (!name.trim()) return;
    try {
      const f = await api<Folder>('/folders', { method: 'POST', json: { name: name.trim() } });
      upsertLocal('folders', f);
      setName('');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const rename = async (f: Folder) => {
    const n = prompt('Folder name', f.name);
    if (!n?.trim()) return;
    try {
      upsertLocal(
        'folders',
        await api<Folder>(`/folders/${f.id}`, { method: 'PUT', json: { ...f, name: n.trim() } }),
      );
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const del = async (f: Folder) => {
    if (
      !(await confirmDialog(
        'Delete folder',
        `Delete “${f.name}”? Presentations in it stay in the library.`,
        'Delete',
        true,
      ))
    )
      return;
    try {
      await api(`/folders/${f.id}`, { method: 'DELETE' });
      removeLocal('folders', f.id);
      if (folderId === f.id) setUi({ libraryFolderId: undefined });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="side col" style={{ gap: 4 }}>
      <h4>Folders</h4>
      <span
        className={`link ${folderId === undefined ? 'active' : ''}`}
        onClick={() => setUi({ libraryFolderId: undefined })}
      >
        All presentations
      </span>
      <span
        className={`link ${folderId === null ? 'active' : ''}`}
        onClick={() => setUi({ libraryFolderId: null })}
      >
        Archived
      </span>
      {props.folders.map((f) => (
        <span
          key={f.id}
          className={`link ${folderId === f.id ? 'active' : ''}`}
          onClick={() => setUi({ libraryFolderId: f.id })}
          onContextMenu={(e) => {
            openContextMenu(
              e,
              [
                { label: 'Open folder', onSelect: () => setUi({ libraryFolderId: f.id }) },
                { label: 'Rename folder…', onSelect: () => void rename(f) },
                { kind: 'separator' },
                { label: 'Delete folder…', danger: true, onSelect: () => void del(f) },
              ],
              { ariaLabel: `Folder ${f.name} actions` },
            );
          }}
        >
          <span className="grow ellipsis">📁 {f.name}</span>
          <button
            type="button"
            className="ghost small"
            onClick={(e) => {
              e.stopPropagation();
              void rename(f);
            }}
          >
            ✎<span className="touch-label">Rename</span>
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={(e) => {
              e.stopPropagation();
              void del(f);
            }}
          >
            ✕<span className="touch-label">Delete</span>
          </button>
        </span>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        <input
          className="grow"
          placeholder="New folder"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addFolder()}
        />
      </div>
      {props.tags.length > 0 && (
        <>
          <h4 style={{ marginTop: 14 }}>Tags</h4>
          <div className="row wrap" style={{ gap: 4 }}>
            {props.tags.map((t) => (
              <button
                key={t}
                type="button"
                className={`small ${props.tag === t ? 'on' : ''}`}
                onClick={() => props.setTag(props.tag === t ? undefined : t)}
              >
                {t}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function PresentationsTab() {
  const lib = useLibrary((s) => s.data);
  const folderId = useUi((s) => s.libraryFolderId);
  const locked = useLockedIds();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string>();
  const [newSong, setNewSong] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(lib.presentations.map((p) => [p.id, p])), [lib.presentations]);
  const tags = useMemo(
    () => [...new Set(lib.presentations.flatMap((p) => p.meta.tags ?? []))].sort(),
    [lib.presentations],
  );
  const docs = useSearch(q, {
    kind: 'presentation',
    includeArchived: folderId === null,
    folderId: folderId ?? undefined,
    tag,
  });
  const results = useMemo(() => {
    const list = docs.map((d) => byId.get(d.id)!).filter(Boolean);
    return folderId === null ? list.filter((p) => p.archived) : list;
  }, [docs, folderId, byId]);
  const folders = lib.folders;

  const unsavedItems = useUnsaved((s) => s.items);
  const setArchived = (p: Presentation, archived: boolean) => void savePresentation({ ...p, archived });
  const move = (p: Presentation, fid: string) => void savePresentation({ ...p, folderId: fid || undefined });
  const del = async (p: Presentation) => {
    const dirtyEntry = useUnsaved.getState().items[`pres:${p.id}`];
    if (
      !(await confirmDialog(
        'Delete presentation',
        `Delete “${p.title}” and its history?${dirtyEntry ? ' Its unsaved edits will also be discarded.' : ''} Archive keeps it instead.`,
        'Delete',
        true,
      ))
    )
      return;
    try {
      await api(`/presentations/${p.id}`, { method: 'DELETE' });
      await dirtyEntry?.discard();
      removeLocal('presentations', p.id);
    } catch (e) {
      toast(`Could not delete: ${explainSaveError(e)}`, 'error');
    }
  };

  const livePlaylistId = useLivePlaylistId();
  const duplicatePresentation = async (p: Presentation) => {
    try {
      const copy: Presentation = {
        ...structuredClone(p),
        id: newId(),
        rev: 1,
        title: `${p.title} (copy)`,
      };
      const saved = await api<Presentation>('/presentations', { method: 'POST', json: copy });
      upsertLocal('presentations', saved);
      toast(`Duplicated as “${saved.title}”.`, 'ok');
    } catch (e) {
      toast(`Could not duplicate: ${explainSaveError(e)}`, 'error');
    }
  };
  const addToPlaylist = async (p: Presentation, pl: Playlist) => {
    try {
      const next: Playlist = {
        ...pl,
        items: [
          ...pl.items,
          {
            id: newId(),
            kind: 'presentation',
            presentationId: p.id,
            arrangementId: p.arrangements[0]?.id,
          },
        ],
      };
      const saved = await api<Playlist>(`/playlists/${pl.id}`, { method: 'PUT', json: next });
      upsertLocal('playlists', saved);
      toast(`Added “${p.title}” to ${pl.name}.`, 'ok');
    } catch (e) {
      toast(`Could not add to playlist: ${errorText(e)}`, 'error');
    }
  };

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selectedPres = results.find((p) => p.id === selectedId) ?? results[0];

  const listPane = (
    <div className="pl-pane">
      <div className="pl-pane-head wrap" style={{ gap: 6 }}>
        <input
          className="grow"
          style={{ minWidth: 180 }}
          autoFocus
          placeholder={`Search ${lib.presentations.length} presentations: title, lyrics, CCLI, tag…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="primary small" onClick={() => setNewSong(true)}>
          <Icon name="plus" size={12} />
          New song
        </button>
        <button
          type="button"
          className="small"
          onClick={() => void createPresentation('slides', folderId ?? undefined)}
        >
          New slides
        </button>
        <button
          type="button"
          className="small"
          onClick={() => void createPresentation('loop', folderId ?? undefined)}
        >
          New announcement loop
        </button>
      </div>
      <VirtualList
        items={results}
        style={{ flex: 1 }}
        rowHeight={(p) => (expandedId === p.id ? slidePreviewRollHeight(p, false) : 48)}
        rowClass={(p) => `${selectedPres?.id === p.id ? 'sel ' : ''}${expandedId === p.id ? 'expanded' : ''}`}
        keyOf={(p) => p.id}
        onRowClick={(p) => setSelectedId(p.id)}
        onRowContextMenu={(e, p) => {
          setSelectedId(p.id);
          const isLocked = locked.has(p.id);
          const isExpanded = expandedId === p.id;
          const editablePlaylists = lib.playlists.filter((pl) => pl.id !== livePlaylistId);
          openContextMenu(
            e,
            [
              { label: 'Edit presentation', onSelect: () => navigate({ name: 'edit', id: p.id }) },
              {
                label: isExpanded ? 'Collapse slide preview' : 'Preview slides',
                onSelect: () => setExpandedId(isExpanded ? null : p.id),
              },
              { label: 'Duplicate', onSelect: () => void duplicatePresentation(p) },
              { kind: 'separator' },
              ...(folders.length > 0
                ? [
                    {
                      kind: 'submenu' as const,
                      label: 'Move to folder',
                      disabled: isLocked,
                      items: [
                        {
                          label: 'No folder',
                          checked: !p.folderId,
                          disabled: isLocked,
                          onSelect: () => move(p, ''),
                        },
                        ...folders.map((f) => ({
                          label: f.name,
                          checked: p.folderId === f.id,
                          disabled: isLocked,
                          onSelect: () => move(p, f.id),
                        })),
                      ],
                    },
                  ]
                : []),
              ...(editablePlaylists.length > 0
                ? [
                    {
                      kind: 'submenu' as const,
                      label: 'Add to playlist',
                      items: editablePlaylists.map((pl) => ({
                        label: pl.name,
                        onSelect: () => void addToPlaylist(p, pl),
                      })),
                    },
                  ]
                : []),
              {
                label: p.archived ? 'Unarchive' : 'Archive',
                disabled: isLocked,
                onSelect: () => setArchived(p, !p.archived),
              },
              { kind: 'separator' },
              {
                label: 'Delete…',
                danger: true,
                disabled: isLocked,
                onSelect: () => void del(p),
              },
            ],
            { ariaLabel: `${p.title} actions` },
          );
        }}
        onRowDoubleClick={(p) => navigate({ name: 'edit', id: p.id })}
        render={(p) => {
          const isExpanded = expandedId === p.id;
          return (
            <>
              <div className="row" style={{ alignItems: 'center', gap: 7, width: '100%', minHeight: 34 }}>
                <button
                  type="button"
                  className="ghost icon-btn"
                  style={{ width: 20, height: 20, minHeight: 20 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(p.id);
                    setExpandedId(isExpanded ? null : p.id);
                  }}
                  title={isExpanded ? 'Collapse preview' : 'Expand slide preview'}
                  aria-label={isExpanded ? 'Collapse preview' : 'Expand slide preview'}
                >
                  <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={12} />
                </button>
                <Icon name={playlistItemIconName('presentation', p.kind)} size={13} className="muted" />
                <div
                  className="col grow"
                  style={{ gap: 0, cursor: 'pointer', minWidth: 0 }}
                  title="Click to inspect, double-click to edit"
                >
                  <span className="ellipsis row" style={{ gap: 5, alignItems: 'center' }}>
                    <b className="ellipsis">{p.title}</b>
                    {Boolean(unsavedItems[`pres:${p.id}`]) && <span className="tag amber">unsaved</span>}
                    {locked.has(p.id) && <span className="tag red">live · locked</span>}
                    {p.archived && <span className="tag">archived</span>}
                  </span>
                  <span className="muted ellipsis" style={{ fontSize: 10.5 }}>
                    {[
                      p.kind,
                      p.meta.author,
                      p.meta.ccli && `CCLI ${p.meta.ccli}`,
                      `${p.sections.length} sections`,
                      p.meta.tags?.length ? p.meta.tags.join(', ') : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <span className="row row-hover-actions" style={{ gap: 3, flexShrink: 0 }}>
                  <a className="btn small" href={`#/edit/${p.id}`} onClick={(e) => e.stopPropagation()}>
                    <Icon name="edit" size={11} />
                    Edit
                  </a>
                  <button
                    type="button"
                    className="small ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setArchived(p, !p.archived);
                    }}
                  >
                    {p.archived ? 'Unarchive' : 'Archive'}
                  </button>
                  <button
                    type="button"
                    className="ghost icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      void del(p);
                    }}
                    title="Delete"
                    aria-label="Delete"
                  >
                    <Icon name="trash" size={12} />
                    <span className="touch-label">Delete</span>
                  </button>
                </span>
              </div>
              {isExpanded && (
                <div
                  className="col"
                  style={{
                    width: '100%',
                    marginTop: 6,
                    padding: '8px 10px',
                    background: 'var(--bg)',
                    borderRadius: 3,
                    border: '1px solid var(--line)',
                    gap: 8,
                    boxSizing: 'border-box',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <SlidePreviewRoll p={p} />
                  <div
                    className="row"
                    style={{
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                      paddingTop: 6,
                      borderTop: '1px solid var(--line)',
                      gap: 6,
                      flexShrink: 0,
                    }}
                  >
                    <button type="button" className="small" onClick={() => setExpandedId(null)}>
                      Close preview
                    </button>
                    <a className="btn small primary" href={`#/edit/${p.id}`}>
                      <Icon name="edit" size={11} />
                      Open in Editor
                    </a>
                  </div>
                </div>
              )}
            </>
          );
        }}
      />
    </div>
  );

  const inspectorPane = selectedPres ? (
    <div className="pl-pane pl-pane-alt">
      <div className="pl-pane-head">
        <span className="prop-section-title ellipsis grow" style={{ margin: 0 }}>
          Presentation Inspector
        </span>
        <a className="btn small primary" href={`#/edit/${selectedPres.id}`}>
          <Icon name="edit" size={11} />
          Edit
        </a>
      </div>
      <div className="pl-pane-scroll">
        <div className="prop-section">
          <div className="prop-section-title">Slide Preview</div>
          <SlidePreviewRoll p={selectedPres} compact />
        </div>
        <div className="prop-section">
          <div className="prop-section-title">Metadata</div>
          <PropertyRow label="Kind">
            <span className="tag">{selectedPres.kind}</span>
          </PropertyRow>
          {folders.length > 0 && (
            <PropertyRow label="Folder">
              <Select
                ariaLabel="Folder"
                value={selectedPres.folderId ?? ''}
                disabled={locked.has(selectedPres.id)}
                options={[
                  { value: '', label: 'No folder' },
                  ...folders.map((f) => ({ value: f.id, label: f.name })),
                ]}
                onChange={(fid) => move(selectedPres, fid)}
              />
            </PropertyRow>
          )}
          {selectedPres.meta.author && (
            <PropertyRow label="Author">
              <span className="small">{selectedPres.meta.author}</span>
            </PropertyRow>
          )}
          {selectedPres.meta.ccli && (
            <PropertyRow label="CCLI">
              <span className="small mono">{selectedPres.meta.ccli}</span>
            </PropertyRow>
          )}
          <PropertyRow label="Sections">
            <span className="small">{selectedPres.sections.length}</span>
          </PropertyRow>
        </div>
        <div className="prop-section">
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className="small" onClick={() => void duplicatePresentation(selectedPres)}>
              <Icon name="copy" size={12} />
              Duplicate
            </button>
            <button
              type="button"
              className="small"
              disabled={locked.has(selectedPres.id)}
              onClick={() => setArchived(selectedPres, !selectedPres.archived)}
            >
              {selectedPres.archived ? 'Unarchive' : 'Archive'}
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="danger small"
              disabled={locked.has(selectedPres.id)}
              onClick={() => void del(selectedPres)}
            >
              <Icon name="trash" size={12} />
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : (
    <div className="pl-pane pl-pane-alt center muted small">Select a presentation to preview.</div>
  );

  return (
    <>
      <SplitPane
        storageKey="library-presentations"
        panels={[
          {
            id: 'folders',
            size: 192,
            min: 150,
            max: 300,
            content: <FolderSide folders={folders} tags={tags} tag={tag} setTag={setTag} />,
          },
          { id: 'pres-list', content: listPane },
          { id: 'pres-inspector', size: 296, min: 230, max: 440, content: inspectorPane },
        ]}
      />
      {newSong && <NewSongDialog onClose={() => setNewSong(false)} folderId={folderId ?? undefined} />}
    </>
  );
}

import { api, ApiFailure } from '@ordo/client';
import { DEFAULT_THEME, newId, type Presentation, type PresentationKind } from '@ordo/domain';
import type { Folder } from '@ordo/protocol';
import { useMemo, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { useLockedIds } from '../../hooks.ts';
import { removeLocal, searchIndex, upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { setUi, useUi } from '../../state/ui.ts';
import { navigate } from '../../useRoute.ts';
import { NewSongDialog } from './NewSongDialog.tsx';

export function explainSaveError(e: unknown): string {
  if (e instanceof ApiFailure && e.status === 423) return 'It is used by the live playlist and locked until End service.';
  if (e instanceof ApiFailure && e.status === 409) return 'Someone else changed it meanwhile. Reload and try again.';
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
    sections: [{ id: newId(), label: kind === 'loop' ? 'Announcements' : 'Slides', short: 'S', slides: [{ id: newId(), objects: [] }] }],
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

function FolderSide(props: { folders: Folder[]; tags: string[]; tag?: string; setTag: (t?: string) => void }) {
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
      upsertLocal('folders', await api<Folder>(`/folders/${f.id}`, { method: 'PUT', json: { ...f, name: n.trim() } }));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const del = async (f: Folder) => {
    if (!(await confirmDialog('Delete folder', `Delete “${f.name}”? Presentations in it stay in the library.`, 'Delete', true))) return;
    try {
      await api(`/folders/${f.id}`, { method: 'DELETE' });
      removeLocal('folders', f.id);
      if (folderId === f.id) setUi({ libraryFolderId: undefined });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="side col" style={{ gap: 2 }}>
      <h4>Folders</h4>
      <span className={`link ${folderId === undefined ? 'active' : ''}`} onClick={() => setUi({ libraryFolderId: undefined })}>
        All presentations
      </span>
      <span className={`link ${folderId === null ? 'active' : ''}`} onClick={() => setUi({ libraryFolderId: null })}>
        Archived
      </span>
      {props.folders.map((f) => (
        <span key={f.id} className={`link ${folderId === f.id ? 'active' : ''}`} onClick={() => setUi({ libraryFolderId: f.id })}>
          <span className="grow ellipsis">📁 {f.name}</span>
          <button type="button" className="ghost small" onClick={(e) => (e.stopPropagation(), void rename(f))}>
            ✎
          </button>
          <button type="button" className="ghost small" onClick={(e) => (e.stopPropagation(), void del(f))}>
            ✕
          </button>
        </span>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        <input className="grow" placeholder="New folder" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addFolder()} />
      </div>
      {props.tags.length > 0 && (
        <>
          <h4 style={{ marginTop: 14 }}>Tags</h4>
          <div className="row wrap" style={{ gap: 4 }}>
            {props.tags.map((t) => (
              <button key={t} type="button" className={`small ${props.tag === t ? 'on' : ''}`} onClick={() => props.setTag(props.tag === t ? undefined : t)}>
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
  searchIndex.update(lib.presentations, lib.media);
  const byId = useMemo(() => new Map(lib.presentations.map((p) => [p.id, p])), [lib.presentations]);
  const tags = useMemo(() => [...new Set(lib.presentations.flatMap((p) => p.meta.tags ?? []))].sort(), [lib.presentations]);
  const results = useMemo(() => {
    const docs = searchIndex.search(q, {
      kind: 'presentation',
      includeArchived: folderId === null,
      folderId: folderId ?? undefined,
      tag,
    });
    const list = docs.map((d) => byId.get(d.id)!).filter(Boolean);
    return folderId === null ? list.filter((p) => p.archived) : list;
  }, [q, folderId, tag, byId, lib.presentations]);
  const folders = lib.folders;

  const setArchived = (p: Presentation, archived: boolean) => void savePresentation({ ...p, archived });
  const move = (p: Presentation, fid: string) => void savePresentation({ ...p, folderId: fid || undefined });
  const del = async (p: Presentation) => {
    if (!(await confirmDialog('Delete presentation', `Delete “${p.title}” and its history? Archive keeps it instead.`, 'Delete', true))) return;
    try {
      await api(`/presentations/${p.id}`, { method: 'DELETE' });
      removeLocal('presentations', p.id);
    } catch (e) {
      toast(`Could not delete: ${explainSaveError(e)}`, 'error');
    }
  };

  return (
    <div className="split">
      <FolderSide folders={folders} tags={tags} tag={tag} setTag={setTag} />
      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
        <div className="row wrap" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
          <input
            className="grow"
            style={{ minWidth: 240 }}
            autoFocus
            placeholder={`Search ${lib.presentations.length} presentations: title, lyrics, CCLI, tag`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="button" className="primary" onClick={() => setNewSong(true)}>
            New song
          </button>
          <button type="button" onClick={() => void createPresentation('slides', folderId ?? undefined)}>
            New slides
          </button>
          <button type="button" onClick={() => void createPresentation('loop', folderId ?? undefined)}>
            New announcement loop
          </button>
        </div>
        <VirtualList
          items={results}
          rowHeight={52}
          keyOf={(p) => p.id}
          onRowDoubleClick={(p) => navigate({ name: 'edit', id: p.id })}
          render={(p) => (
            <>
              <span className="kind tag">{p.kind}</span>
              <span className="col grow" style={{ gap: 0 }}>
                <span className="ellipsis">
                  <b>{p.title}</b> {locked.has(p.id) && <span className="tag red">live · locked</span>}{' '}
                  {p.archived && <span className="tag">archived</span>}
                </span>
                <span className="muted small ellipsis">
                  {[
                    p.meta.author,
                    p.meta.ccli && `CCLI ${p.meta.ccli}`,
                    `${p.sections.length} sections`,
                    p.meta.tags?.length ? p.meta.tags.join(', ') : '',
                    p.source?.kind && p.source.kind !== 'manual' && p.source.kind !== 'paste' ? `from ${p.source.kind}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <select value={p.folderId ?? ''} onChange={(e) => move(p, e.target.value)} title="Folder" style={{ maxWidth: 140 }}>
                <option value="">No folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <a className="btn small" href={`#/edit/${p.id}`}>
                Edit
              </a>
              <button type="button" className="small" onClick={() => setArchived(p, !p.archived)}>
                {p.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button type="button" className="small ghost" onClick={() => void del(p)} title="Delete">
                🗑
              </button>
            </>
          )}
        />
      </div>
      {newSong && <NewSongDialog onClose={() => setNewSong(false)} folderId={folderId ?? undefined} />}
    </div>
  );
}

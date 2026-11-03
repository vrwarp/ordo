import { api } from '@ordo/client';
import { newId, type Playlist } from '@ordo/domain';
import { useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { useLivePlaylistId } from '../../hooks.ts';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { currentRole } from '../../state/session.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { navigate } from '../../useRoute.ts';
import { PlaylistEditor } from './PlaylistEditor.tsx';

export function PlaylistsView({ id }: { id?: string }) {
  const playlists = useLibrary((s) => s.data.playlists);
  const liveId = useLivePlaylistId();
  const [name, setName] = useState('');
  const sorted = [...playlists].sort((a, b) => (b.serviceDate ?? '').localeCompare(a.serviceDate ?? '') || a.name.localeCompare(b.name));
  const current = playlists.find((p) => p.id === id) ?? (id ? undefined : sorted[0]);
  const create = async () => {
    const n = name.trim() || `Service ${new Date().toISOString().slice(0, 10)}`;
    try {
      const p = await api<Playlist>('/playlists', {
        method: 'POST',
        json: { id: newId(), rev: 1, name: n, items: [], serviceDate: nextSunday() },
      });
      upsertLocal('playlists', p);
      setName('');
      navigate({ name: 'playlists', id: p.id });
    } catch (e) {
      toast(`Could not create playlist: ${errorText(e)}`, 'error');
    }
  };
  const duplicate = async (p: Playlist) => {
    try {
      const copy = await api<Playlist>('/playlists', {
        method: 'POST',
        json: { ...p, id: newId(), rev: 1, name: `${p.name} (copy)`, items: p.items.map((it) => ({ ...it, id: newId() })) },
      });
      upsertLocal('playlists', copy);
      navigate({ name: 'playlists', id: copy.id });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const del = async (p: Playlist) => {
    if (!(await confirmDialog('Delete playlist', `Delete “${p.name}”?`, 'Delete', true))) return;
    try {
      await api(`/playlists/${p.id}`, { method: 'DELETE' });
      removeLocal('playlists', p.id);
      navigate({ name: 'playlists' });
    } catch (e) {
      toast(`Could not delete: ${errorText(e)}`, 'error');
    }
  };
  return (
    <div className="split" style={{ gridTemplateColumns: '260px 1fr' }}>
      <div className="side col" style={{ gap: 2 }}>
        <h4>Playlists</h4>
        <div className="row" style={{ marginBottom: 8 }}>
          <input className="grow" placeholder="New playlist name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
          <button type="button" className="primary" onClick={() => void create()}>
            +
          </button>
        </div>
        {sorted.map((p) => (
          <a key={p.id} href={`#/playlists/${p.id}`} className={p.id === current?.id ? 'active' : ''}>
            <span className="col grow" style={{ gap: 0 }}>
              <span className="ellipsis">
                {p.id === liveId && <span style={{ color: 'var(--live)' }}>● </span>}
                {p.name}
              </span>
              <span className="muted small">
                {p.serviceDate ?? ''} · {p.items.length} items
              </span>
            </span>
          </a>
        ))}
      </div>
      <div style={{ minHeight: 0, overflow: 'hidden' }}>
        {current ? (
          <PlaylistEditor
            key={current.id}
            playlist={current}
            locked={current.id === liveId}
            canOperate={currentRole() === 'operate'}
            onDuplicate={() => void duplicate(current)}
            onDelete={() => void del(current)}
          />
        ) : (
          <div className="center muted">Create a playlist to start building a service.</div>
        )}
      </div>
    </div>
  );
}

function nextSunday(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return d.toISOString().slice(0, 10);
}

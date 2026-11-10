import { api } from '@ordo/client';
import { newId, type Playlist } from '@ordo/domain';
import { useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { useLivePlaylistId } from '../../hooks.ts';
import { useProfile } from '../../lib/capabilities.ts';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { currentRole } from '../../state/session.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { navigate } from '../../useRoute.ts';
import { PlaylistEditor } from './PlaylistEditor.tsx';

export function PlaylistsView({ id }: { id?: string }) {
  const playlists = useLibrary((s) => s.data.playlists);
  const liveId = useLivePlaylistId();
  const [name, setName] = useState('');
  const role = currentRole();
  // An edit-profile device (an iPad) cannot launch outputs: no Go live there, a note instead.
  const profile = useProfile(role);
  const noteGoLive = role === 'operate' && profile === 'edit';
  const sorted = [...playlists].sort(
    (a, b) => (b.serviceDate ?? '').localeCompare(a.serviceDate ?? '') || a.name.localeCompare(b.name),
  );
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
        json: {
          ...p,
          id: newId(),
          rev: 1,
          name: `${p.name} (copy)`,
          items: p.items.map((it) => ({ ...it, id: newId() })),
        },
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
  const editor = (p: Playlist) => (
    <PlaylistEditor
      key={p.id}
      playlist={p}
      locked={p.id === liveId}
      canOperate={role === 'operate' && profile === 'full'}
      onDuplicate={() => void duplicate(p)}
      onDelete={() => void del(p)}
    />
  );
  return (
    <div className="split" style={{ gridTemplateColumns: '260px 1fr' }}>
      <div className="side col" style={{ gap: 4 }}>
        <h4>Playlists</h4>
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            className="grow"
            placeholder="New playlist name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button type="button" className="primary" onClick={() => void create()}>
            +
          </button>
        </div>
        {sorted.map((p) => (
          <a key={p.id} href={`#/playlists/${p.id}`} className={p.id === current?.id ? 'active' : ''}>
            <span className="col grow" style={{ gap: 2 }}>
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
          noteGoLive ? (
            // Edit profile: a one-line note above the editor (grid rows keep the editor's height: 100%).
            <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%' }}>
              <div className="muted small go-live-note" data-go-live-note>
                Go live from the venue PC.
              </div>
              <div style={{ minHeight: 0 }}>{editor(current)}</div>
            </div>
          ) : (
            editor(current)
          )
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

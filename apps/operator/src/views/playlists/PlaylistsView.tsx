import { api } from '@ordo/client';
import { newId, type Playlist } from '@ordo/domain';
import { confirmDialog } from '../../components/Confirm.tsx';
import { PlaylistPicker } from '../../components/PlaylistPicker.tsx';
import { useLivePlaylistId } from '../../hooks.ts';
import { useProfile } from '../../lib/capabilities.ts';
import { duplicatePlaylistPayload, nextSundayIso, sortPlaylistsUpcoming } from '../../lib/playlists.ts';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { discardPlaylistDraft } from '../../state/playlistOutbox.ts';
import { currentRole } from '../../state/session.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { navigate } from '../../useRoute.ts';
import { PlaylistEditor } from './PlaylistEditor.tsx';

export function PlaylistsView({ id }: { id?: string }) {
  const playlists = useLibrary((s) => s.data.playlists);
  const liveId = useLivePlaylistId();
  const role = currentRole();
  // An edit-profile device (an iPad) cannot launch outputs: no Go live there, a note instead.
  const profile = useProfile(role);
  const noteGoLive = role === 'operate' && profile === 'edit';
  const sorted = sortPlaylistsUpcoming(playlists);
  const current = playlists.find((p) => p.id === id) ?? (id ? undefined : sorted[0]);

  const create = async (rawName: string) => {
    const n = rawName.trim() || `Service ${new Date().toISOString().slice(0, 10)}`;
    try {
      const p = await api<Playlist>('/playlists', {
        method: 'POST',
        json: { id: newId(), rev: 1, name: n, items: [], serviceDate: nextSundayIso() },
      });
      upsertLocal('playlists', p);
      navigate({ name: 'playlists', id: p.id });
    } catch (e) {
      toast(`Could not create playlist: ${errorText(e)}`, 'error');
    }
  };

  const duplicate = async (p: Playlist) => {
    try {
      const copy = await api<Playlist>('/playlists', {
        method: 'POST',
        json: duplicatePlaylistPayload(p),
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
      discardPlaylistDraft(p.id);
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
      <PlaylistPicker
        variant="sidebar"
        playlists={playlists}
        selectedId={current?.id}
        liveId={liveId}
        onSelect={(pid) => navigate({ name: 'playlists', id: pid })}
        onCreate={(rawName) => void create(rawName)}
        onDuplicate={(p) => void duplicate(p)}
        onDelete={(p) => void del(p)}
      />
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

import { api, fileUrl } from '@ordo/client';
import { formatDuration, type Media } from '@ordo/domain';
import { PreviewPlayer } from '@ordo/audio';
import { useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { useLockedIds } from '../../hooks.ts';
import { stillHash } from '../../services/thumbs.ts';
import { uploadMedia } from '../../services/upload.ts';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { useSearch } from '../../services/search.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { create } from 'zustand';

type UploadRow = { id: number; name: string; frac: number; error?: string; done?: boolean };
export const useUploads = create<{ list: UploadRow[] }>(() => ({ list: [] }));
let uploadSeq = 0;

/** Upload files one after another with per-file progress; returns the created media. */
export async function uploadFiles(files: File[], opts: { isBackground?: boolean } = {}): Promise<Media[]> {
  const out: Media[] = [];
  for (const f of files) {
    const id = ++uploadSeq;
    const set = (patch: Partial<UploadRow>) =>
      useUploads.setState((s) => ({ list: s.list.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
    useUploads.setState((s) => ({
      list: [...s.list.filter((r) => !r.done).slice(-20), { id, name: f.name, frac: 0 }],
    }));
    try {
      const m = await uploadMedia(f, opts, (frac) => set({ frac }));
      upsertLocal('media', m);
      out.push(m);
      set({ frac: 1, done: true });
    } catch (e) {
      set({ error: errorText(e) });
      toast(`Upload of ${f.name} failed: ${errorText(e)}`, 'error', 10000);
    }
  }
  return out;
}

export function UploadProgress() {
  const list = useUploads((s) => s.list);
  if (!list.length) return null;
  return (
    <div className="col" style={{ gap: 4 }}>
      {list.map((r) => (
        <div key={r.id} className="row small">
          <span className="ellipsis" style={{ width: 220 }}>
            {r.name}
          </span>
          <div className="progress grow">
            <i
              style={{
                width: `${Math.round(r.frac * 100)}%`,
                background: r.error ? 'var(--red)' : undefined,
              }}
            />
          </div>
          <span className="muted" style={{ width: 120 }}>
            {r.error ? 'failed' : r.done ? 'uploaded' : `${Math.round(r.frac * 100)}%`}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DropZone(props: { onFiles: (f: File[]) => void; accept?: string; label?: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`drop ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) props.onFiles(files);
      }}
      onClick={() => input.current?.click()}
      style={{ cursor: 'pointer' }}
    >
      {props.label ?? 'Drop files here or click to choose'}
      <input
        ref={input}
        type="file"
        multiple
        accept={props.accept}
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) props.onFiles(files);
        }}
      />
    </div>
  );
}

export const MEDIA_ACCEPT = 'video/*,image/*,audio/*,.mov,.mp4,.webm,.gif,.wav,.mp3,.aac,.flac,.ogg,.m4a';

export function stateTag(m: Media) {
  const cls = m.state === 'ready' ? 'green' : m.state === 'failed' ? 'red' : 'amber';
  const label = m.state === 'uploaded' ? 'queued' : m.state;
  return (
    <span className={`tag ${cls}`} title={m.error}>
      {label}
    </span>
  );
}

let preview: PreviewPlayer | undefined;
function previewPlayer(): PreviewPlayer {
  const dev = useLibrary.getState().data.settings.audio.previewDeviceId;
  if (!preview) preview = new PreviewPlayer(dev);
  else preview.setDevice(dev);
  return preview;
}

function MediaPreview({ m, onClose }: { m: Media; onClose: () => void }) {
  const f = m.delivery ?? m.original;
  return (
    <Dialog title={m.name} onClose={onClose} width={760}>
      {m.kind === 'image' && <img src={fileUrl(f.hash)} alt={m.name} style={{ width: '100%' }} />}
      {m.kind === 'video' && (
        // Muted: the operator auditions audio only on the preview device (prd/06).
        <video
          src={fileUrl(f.hash)}
          poster={m.poster ? fileUrl(m.poster.hash) : undefined}
          controls
          muted
          style={{ width: '100%' }}
        />
      )}
      {m.kind === 'audio' && <span className="muted">Audio plays on the preview device.</span>}
      <div className="muted small" style={{ marginTop: 8 }}>
        {m.width && m.height ? `${m.width}×${m.height} · ` : ''}
        {m.durationMs ? formatDuration(m.durationMs) : ''} {m.hasAlpha ? '· alpha' : ''}{' '}
        {m.audio?.loudnessLufs !== undefined ? `· ${m.audio.loudnessLufs.toFixed(1)} LUFS` : ''}
      </div>
    </Dialog>
  );
}

export function MediaTab() {
  const lib = useLibrary((s) => s.data);
  const pairs = lib.settings.audio.pairs;
  const locked = useLockedIds();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | Media['kind']>('');
  const [bgOnly, setBgOnly] = useState(false);
  const [asBackground, setAsBackground] = useState(false);
  const [previewing, setPreviewing] = useState<Media>();
  const [playing, setPlaying] = useState<string>();
  const byId = useMemo(() => new Map(lib.media.map((m) => [m.id, m])), [lib.media]);
  const docs = useSearch(q, { kind: 'media' });
  const list = useMemo(
    () =>
      docs
        .map((d) => byId.get(d.id)!)
        .filter((m) => m && (!kind || m.kind === kind) && (!bgOnly || m.isBackground)),
    [docs, kind, bgOnly, byId],
  );
  const patch = async (m: Media, p: Record<string, unknown>) => {
    try {
      upsertLocal('media', await api<Media>(`/media/${m.id}`, { method: 'PUT', json: { ...p, rev: m.rev } }));
    } catch (e) {
      toast(`Could not update ${m.name}: ${errorText(e)}`, 'error');
    }
  };
  const del = async (m: Media) => {
    if (!(await confirmDialog('Delete media', `Delete “${m.name}”?`, 'Delete', true))) return;
    try {
      await api(`/media/${m.id}`, { method: 'DELETE' });
      removeLocal('media', m.id);
    } catch (e) {
      toast(`Could not delete: ${errorText(e)}`, 'error');
    }
  };
  const audition = async (m: Media) => {
    const p = previewPlayer();
    if (playing === m.id) {
      p.stop();
      setPlaying(undefined);
      return;
    }
    const f = m.delivery ?? m.original;
    try {
      await p.play(fileUrl(f.hash), m.audio?.gainDb ?? 0);
      setPlaying(m.id);
    } catch (e) {
      toast(`Preview failed: ${errorText(e)}`, 'error');
    }
  };
  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%' }}>
      <div className="col" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
        <div className="row wrap">
          <input
            className="grow"
            placeholder="Search media"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={kind} onChange={(e) => setKind(e.target.value as '' | Media['kind'])}>
            <option value="">All kinds</option>
            <option value="video">Video</option>
            <option value="image">Images</option>
            <option value="audio">Audio</option>
          </select>
          <label className="check">
            <input type="checkbox" checked={bgOnly} onChange={(e) => setBgOnly(e.target.checked)} />{' '}
            Backgrounds only
          </label>
        </div>
        <div className="row">
          <div className="grow">
            <DropZone
              accept={MEDIA_ACCEPT}
              label="Drop video, images or audio here (or click). Large files resume if interrupted."
              onFiles={(f) => void uploadFiles(f, { isBackground: asBackground })}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={asBackground}
              onChange={(e) => setAsBackground(e.target.checked)}
            />{' '}
            Upload as backgrounds
          </label>
        </div>
        <UploadProgress />
      </div>
      <VirtualList
        items={list}
        rowHeight={64}
        keyOf={(m) => m.id}
        render={(m) => {
          const still = stillHash(m);
          return (
            <>
              <div
                style={{
                  width: 96,
                  height: 54,
                  borderRadius: 4,
                  background: still ? `#000 center/cover url(${fileUrl(still)})` : '#000',
                  flex: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                }}
                onClick={() => setPreviewing(m)}
              >
                {!still && (m.kind === 'audio' ? '♫' : '▶')}
              </div>
              <span className="col grow" style={{ gap: 2 }}>
                <span className="row" style={{ gap: 6 }}>
                  <b className="ellipsis">{m.name}</b> {stateTag(m)} {locked.size > 0 && null}
                </span>
                <span className="muted small">
                  {m.kind}
                  {m.durationMs ? ` · ${formatDuration(m.durationMs)}` : ''}
                  {m.width ? ` · ${m.width}×${m.height}` : ''}
                  {m.error ? ` · ${m.error}` : ''}
                </span>
              </span>
              {m.kind !== 'audio' && (
                <label className="check small" title="Show in the background picker">
                  <input
                    type="checkbox"
                    checked={m.isBackground}
                    onChange={(e) => void patch(m, { isBackground: e.target.checked })}
                  />{' '}
                  Background
                </label>
              )}
              {m.kind !== 'image' && (
                <label className="check small">
                  <input
                    type="checkbox"
                    checked={m.loop}
                    onChange={(e) => void patch(m, { loop: e.target.checked })}
                  />{' '}
                  Loop
                </label>
              )}
              {m.kind !== 'image' && (
                <>
                  <select
                    value={m.audio?.pairId ?? ''}
                    title="Audio output pair"
                    onChange={(e) =>
                      void patch(m, {
                        audio: { pairId: e.target.value || undefined, gainDb: m.audio?.gainDb ?? 0 },
                      })
                    }
                  >
                    <option value="">Default pair</option>
                    {pairs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    title="Gain (dB)"
                    style={{ width: 64 }}
                    defaultValue={m.audio?.gainDb ?? 0}
                    step={1}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v !== (m.audio?.gainDb ?? 0))
                        void patch(m, { audio: { pairId: m.audio?.pairId, gainDb: v } });
                    }}
                  />
                  <button
                    type="button"
                    className="small"
                    disabled={m.state !== 'ready' && m.kind !== 'audio'}
                    onClick={() => void audition(m)}
                    title="Audition on the preview device"
                  >
                    {playing === m.id ? '■' : '🎧'}
                  </button>
                </>
              )}
              <button
                type="button"
                className="small ghost"
                onClick={() => {
                  const n = prompt('Name', m.name);
                  if (n?.trim()) void patch(m, { name: n.trim() });
                }}
              >
                ✎
              </button>
              {m.state === 'failed' && (
                <button
                  type="button"
                  className="small"
                  onClick={() =>
                    void api(`/media/${m.id}/retry`, { method: 'POST' }).catch((e) =>
                      toast(errorText(e), 'error'),
                    )
                  }
                >
                  Retry
                </button>
              )}
              <button type="button" className="small ghost" onClick={() => void del(m)}>
                🗑
              </button>
            </>
          );
        }}
      />
      {previewing && <MediaPreview m={previewing} onClose={() => setPreviewing(undefined)} />}
    </div>
  );
}

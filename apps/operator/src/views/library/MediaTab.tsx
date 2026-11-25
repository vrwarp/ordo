import { ApiFailure, api, fileUrl } from '@ordo/client';
import { formatDuration, type Media, type MidiTrigger } from '@ordo/domain';
import { PreviewPlayer } from '@ordo/audio';
import { useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { confirmDialog } from '../../components/Confirm.tsx';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { Check, NumberField, PropertyRow, SegmentedControl, Select } from '../../components/fields.tsx';
import { Icon } from '../../components/Icons.tsx';
import { midiTriggerBadge, shouldShowMidiUi } from '../../components/MidiTriggerPicker.tsx';
import { useCoarsePointer } from '../../components/pointer.ts';
import { SplitPane } from '../../components/SplitPane.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { useLockedIds } from '../../hooks.ts';
import {
  isPresentationPicture,
  mediaInUseText,
  playlistsUsing,
  presentationsUsing,
} from '../../lib/mediaUse.ts';
import { useSearch } from '../../services/search.ts';
import { svgNote, tileHash } from '../../services/thumbs.ts';
import { uploadMedia } from '../../services/upload.ts';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';

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

/**
 * Drop files or click to choose. Kept exported for ImportTab / FontsTab / compact reuse.
 */
export function DropZone(props: {
  onFiles: (f: File[]) => void;
  accept?: string;
  label?: string;
  touchLabel?: string;
  touchAccept?: string;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const coarse = useCoarsePointer();
  if (coarse)
    return (
      <div className="drop touch">
        <button type="button" className="primary" onClick={() => input.current?.click()}>
          {props.touchLabel ?? 'Choose files'}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={props.touchAccept ?? props.accept}
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) props.onFiles(files);
          }}
        />
      </div>
    );
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

export const MEDIA_ACCEPT =
  'video/*,image/*,audio/*,.mov,.mp4,.m4v,.webm,.gif,.jpg,.jpeg,.png,.webp,.wav,.mp3,.aac,.flac,.ogg,.m4a';

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

/** A media item's preview dialog (a sheet on the compact layout, where the phone's Media tab opens it). */
export function MediaPreview({ m, onClose }: { m: Media; onClose: () => void }) {
  const f = svgNote(m) ? m.original : (m.delivery ?? m.original);
  return (
    <Dialog title={m.name} onClose={onClose} width={760}>
      {m.kind === 'image' && <img src={fileUrl(f.hash)} alt={m.name} style={{ width: '100%' }} />}
      {m.kind === 'video' && (
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
      {svgNote(m) && <div className="muted small">{svgNote(m)}</div>}
    </Dialog>
  );
}

export function MediaTab() {
  const lib = useLibrary((s) => s.data);
  const coarse = useCoarsePointer();
  const pairs = lib.settings.audio.pairs;
  const locked = useLockedIds();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | Media['kind']>('');
  const [bgOnly, setBgOnly] = useState(false);
  const [showPictures, setShowPictures] = useState(false);
  const [asBackground, setAsBackground] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [tileSize, setTileSize] = useState(168);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [dragOver, setDragOver] = useState(false);
  const [previewing, setPreviewing] = useState<Media>();
  const [playing, setPlaying] = useState<string>();

  const byId = useMemo(() => new Map(lib.media.map((m) => [m.id, m])), [lib.media]);
  const docs = useSearch(q, { kind: 'media' });
  const list = useMemo(
    () =>
      docs
        .map((d) => byId.get(d.id)!)
        .filter(
          (m) =>
            m &&
            (!kind || m.kind === kind) &&
            (!bgOnly || m.isBackground) &&
            (showPictures || !isPresentationPicture(m)),
        ),
    [docs, kind, bgOnly, showPictures, byId],
  );

  const selected = list.find((m) => m.id === selectedId) ?? list[0];

  const handleUpload = async (files: File[]) => {
    const added = await uploadFiles(files, { isBackground: asBackground });
    if (added[0]) setSelectedId(added[0].id);
  };

  const patch = async (m: Media, p: Record<string, unknown>) => {
    try {
      upsertLocal('media', await api<Media>(`/media/${m.id}`, { method: 'PUT', json: { ...p, rev: m.rev } }));
    } catch (e) {
      toast(`Could not update ${m.name}: ${errorText(e)}`, 'error');
    }
  };

  const del = async (m: Media) => {
    const users = presentationsUsing(m.id, lib.presentations);
    const lists = playlistsUsing(m.id, lib.playlists);
    const used = users.length + lists.length > 0;
    const ask = used ? mediaInUseText(m.name, users, lists) : `Delete “${m.name}”?`;
    if (!(await confirmDialog('Delete media', ask, 'Delete', true))) return;
    const remove = (force: boolean) => api(`/media/${m.id}${force ? '?force=1' : ''}`, { method: 'DELETE' });
    try {
      try {
        await remove(used);
      } catch (e) {
        if (!(e instanceof ApiFailure && e.code === 'media_in_use')) throw e;
        if (!(await confirmDialog('Delete media', `${e.message} Delete it anyway?`, 'Delete', true))) return;
        await remove(true);
      }
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

  const openMediaMenu = (e: React.MouseEvent, m: Media) => {
    setSelectedId(m.id);
    openContextMenu(
      e,
      [
        { label: 'Preview', onSelect: () => setPreviewing(m) },
        ...(m.kind !== 'image'
          ? [
              {
                label: playing === m.id ? 'Stop audio preview' : 'Audition audio',
                onSelect: () => void audition(m),
              },
            ]
          : []),
        { kind: 'separator' },
        ...(m.kind !== 'audio'
          ? [
              {
                label: 'Show in background picker',
                checked: m.isBackground,
                onSelect: () => void patch(m, { isBackground: !m.isBackground }),
              },
            ]
          : []),
        ...(m.kind !== 'image'
          ? [
              {
                label: 'Loop playback',
                checked: m.loop,
                onSelect: () => void patch(m, { loop: !m.loop }),
              },
            ]
          : []),
        ...(m.state === 'failed'
          ? [
              { kind: 'separator' as const },
              {
                label: 'Retry processing',
                onSelect: () =>
                  void api(`/media/${m.id}/retry`, { method: 'POST' }).catch((err) =>
                    toast(errorText(err), 'error'),
                  ),
              },
            ]
          : []),
        { kind: 'separator' },
        { label: 'Delete…', danger: true, onSelect: () => void del(m) },
      ],
      { ariaLabel: `${m.name} media actions` },
    );
  };

  const browserPane = (
    <div
      className="pl-pane"
      style={{ position: 'relative' }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) void handleUpload(files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={MEDIA_ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void handleUpload(files);
        }}
      />
      <div className="pl-pane-head wrap" style={{ gap: 6 }}>
        <input
          className="grow"
          style={{ minWidth: 150, maxWidth: 260 }}
          placeholder="Search media…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <SegmentedControl<'' | Media['kind']>
          size="xs"
          ariaLabel="Filter media kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: '', label: 'All' },
            { value: 'video', label: 'Video' },
            { value: 'image', label: 'Images' },
            { value: 'audio', label: 'Audio' },
          ]}
        />
        <label className="check small" style={{ gap: 5 }}>
          <input type="checkbox" checked={bgOnly} onChange={(e) => setBgOnly(e.target.checked)} />
          Backgrounds
        </label>
        <label
          className="check small"
          style={{ gap: 5 }}
          title="Pages and pictures that imports made for presentations"
        >
          <input type="checkbox" checked={showPictures} onChange={(e) => setShowPictures(e.target.checked)} />
          Slide pictures
        </label>
        <span className="spacer" />
        {viewMode === 'grid' && (
          <input
            type="range"
            min={120}
            max={260}
            step={16}
            value={tileSize}
            onChange={(e) => setTileSize(Number(e.target.value))}
            title="Thumbnail size"
            aria-label="Media thumbnail size"
            style={{ width: 72 }}
          />
        )}
        <SegmentedControl<'grid' | 'list'>
          size="xs"
          ariaLabel="Media view mode"
          value={viewMode}
          onChange={setViewMode}
          options={[
            { value: 'grid', label: <Icon name="grid" size={12} />, title: 'Grid view' },
            { value: 'list', label: <Icon name="list" size={12} />, title: 'List view' },
          ]}
        />
        <label className="check small" style={{ gap: 4 }} title="Mark newly uploaded files as backgrounds">
          <input type="checkbox" checked={asBackground} onChange={(e) => setAsBackground(e.target.checked)} />
          As bg
        </label>
        <button type="button" className="primary small" onClick={() => fileInputRef.current?.click()}>
          <Icon name="upload" size={12} />
          {coarse ? 'Choose video, images or audio' : 'Import media'}
        </button>
      </div>

      <div style={{ padding: '0 8px' }}>
        <UploadProgress />
      </div>

      {viewMode === 'grid' ? (
        <div className="pl-pane-scroll">
          <div
            className="media-grid"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))` }}
          >
            {list.map((m) => {
              const still = tileHash(m);
              const note = svgNote(m);
              const isSel = selected?.id === m.id;
              return (
                <div
                  key={m.id}
                  className={`media-tile${isSel ? ' sel' : ''}`}
                  onClick={() => setSelectedId(m.id)}
                  onDoubleClick={() => setPreviewing(m)}
                  onContextMenu={(e) => openMediaMenu(e, m)}
                >
                  <div
                    className="media-tile-thumb"
                    style={
                      still
                        ? { background: `#07080a center/cover no-repeat url(${fileUrl(still)})` }
                        : undefined
                    }
                  >
                    {!still && <Icon name={m.kind === 'audio' ? 'audio' : 'video'} size={22} />}
                    <div className="media-tile-badges">
                      {m.state !== 'ready' && stateTag(m)}
                      {m.isBackground && (
                        <span className="tag" style={{ background: 'rgba(0,0,0,0.65)', color: '#fff' }}>
                          BG
                        </span>
                      )}
                      {m.durationMs && (
                        <span
                          className="tag mono"
                          style={{ background: 'rgba(0,0,0,0.65)', color: '#e7eaee' }}
                        >
                          {formatDuration(m.durationMs)}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="col media-tile-cap">
                    <b className="ellipsis">{m.name}</b>
                    <span className="muted ellipsis" style={{ fontSize: 10 }}>
                      {m.kind}
                      {m.width ? ` · ${m.width}×${m.height}` : ''}
                      {note && (
                        <span title={note} data-svg-note>
                          {' '}
                          · SVG: a still on screens, moves in previews only
                        </span>
                      )}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          {list.length === 0 && (
            <div className="center muted small" style={{ padding: 32 }}>
              Drop video, images, or audio anywhere here — or click Import media.
            </div>
          )}
        </div>
      ) : (
        <VirtualList
          items={list}
          rowHeight={coarse ? 64 : 44}
          style={{ flex: 1 }}
          keyOf={(m) => m.id}
          rowClass={(m) => (selected?.id === m.id ? 'sel' : '')}
          onRowClick={(m) => setSelectedId(m.id)}
          onRowDoubleClick={(m) => setPreviewing(m)}
          onRowContextMenu={openMediaMenu}
          render={(m) => {
            const still = tileHash(m);
            const note = svgNote(m);
            return (
              <>
                <div
                  style={{
                    width: 56,
                    height: 32,
                    borderRadius: 3,
                    background: still ? `#000 center/cover url(${fileUrl(still)})` : '#07080a',
                    flex: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px solid var(--line)',
                  }}
                >
                  {!still && (
                    <Icon name={m.kind === 'audio' ? 'audio' : 'video'} size={14} className="muted" />
                  )}
                </div>
                <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <b className="ellipsis">{m.name}</b>
                    {m.state !== 'ready' && stateTag(m)}
                    {m.isBackground && <span className="tag">BG</span>}
                  </span>
                  <span className="muted" style={{ fontSize: 10.5 }}>
                    {m.kind}
                    {m.durationMs ? ` · ${formatDuration(m.durationMs)}` : ''}
                    {m.width ? ` · ${m.width}×${m.height}` : ''}
                    {note && (
                      <span title={note} data-svg-note>
                        {' '}
                        · SVG: a still on screens, moves in previews only
                      </span>
                    )}
                  </span>
                </span>
              </>
            );
          }}
        />
      )}

      {dragOver && (
        <div className="drop-overlay">
          <Icon name="upload" size={28} />
          <b>Drop video, images, or audio to import</b>
        </div>
      )}
    </div>
  );

  const inspectorPane = selected ? (
    <div className="pl-pane pl-pane-alt">
      <div className="pl-pane-head">
        <span className="prop-section-title" style={{ margin: 0 }}>
          Media Inspector
        </span>
        <span className="spacer" />
        <button type="button" className="small" onClick={() => setPreviewing(selected)}>
          <Icon name="eye" size={12} />
          Preview
        </button>
      </div>
      <div className="pl-pane-scroll">
        <div style={{ padding: 8, borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}>
          <div
            className="media-tile-thumb"
            style={{
              borderRadius: 3,
              border: '1px solid var(--line)',
              cursor: 'pointer',
              ...(tileHash(selected)
                ? { backgroundImage: `url(${fileUrl(tileHash(selected)!)})` }
                : undefined),
            }}
            onClick={() => setPreviewing(selected)}
          >
            {!tileHash(selected) && <Icon name={selected.kind === 'audio' ? 'audio' : 'video'} size={24} />}
          </div>
          <div className="col" style={{ gap: 2, marginTop: 6 }}>
            <b className="ellipsis" style={{ fontSize: 12.5 }}>
              {selected.name}
            </b>
            <span className="muted" style={{ fontSize: 11 }}>
              {selected.kind}
              {selected.width && selected.height ? ` · ${selected.width}×${selected.height}` : ''}
              {selected.durationMs ? ` · ${formatDuration(selected.durationMs)}` : ''}
              {selected.hasAlpha ? ' · alpha' : ''}
            </span>
            {svgNote(selected) && (
              <span className="muted" style={{ fontSize: 10.5 }} data-svg-note>
                {svgNote(selected)}
              </span>
            )}
          </div>
        </div>

        <div className="prop-section">
          <div className="prop-section-title">Properties</div>
          {selected.kind !== 'audio' && (
            <PropertyRow label="Background">
              <Check
                label="Show in background picker"
                value={selected.isBackground}
                onChange={(isBackground) => void patch(selected, { isBackground })}
              />
            </PropertyRow>
          )}
          {selected.kind !== 'image' && (
            <PropertyRow label="Loop">
              <Check
                label="Loop playback"
                value={selected.loop}
                onChange={(loop) => void patch(selected, { loop })}
              />
            </PropertyRow>
          )}
          {selected.kind !== 'audio' && shouldShowMidiUi(lib.settings.surfaces, Boolean(selected.midi)) && (
            <PropertyRow label="Bg lighting">
              {(() => {
                const midiPresets = lib.settings.surfaces.midiPresets ?? [];
                const selectedMidiId = selected.midi?.kind === 'preset' ? selected.midi.presetId : '';
                const isCustom = selected.midi?.kind === 'cues';
                const missing = Boolean(selectedMidiId && !midiPresets.some((p) => p.id === selectedMidiId));
                return (
                  <Select
                    ariaLabel="Linked lighting (when used as background)"
                    value={isCustom ? '__custom' : selectedMidiId}
                    options={[
                      { value: '', label: 'None' },
                      ...midiPresets.map((p) => ({ value: p.id, label: p.name })),
                      ...(missing ? [{ value: selectedMidiId, label: '(missing preset)' }] : []),
                      ...(isCustom ? [{ value: '__custom', label: 'Custom MIDI' }] : []),
                    ]}
                    onChange={(v) => {
                      if (v === '__custom') return;
                      const nextMidi: MidiTrigger | null = v ? { kind: 'preset', presetId: v } : null;
                      void patch(selected, { midi: nextMidi });
                    }}
                  />
                );
              })()}
            </PropertyRow>
          )}
          {selected.kind !== 'image' && (
            <>
              <PropertyRow label="Audio pair">
                <Select
                  ariaLabel="Audio output pair"
                  value={selected.audio?.pairId ?? ''}
                  options={[
                    { value: '', label: 'Default pair' },
                    ...pairs.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={(pairId) =>
                    void patch(selected, {
                      audio: { pairId: pairId || undefined, gainDb: selected.audio?.gainDb ?? 0 },
                    })
                  }
                />
              </PropertyRow>
              <PropertyRow label="Gain">
                <NumberField
                  value={selected.audio?.gainDb ?? 0}
                  min={-40}
                  max={20}
                  step={1}
                  suffix="dB"
                  stepper
                  width={58}
                  onChange={(gainDb) =>
                    void patch(selected, { audio: { pairId: selected.audio?.pairId, gainDb } })
                  }
                />
              </PropertyRow>
            </>
          )}
        </div>

        <div className="prop-section">
          <div className="row wrap" style={{ gap: 6 }}>
            {selected.kind !== 'image' && (
              <button type="button" className="small" onClick={() => void audition(selected)}>
                <Icon name={playing === selected.id ? 'pause' : 'play'} size={12} />
                {playing === selected.id ? 'Stop audition' : 'Audition'}
              </button>
            )}
            {selected.state === 'failed' && (
              <button
                type="button"
                className="small"
                onClick={() =>
                  void api(`/media/${selected.id}/retry`, { method: 'POST' }).catch((err) =>
                    toast(errorText(err), 'error'),
                  )
                }
              >
                Retry
              </button>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="danger small"
              disabled={locked.has(selected.id)}
              onClick={() => void del(selected)}
            >
              <Icon name="trash" size={12} />
              Delete
            </button>
          </div>
          {selected.midi &&
            (() => {
              const b = midiTriggerBadge(selected.midi, lib.settings.surfaces.midiPresets);
              if (!b) return null;
              return (
                <span className="muted" style={{ fontSize: 10.5 }}>
                  Linked lighting: {b.label}
                </span>
              );
            })()}
        </div>
      </div>
    </div>
  ) : (
    <div className="pl-pane pl-pane-alt center muted small">Select a media item to inspect.</div>
  );

  return (
    <>
      <SplitPane
        storageKey="library-media"
        panels={[
          { id: 'media-bin', content: browserPane },
          { id: 'media-inspector', size: 286, min: 230, max: 420, content: inspectorPane },
        ]}
      />
      {previewing && <MediaPreview m={previewing} onClose={() => setPreviewing(undefined)} />}
    </>
  );
}

import { fileUrl } from '@ordo/client';
import type { Media } from '@ordo/domain';
import { useMemo, useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { stillHash } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import { DropZone, MEDIA_ACCEPT, uploadFiles, UploadProgress } from '../library/MediaTab.tsx';

/** Pick a media item (backgrounds first) with poster thumbnails; upload new ones inline (prd/05). */
export function MediaPickerDialog(props: {
  title: string;
  onPick: (m: Media) => void;
  onClose: () => void;
  kinds?: Media['kind'][];
  backgroundsFirst?: boolean;
}) {
  const media = useLibrary((s) => s.data.media);
  const [q, setQ] = useState('');
  const [all, setAll] = useState(!props.backgroundsFirst);
  const list = useMemo(
    () =>
      media.filter(
        (m) =>
          (!props.kinds || props.kinds.includes(m.kind)) &&
          (all || m.isBackground) &&
          (!q || m.name.toLowerCase().includes(q.toLowerCase())),
      ),
    [media, q, all, props.kinds],
  );
  return (
    <Dialog title={props.title} onClose={props.onClose} width={900}>
      <div className="col">
        <div className="row">
          <input
            className="grow"
            placeholder="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          {props.backgroundsFirst && (
            <label className="check">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all
              media
            </label>
          )}
        </div>
        <DropZone
          accept={MEDIA_ACCEPT}
          label="Drop files to upload (they appear below; videos are usable once processed)"
          onFiles={(f) => void uploadFiles(f, { isBackground: !!props.backgroundsFirst })}
        />
        <UploadProgress />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 8,
            maxHeight: 460,
            overflow: 'auto',
          }}
        >
          {list.map((m) => {
            const h = stillHash(m);
            return (
              <div key={m.id} className="thumb" onClick={() => props.onPick(m)} title={m.name}>
                <div className="img" style={{ backgroundImage: h ? `url(${fileUrl(h)})` : undefined }} />
                <div className="cap">
                  <span className="ellipsis grow">{m.name}</span>
                  {m.state !== 'ready' && <span className="tag amber">{m.state}</span>}
                </div>
              </div>
            );
          })}
        </div>
        {!list.length && <span className="muted">No media here yet.</span>}
      </div>
    </Dialog>
  );
}

export function BackgroundPicker(props: {
  value?: string;
  onChange: (id: string | undefined) => void;
  disabled?: boolean;
}) {
  const media = useLibrary((s) => s.data.media);
  const [open, setOpen] = useState(false);
  const m = props.value ? media.find((x) => x.id === props.value) : undefined;
  const h = stillHash(m);
  return (
    <div className="row">
      <div
        style={{
          width: 96,
          height: 54,
          borderRadius: 4,
          border: '1px solid var(--line)',
          background: h ? `#000 center/cover url(${fileUrl(h)})` : '#000',
        }}
      />
      <span className="grow ellipsis small">{m ? m.name : props.value ? 'Missing media' : 'None'}</span>
      <button type="button" className="small" disabled={props.disabled} onClick={() => setOpen(true)}>
        Choose
      </button>
      {props.value && (
        <button
          type="button"
          className="small"
          disabled={props.disabled}
          onClick={() => props.onChange(undefined)}
        >
          None
        </button>
      )}
      {open && (
        <MediaPickerDialog
          title="Choose a background"
          kinds={['video', 'image']}
          backgroundsFirst
          onClose={() => setOpen(false)}
          onPick={(x) => {
            props.onChange(x.id);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

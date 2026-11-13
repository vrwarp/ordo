import { fileUrl } from '@ordo/client';
import type { Media } from '@ordo/domain';
import { useMemo, useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { filesForKinds, kindsText, mediaAccept } from '../../lib/mediaKinds.ts';
import { stillHash } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import { toast } from '../../state/toasts.ts';
import { DropZone, MEDIA_ACCEPT, uploadFiles, UploadProgress } from '../library/MediaTab.tsx';

/**
 * Why a media item cannot be chosen yet in a picker that needs its size (`needsSize`: 'Replace' and the
 * background replace crop the new picture to the box from its width and height, so one the hub has not read
 * yet would be stretched): undefined when it can be.
 */
export function notChoosable(
  m: Pick<Media, 'state' | 'width' | 'height'>,
  needsSize: boolean,
): string | undefined {
  if (!needsSize) return undefined;
  if (m.state === 'failed') return 'It could not be processed.';
  if (!(m.width && m.width > 0 && m.height && m.height > 0))
    return 'Still being processed: it can be chosen when it is ready.';
  return undefined;
}

/**
 * Pick a media item (backgrounds first) with poster thumbnails; upload new ones inline (prd/05). With `kinds`
 * it lists, opens and uploads only those kinds: an image picker takes images only (design/27 §11 item 6).
 * With `needsSize` an item whose size is not known yet (just uploaded, still processing) is listed but cannot
 * be chosen until it is (`notChoosable`). Each thumbnail is a button named by the media name.
 */
export function MediaPickerDialog(props: {
  title: string;
  onPick: (m: Media) => void;
  onClose: () => void;
  kinds?: Media['kind'][];
  backgroundsFirst?: boolean;
  needsSize?: boolean;
}) {
  const media = useLibrary((s) => s.data.media);
  const [q, setQ] = useState('');
  const [all, setAll] = useState(!props.backgroundsFirst);
  const [kindFilter, setKindFilter] = useState<'all' | 'image' | 'video'>('all');
  const showKindTabs = !props.kinds || props.kinds.length > 1;
  const list = useMemo(
    () =>
      media.filter(
        (m) =>
          (!props.kinds || props.kinds.includes(m.kind)) &&
          (!showKindTabs || kindFilter === 'all' || m.kind === kindFilter) &&
          (all || m.isBackground) &&
          (!q || m.name.toLowerCase().includes(q.toLowerCase())),
      ),
    [media, q, all, props.kinds, showKindTabs, kindFilter],
  );
  return (
    <Dialog title={props.title} onClose={props.onClose} width={900}>
      <div className="col">
        <div className="row wrap">
          <input
            className="grow"
            placeholder="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          {showKindTabs && (
            <div className="ed-seg-bar" role="group" aria-label="Filter media type">
              {(
                [
                  ['all', 'All'],
                  ['image', 'Images'],
                  ['video', 'Videos'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={`small${kindFilter === k ? ' on' : ''}`}
                  onClick={() => setKindFilter(k)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {props.backgroundsFirst && (
            <label className="check">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all
              media
            </label>
          )}
        </div>
        <DropZone
          accept={props.kinds ? mediaAccept(props.kinds) : MEDIA_ACCEPT}
          label={
            !props.kinds || props.kinds.includes('video')
              ? 'Drop files to upload (they appear below; videos are usable once processed)'
              : `Drop ${kindsText(props.kinds)} to upload (they appear below)`
          }
          onFiles={(f) => {
            const { ok, rejected } = props.kinds ? filesForKinds(f, props.kinds) : { ok: f, rejected: [] };
            if (rejected.length && props.kinds)
              toast(
                `Only ${kindsText(props.kinds)} can be chosen here: ${rejected.map((x) => x.name).join(', ')} not uploaded.`,
                'warn',
                8000,
              );
            if (ok.length) void uploadFiles(ok, { isBackground: !!props.backgroundsFirst });
          }}
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
            const blocked = notChoosable(m, !!props.needsSize);
            return (
              <button
                key={m.id}
                type="button"
                className="thumb"
                style={THUMB_BUTTON}
                disabled={!!blocked}
                aria-label={m.state === 'ready' ? m.name : `${m.name} (${m.state})`}
                title={blocked ? `${m.name}: ${blocked}` : m.name}
                onClick={() => props.onPick(m)}
              >
                <div
                  className="img"
                  style={{
                    backgroundImage: h
                      ? `url(${fileUrl(h)})`
                      : m.kind === 'video'
                        ? 'linear-gradient(135deg, #1e1b4b 0%, #0f766e 100%)'
                        : undefined,
                    position: 'relative',
                  }}
                >
                  {m.kind === 'video' && <span className="ed-video-badge">▶ Video</span>}
                </div>
                <div className="cap">
                  <span className="ellipsis grow">{m.name}</span>
                  {m.state !== 'ready' && <span className="tag amber">{m.state}</span>}
                </div>
              </button>
            );
          })}
        </div>
        {!list.length && <span className="muted">No media here yet.</span>}
      </div>
    </Dialog>
  );
}

/** A thumbnail as a button: the thumbnail's own look (styles.css `.thumb`), not a button's padding and height. */
const THUMB_BUTTON = {
  display: 'block',
  width: '100%',
  padding: 0,
  minHeight: 0,
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
} as const;

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

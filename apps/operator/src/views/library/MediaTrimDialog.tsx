import { api, fileUrl } from '@ordo/client';
import type { Media, MediaTrim } from '@ordo/domain';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { formatTrimMs, parseTrimMs } from '../../lib/mediaTrim.ts';
import { upsertLocal } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';

export function MediaTrimDialog({ m, onClose }: { m: Media; onClose: () => void }) {
  const initialTotal = Math.max(100, m.sourceDurationMs ?? m.durationMs ?? 0);
  const [totalMs, setTotalMs] = useState(initialTotal);
  const [startMs, setStartMs] = useState(m.trim?.startMs ?? 0);
  const [endMs, setEndMs] = useState(m.trim?.endMs ?? initialTotal);
  const [startText, setStartText] = useState(formatTrimMs(m.trim?.startMs ?? 0));
  const [endText, setEndText] = useState(formatTrimMs(m.trim?.endMs ?? initialTotal));
  const [playheadMs, setPlayheadMs] = useState(m.trim?.startMs ?? 0);
  const [canPreview, setCanPreview] = useState(true);
  const [saving, setSaving] = useState(false);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);

  const syncStart = (v: number) => {
    const clamped = Math.max(0, Math.min(Math.round(v), Math.max(0, endMs - 100)));
    setStartMs(clamped);
    setStartText(formatTrimMs(clamped));
  };

  const syncEnd = (v: number) => {
    const max = totalMs > 0 ? totalMs : Math.round(v);
    const clamped = Math.max(startMs + 100, Math.min(Math.round(v), max));
    setEndMs(clamped);
    setEndText(formatTrimMs(clamped));
  };

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const onLoaded = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        const dur = Math.round(el.duration * 1000);
        setTotalMs(dur);
        if (!m.trim) {
          setEndMs(dur);
          setEndText(formatTrimMs(dur));
        }
      }
      if (m.trim?.startMs) el.currentTime = m.trim.startMs / 1000;
    };
    const onTime = () => {
      const ms = Math.round(el.currentTime * 1000);
      setPlayheadMs(ms);
      if (endMs > 0 && ms >= endMs && !el.paused) {
        el.pause();
        el.currentTime = endMs / 1000;
      }
    };
    const onErr = () => setCanPreview(false);
    el.addEventListener('loadedmetadata', onLoaded);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('error', onErr);
    return () => {
      el.removeEventListener('loadedmetadata', onLoaded);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('error', onErr);
    };
  }, [m.trim, endMs]);

  const seekTo = (ms: number) => {
    const el = mediaRef.current;
    if (el && canPreview) {
      el.currentTime = Math.max(0, ms / 1000);
      setPlayheadMs(ms);
    }
  };

  const previewSelection = () => {
    const el = mediaRef.current;
    if (!el || !canPreview) return;
    el.currentTime = startMs / 1000;
    void el.play().catch(() => undefined);
  };

  const submit = async (trim: MediaTrim | null) => {
    setSaving(true);
    try {
      const updated = await api<Media>(`/media/${encodeURIComponent(m.id)}/trim`, {
        method: 'PUT',
        json: { trim },
      });
      upsertLocal('media', updated);
      toast(trim ? `Trimmed “${m.name}” — re-processing…` : `Reset trim on “${m.name}” — re-processing…`);
      onClose();
    } catch (e) {
      toast(`Could not trim ${m.name}: ${errorText(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const isFullLength = startMs === 0 && totalMs > 0 && endMs >= totalMs - 50;
  const keptMs = Math.max(0, endMs - startMs);
  const valid = endMs > startMs;

  return (
    <Dialog title={`Trim — ${m.name}`} onClose={onClose} width={720}>
      <div className="col" style={{ gap: 12 }}>
        {canPreview ? (
          m.kind === 'video' ? (
            <video
              ref={mediaRef}
              src={fileUrl(m.original.hash)}
              poster={m.poster ? fileUrl(m.poster.hash) : undefined}
              controls
              style={{ width: '100%', maxHeight: 360, background: '#000', borderRadius: 4 }}
            />
          ) : (
            <audio ref={mediaRef} src={fileUrl(m.original.hash)} controls style={{ width: '100%' }} />
          )
        ) : (
          <div className="banner small">
            This file’s original format cannot preview in the browser. Enter start and end timestamps below;
            the Hub will trim from the original file.
          </div>
        )}

        {totalMs > 0 && (
          <div className="col" style={{ gap: 6 }}>
            <label className="row small" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ width: 44 }}>Start</span>
              <input
                type="range"
                className="grow"
                min={0}
                max={totalMs}
                step={100}
                value={startMs}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  syncStart(v);
                  seekTo(v);
                }}
              />
              <input
                type="text"
                aria-label="Start time"
                value={startText}
                style={{ width: 82 }}
                onChange={(e) => setStartText(e.target.value)}
                onBlur={() => {
                  const p = parseTrimMs(startText);
                  if (p !== undefined) {
                    syncStart(p);
                    seekTo(p);
                  } else {
                    setStartText(formatTrimMs(startMs));
                  }
                }}
              />
            </label>
            <label className="row small" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ width: 44 }}>End</span>
              <input
                type="range"
                className="grow"
                min={0}
                max={totalMs}
                step={100}
                value={endMs}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  syncEnd(v);
                  seekTo(v);
                }}
              />
              <input
                type="text"
                aria-label="End time"
                value={endText}
                style={{ width: 82 }}
                onChange={(e) => setEndText(e.target.value)}
                onBlur={() => {
                  const p = parseTrimMs(endText);
                  if (p !== undefined) {
                    syncEnd(p);
                    seekTo(p);
                  } else {
                    setEndText(formatTrimMs(endMs));
                  }
                }}
              />
            </label>
          </div>
        )}

        <div className="row wrap small" style={{ gap: 8, alignItems: 'center' }}>
          {canPreview && (
            <>
              <button type="button" className="small" onClick={() => syncStart(playheadMs)}>
                Set start ({formatTrimMs(playheadMs)})
              </button>
              <button type="button" className="small" onClick={() => syncEnd(playheadMs)}>
                Set end ({formatTrimMs(playheadMs)})
              </button>
              <button type="button" className="small" onClick={previewSelection}>
                Preview trim
              </button>
            </>
          )}
          <span className="spacer" />
          <span className="muted">
            Kept: {formatTrimMs(keptMs)}
            {totalMs > 0 ? ` of ${formatTrimMs(totalMs)}` : ''}
          </span>
        </div>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          {m.trim && (
            <button type="button" className="small" disabled={saving} onClick={() => void submit(null)}>
              Reset to full length
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="small" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary small"
            disabled={saving || !valid}
            onClick={() => void submit(isFullLength ? null : { startMs, endMs })}
          >
            {saving ? 'Saving…' : 'Apply trim'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

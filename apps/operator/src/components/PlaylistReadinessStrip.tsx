import type { Media, Playlist, Presentation } from '@ordo/domain';
import type { ReactNode } from 'react';
import { computePlaylistReadiness } from '../lib/playlists.ts';

/**
 * Unified pre-service readiness summary shown on both Playlists and Live (Preview), with an optional
 * `offlineSlot` for `OfflineControl` so both screens share one readiness surface while keeping this
 * component compact-safe (no live controller imports).
 */
export function PlaylistReadinessStrip({
  playlist,
  presentations,
  media,
  unsavedItems,
  compact,
  offlineSlot,
}: {
  playlist: Playlist;
  presentations: readonly Presentation[];
  media: readonly Media[];
  unsavedItems: Record<string, unknown>;
  compact?: boolean;
  offlineSlot?: ReactNode;
}) {
  const issues = computePlaylistReadiness(playlist, presentations, media, unsavedItems);
  const hasError = issues.some((i) => i.level === 'error');
  const status = issues.length === 0 ? 'ok' : hasError ? 'error' : 'warn';

  return (
    <div
      className="col"
      style={{
        gap: 6,
        padding: compact ? '6px 10px' : '8px 10px',
        fontSize: 11.5,
        borderBottom: compact ? '1px solid var(--line)' : undefined,
        border: compact
          ? undefined
          : `1px solid ${status === 'error' ? 'var(--red, #ef4444)' : status === 'warn' ? 'var(--amber, #f59e0b)' : 'var(--line)'}`,
        borderRadius: compact ? undefined : 6,
        background:
          status === 'error'
            ? 'rgba(239, 68, 68, 0.08)'
            : status === 'warn'
              ? 'rgba(245, 158, 11, 0.08)'
              : 'var(--bg2)',
      }}
      data-readiness={status}
    >
      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
        <span className={`dot ${status === 'ok' ? 'green' : status === 'error' ? 'red' : 'amber'}`} />
        {status === 'ok' ? (
          <span className="muted">Ready · {playlist.items.length} items</span>
        ) : (
          <span className="grow">{issues.map((i) => i.text).join(' · ')}</span>
        )}
      </div>
      {offlineSlot}
    </div>
  );
}

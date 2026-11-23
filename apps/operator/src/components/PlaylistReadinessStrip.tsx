import type { Media, Playlist, Presentation } from '@ordo/domain';
import { computePlaylistReadiness } from '../lib/playlists.ts';

/**
 * Unified pre-service readiness summary shown on both Playlists and Live (Preview).
 * Compact-safe: imports no live controller.
 */
export function PlaylistReadinessStrip({
  playlist,
  presentations,
  media,
  unsavedItems,
  compact,
}: {
  playlist: Playlist;
  presentations: readonly Presentation[];
  media: readonly Media[];
  unsavedItems: Record<string, unknown>;
  compact?: boolean;
}) {
  const issues = computePlaylistReadiness(playlist, presentations, media, unsavedItems);
  if (issues.length === 0) {
    return (
      <div
        className="row"
        style={{
          gap: 6,
          alignItems: 'center',
          padding: compact ? '5px 10px' : '6px 10px',
          fontSize: 11.5,
          borderBottom: compact ? '1px solid var(--line)' : undefined,
          border: compact ? undefined : '1px solid var(--line)',
          borderRadius: compact ? undefined : 6,
          background: 'var(--bg2)',
        }}
        data-readiness="ok"
      >
        <span className="dot green" />
        <span className="muted">Ready · {playlist.items.length} items</span>
      </div>
    );
  }
  const hasError = issues.some((i) => i.level === 'error');
  return (
    <div
      className="row wrap"
      style={{
        gap: 6,
        alignItems: 'center',
        padding: compact ? '6px 10px' : '6px 10px',
        fontSize: 11.5,
        borderBottom: compact ? '1px solid var(--line)' : undefined,
        border: compact
          ? undefined
          : `1px solid ${hasError ? 'var(--red, #ef4444)' : 'var(--amber, #f59e0b)'}`,
        borderRadius: compact ? undefined : 6,
        background: hasError ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)',
      }}
      data-readiness={hasError ? 'error' : 'warn'}
    >
      <span className={`dot ${hasError ? 'red' : 'amber'}`} />
      <span className="grow">{issues.map((i) => i.text).join(' · ')}</span>
    </div>
  );
}

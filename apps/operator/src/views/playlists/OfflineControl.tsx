import { useEffect } from 'react';
import { controller } from '../../services/controller.ts';
import { useLive } from '../../state/live.ts';

const mb = (b: number) => `${(b / 1024 ** 2).toFixed(b >= 100 * 1024 ** 2 ? 0 : 1)} MB`;

/**
 * Download for offline use (design/17 "Going live without the hub"): the operator chooses when to copy a
 * playlist's media and fonts to this PC, so the service can go live from here if the hub is down on the
 * day. Shown on the venue PC (operate role, full profile) only.
 */
export function OfflineControl(props: { playlistId: string; rev: number }) {
  const { playlistId, rev } = props;
  const entry = useLive((s) => s.offline[playlistId]);
  const check = useLive((s) => s.offlineChecks[playlistId]);
  const hubConnected = useLive((s) => s.hubConnected);
  // Re-check when the playlist changes (an added song brings new files) and after a download.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev and the entry state trigger a fresh check
  useEffect(() => {
    controller()?.offlineCheck(playlistId);
  }, [playlistId, rev, entry?.state]);

  const downloading = entry?.state === 'downloading';
  let status: string;
  let tone = 'muted';
  if (downloading) {
    status = `Downloading ${entry.ready}/${entry.total} file(s) · ${mb(entry.bytesReady)} of ${mb(entry.bytesTotal)}`;
  } else if (check && !check.ok) {
    status = `Cannot run from this PC: ${check.error}`;
    tone = 'red';
  } else if (check?.ok && check.missing.length === 0) {
    status =
      check.files === 0
        ? 'Ready offline (no media files)'
        : `Ready offline · ${check.files} file(s) on this PC${entry?.at ? ` · downloaded ${new Date(entry.at).toLocaleString()}` : ''}`;
    tone = 'green';
  } else if (check?.ok) {
    status = `${check.missing.length} of ${check.files} file(s) not on this PC`;
    tone = 'amber';
  } else status = 'Checking…';
  if (entry?.error && !downloading) status += ` (${entry.error})`;

  return (
    <div className="row wrap" data-offline-control style={{ gap: 8, alignItems: 'center' }}>
      {downloading ? (
        <button type="button" onClick={() => controller()?.offlineCancel(playlistId)}>
          Cancel download
        </button>
      ) : (
        <button
          type="button"
          data-offline-download
          disabled={!hubConnected || (check ? !check.ok : false)}
          title={hubConnected ? undefined : 'The hub is unreachable: files can only be downloaded from it'}
          onClick={() => controller()?.offlineDownload(playlistId)}
        >
          Download for offline use
        </button>
      )}
      <span
        className={`small ${tone === 'muted' ? 'muted' : ''}`}
        data-offline-status={tone}
        style={{
          color:
            tone === 'green'
              ? 'var(--ok, #4ade80)'
              : tone === 'amber'
                ? 'var(--warn, #fbbf24)'
                : tone === 'red'
                  ? 'var(--danger, #f87171)'
                  : undefined,
        }}
      >
        {status}
      </span>
      {downloading && entry.total > 0 && (
        <progress max={entry.total} value={entry.ready} style={{ width: 120 }} />
      )}
    </div>
  );
}

import { api } from '@ordo/client';
import { useEffect, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { errorText, toast } from '../../state/toasts.ts';

export function BackupsPage() {
  const [files, setFiles] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<{ files: string[] }>('/backup/list').then(
      (r) => setFiles(r.files),
      (e) => toast(errorText(e), 'error'),
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency list
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="col" style={{ gap: 12, maxWidth: 640 }}>
      <h2>Backups</h2>
      <p className="muted" style={{ margin: 0 }}>
        The hub writes a database snapshot and media manifest every night at 03:00 and keeps 30 days. Restore
        is a command on the NAS: <span className="mono">ordo-hub restore &lt;date&gt;</span>. Offsite copies
        come from the venue's Hyper Backup.
      </p>
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ file?: string }>('/backup/run', { method: 'POST' });
              toast(`Backup written${r?.file ? `: ${r.file}` : ''}.`, 'ok');
              await load();
            } catch (e) {
              toast(errorText(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      <table className="list">
        <tbody>
          {files?.map((f) => (
            <tr
              key={f}
              onContextMenu={(e) => {
                const dateArg = f.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? f;
                openContextMenu(e, [
                  {
                    label: 'Copy filename',
                    onSelect: () => {
                      void navigator.clipboard?.writeText(f);
                      toast('Copied backup filename.', 'info');
                    },
                  },
                  {
                    label: 'Copy restore command',
                    onSelect: () => {
                      const cmd = `ordo-hub restore ${dateArg}`;
                      void navigator.clipboard?.writeText(cmd);
                      toast(`Copied: ${cmd}`, 'info');
                    },
                  },
                ]);
              }}
            >
              <td className="mono">{f}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {files && !files.length && <span className="muted">No backups yet.</span>}
    </div>
  );
}

import { api } from '@ordo/client';
import type { Theme } from '@ordo/domain';
import type { RevisionInfo } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { upsertLocal } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';

export function ThemeRevisionsDialog({
  id,
  themeName,
  onClose,
  onRestored,
}: {
  id: string;
  themeName: string;
  onClose: () => void;
  onRestored: (theme: Theme) => void;
}) {
  const [list, setList] = useState<RevisionInfo[]>();
  const [err, setErr] = useState<string>();

  useEffect(() => {
    api<RevisionInfo[]>(`/themes/${id}/revisions`).then(setList, (e) => setErr(errorText(e)));
  }, [id]);

  const restore = async (rev: number) => {
    if (
      !(await confirmDialog(
        'Restore revision',
        `Restore revision ${rev} of “${themeName}”? This creates a new revision; no past versions are lost.`,
        'Restore',
      ))
    )
      return;
    try {
      const restored = await api<Theme>(`/themes/${id}/restore/${rev}`, { method: 'POST' });
      upsertLocal('themes', restored);
      toast(`Restored revision ${rev} as revision ${restored.rev}.`, 'ok');
      onRestored(restored);
      onClose();
    } catch (e) {
      toast(`Could not restore: ${errorText(e)}`, 'error');
    }
  };

  return (
    <Dialog title={`Revision history · ${themeName}`} onClose={onClose} width={560}>
      {err && <div className="banner red">{err}</div>}
      {!list && !err && <span className="muted">Loading…</span>}
      {list && list.length === 0 && <span className="muted">No prior revisions recorded yet.</span>}
      {list && list.length > 0 && (
        <table className="list" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Version</th>
              <th style={{ textAlign: 'left' }}>Saved At</th>
              <th style={{ textAlign: 'left' }}>Saved By</th>
              <th style={{ textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => (
              <tr key={r.rev}>
                <td>
                  <b>v{r.rev}</b>{' '}
                  {i === 0 && (
                    <span className="tag green" style={{ marginLeft: 6 }}>
                      current
                    </span>
                  )}
                </td>
                <td className="small">{new Date(r.savedAt).toLocaleString()}</td>
                <td className="muted small">{r.savedBy ?? 'operator'}</td>
                <td style={{ textAlign: 'right' }}>
                  {i > 0 && (
                    <button type="button" className="small" onClick={() => void restore(r.rev)}>
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

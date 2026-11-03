import { api } from '@ordo/client';
import type { Presentation } from '@ordo/domain';
import type { RevisionInfo } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { errorText, toast } from '../../state/toasts.ts';
import { replaceBase } from './editorStore.ts';

/** Revision history with one-click restore (creates a new revision) (prd/05). */
export function RevisionsDialog({
  id,
  onClose,
  readOnly,
}: {
  id: string;
  onClose: () => void;
  readOnly: boolean;
}) {
  const [list, setList] = useState<RevisionInfo[]>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    api<RevisionInfo[]>(`/presentations/${id}/revisions`).then(setList, (e) => setErr(errorText(e)));
  }, [id]);
  const restore = async (rev: number) => {
    if (
      !(await confirmDialog(
        'Restore revision',
        `Restore revision ${rev}? This creates a new revision; nothing is lost.`,
        'Restore',
      ))
    )
      return;
    try {
      const p = await api<Presentation>(`/presentations/${id}/restore/${rev}`, { method: 'POST' });
      replaceBase(p);
      toast(`Restored revision ${rev} as revision ${p.rev}.`, 'ok');
      onClose();
    } catch (e) {
      toast(`Could not restore: ${errorText(e)}`, 'error');
    }
  };
  return (
    <Dialog title="Revision history" onClose={onClose} width={560}>
      {err && <div className="banner red">{err}</div>}
      {!list && !err && <span className="muted">Loading…</span>}
      <table className="list">
        <tbody>
          {list?.map((r, i) => (
            <tr key={r.rev}>
              <td>
                <b>#{r.rev}</b> {i === 0 && <span className="tag green">current</span>}
              </td>
              <td>{new Date(r.savedAt).toLocaleString()}</td>
              <td className="muted">{r.savedBy ?? ''}</td>
              <td className="ellipsis" style={{ maxWidth: 160 }}>
                {r.title}
              </td>
              <td>
                {i > 0 && (
                  <button
                    type="button"
                    className="small"
                    disabled={readOnly}
                    onClick={() => void restore(r.rev)}
                  >
                    Restore
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

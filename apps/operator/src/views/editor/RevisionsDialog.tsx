import { api } from '@ordo/client';
import type { Presentation, Slide } from '@ordo/domain';
import type { RevisionInfo } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { useMediaLookup } from '../../hooks.ts';
import { stillHash, useThumb } from '../../services/thumbs.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { replaceBase } from './editorStore.ts';

function RevisionSlideThumb({ slide, p }: { slide: Slide; p: Presentation }) {
  const media = useMediaLookup();
  const bgId = slide.backgroundMediaId ?? p.backgroundMediaId;
  const url = useThumb(
    slide,
    { isSong: p.kind === 'song', media, bg: bgId ? stillHash(media(bgId)) : undefined, width: 320 },
    true,
  );
  return (
    <div className="rev-preview-thumb">
      {url ? <img src={url} alt="" draggable={false} /> : <div className="ph" />}
    </div>
  );
}

/** Visual Revision History with live slide thumbnail preview & one-click restore (prd/05). */
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
  const [selectedRev, setSelectedRev] = useState<number>();
  const [preview, setPreview] = useState<Presentation>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    api<RevisionInfo[]>(`/presentations/${id}/revisions`).then(
      (revs) => {
        setList(revs);
        if (revs[0]) setSelectedRev(revs[0].rev);
      },
      (e) => setErr(errorText(e)),
    );
  }, [id]);

  useEffect(() => {
    if (selectedRev === undefined) return;
    let alive = true;
    setPreviewLoading(true);
    api<Presentation>(`/presentations/${id}/revisions/${selectedRev}`).then(
      (p) => {
        if (alive) {
          setPreview(p);
          setPreviewLoading(false);
        }
      },
      () => {
        if (alive) {
          setPreview(undefined);
          setPreviewLoading(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [id, selectedRev]);

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

  const previewSlides = preview ? preview.sections.flatMap((sec) => sec.slides) : [];
  const isCurrent = list?.[0]?.rev === selectedRev;

  return (
    <Dialog title="Revision history" onClose={onClose} width={760}>
      {err && <div className="banner red">{err}</div>}
      {!list && !err && <span className="muted">Loading…</span>}
      {list && list.length === 0 && <span className="muted">No prior revisions recorded yet.</span>}
      {list && list.length > 0 && (
        <div className="rev-visual-layout">
          <div className="rev-timeline-col">
            <table className="list">
              <tbody>
                {list.map((r, i) => (
                  <tr
                    key={r.rev}
                    className={selectedRev === r.rev ? 'rev-row-selected' : ''}
                    onClick={() => setSelectedRev(r.rev)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <b>#{r.rev}</b> {i === 0 && <span className="tag green">current</span>}
                    </td>
                    <td className="small">{new Date(r.savedAt).toLocaleString()}</td>
                    <td className="muted small">{r.savedBy ?? ''}</td>
                    <td>
                      {i > 0 && (
                        <button
                          type="button"
                          className="small"
                          disabled={readOnly}
                          onClick={(e) => {
                            e.stopPropagation();
                            void restore(r.rev);
                          }}
                        >
                          Restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rev-preview-col">
            {previewLoading ? (
              <span className="muted small">Loading visual snapshot…</span>
            ) : preview ? (
              <div className="col" style={{ gap: 10 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>Revision #{preview.rev}</strong>
                    <div className="muted small">
                      “{preview.title}” · {previewSlides.length} slide{previewSlides.length === 1 ? '' : 's'}{' '}
                      across {preview.sections.length} section{preview.sections.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  {!isCurrent && selectedRev !== undefined && (
                    <button
                      type="button"
                      className="primary small"
                      disabled={readOnly}
                      onClick={() => void restore(selectedRev)}
                    >
                      Restore #{selectedRev}
                    </button>
                  )}
                </div>
                <div className="rev-thumb-grid">
                  {previewSlides.slice(0, 12).map((sl, idx) => (
                    <div key={sl.id} className="col" style={{ gap: 3 }}>
                      <RevisionSlideThumb slide={sl} p={preview} />
                      <span className="muted" style={{ fontSize: 10 }}>
                        Slide {idx + 1}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <span className="muted small">Select a revision to inspect its slides.</span>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

import { api, upload } from '@ordo/client';
import type { PptxRenderer, Presentation } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import { jobResultPresentationId, useJob } from '../../services/jobs.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { navigate } from '../../useRoute.ts';
import { DropZone } from './MediaTab.tsx';

export function JobCard({ id, title }: { id: string; title: string }) {
  const job = useJob(id);
  const [showLog, setShowLog] = useState(false);
  const pid = jobResultPresentationId(job);
  const state = job?.state ?? 'queued';
  return (
    <div className="card col" style={{ gap: 6 }}>
      <div className="row">
        <b className="grow ellipsis">{title}</b>
        <span className={`tag ${state === 'done' ? 'green' : state === 'failed' ? 'red' : 'amber'}`}>
          {state}
        </span>
      </div>
      <div className="progress">
        <i style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} />
      </div>
      {job?.error && <div className="banner red small">{job.error}</div>}
      <div className="row">
        {pid && (
          <button type="button" className="small primary" onClick={() => navigate({ name: 'edit', id: pid })}>
            Open presentation
          </button>
        )}
        {job?.log.length ? (
          <button type="button" className="small" onClick={() => setShowLog(!showLog)}>
            {showLog ? 'Hide log' : `Log (${job.log.length} lines)`}
          </button>
        ) : null}
      </div>
      {showLog && job && <div className="logbox">{job.log.join('\n')}</div>}
    </div>
  );
}

type Started = { id: string; title: string };

/** ProPresenter 7, SongSelect and PPTX/PDF imports with job progress and logs (prd/05, design/20). */
/** The PowerPoint renderer this device last chose (a convenience; the hub defaults to LibreOffice). */
const RENDERER_KEY = 'ordo.pptxRenderer';

function storedRenderer(): PptxRenderer {
  try {
    return localStorage.getItem(RENDERER_KEY) === 'pptx-preview' ? 'pptx-preview' : 'libreoffice';
  } catch {
    return 'libreoffice';
  }
}

export function ImportTab() {
  const [jobs, setJobs] = useState<Started[]>([]);
  const [renderer, setRenderer] = useState<PptxRenderer>(storedRenderer);
  const [recent, setRecent] = useState<Job[]>([]);
  const [nasPath, setNasPath] = useState('');
  const [pasted, setPasted] = useState('');
  const [progress, setProgress] = useState<number>();
  const jobMap = useLibrary((s) => s.data.jobs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency list
  useEffect(() => {
    void api<Job[] | { jobs: Job[] }>('/jobs')
      .then((r) =>
        setRecent(
          (Array.isArray(r) ? r : r.jobs)
            .filter((j) => /pro7|document|pdf|pptx|import/.test(j.kind))
            .slice(0, 10),
        ),
      )
      .catch(() => undefined);
  }, [jobMap]);
  const started = (job: Job, title: string) => setJobs((j) => [{ id: job.id, title }, ...j]);

  const pro7Zip = async (files: File[]) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f, f.name);
      try {
        setProgress(0);
        started(await upload<Job>('/import/pro7', fd, setProgress), `ProPresenter: ${f.name}`);
      } catch (e) {
        toast(`ProPresenter import: ${errorText(e)}`, 'error');
      } finally {
        setProgress(undefined);
      }
    }
  };
  const pro7Path = async () => {
    try {
      started(
        await api<Job>('/import/pro7', { method: 'POST', json: { path: nasPath.trim() } }),
        `ProPresenter: ${nasPath}`,
      );
    } catch (e) {
      toast(`ProPresenter import: ${errorText(e)}`, 'error');
    }
  };
  const songselectFiles = async (files: File[]) => {
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f, f.name);
      try {
        const p = await upload<Presentation>('/import/songselect', fd);
        upsertLocal('presentations', p);
        toast(`Imported “${p.title}”.`, 'ok');
        if (files.length === 1) navigate({ name: 'edit', id: p.id });
      } catch (e) {
        toast(`${f.name}: ${errorText(e)}`, 'error');
      }
    }
  };
  const songselectPaste = async () => {
    try {
      const p = await api<Presentation>('/import/songselect', { method: 'POST', json: { text: pasted } });
      upsertLocal('presentations', p);
      setPasted('');
      navigate({ name: 'edit', id: p.id });
    } catch (e) {
      toast(`SongSelect: ${errorText(e)}`, 'error');
    }
  };
  const documents = async (files: File[]) => {
    for (const f of files) {
      const fd = new FormData();
      if (/\.pptx$/i.test(f.name)) fd.append('renderer', renderer);
      fd.append('file', f, f.name);
      try {
        setProgress(0);
        started(await upload<Job>('/import/document', fd, setProgress), f.name);
      } catch (e) {
        toast(`${f.name}: ${errorText(e)}`, 'error');
      } finally {
        setProgress(undefined);
      }
    }
  };

  return (
    <div className="page-pad" style={{ overflow: 'auto', height: '100%' }}>
      <div className="grid2" style={{ gap: 16, alignItems: 'start' }}>
        <div className="col" style={{ gap: 16 }}>
          <div className="card col">
            <h3>ProPresenter 7</h3>
            <span className="muted small">
              Zip the ProPresenter library folder (or exported .pro files and playlists) and drop it here.
              Media found alongside is uploaded. Builds, macros, timers, looks and stage layouts are skipped
              and listed in the log.
            </span>
            <DropZone
              accept=".zip"
              touchAccept=".zip,application/zip"
              label="Drop a .zip of the ProPresenter library"
              touchLabel="Choose a .zip of the ProPresenter library"
              onFiles={(f) => void pro7Zip(f)}
            />
            <div className="row">
              <input
                className="grow"
                placeholder="…or a folder path on the NAS, e.g. /import/ProPresenter"
                value={nasPath}
                onChange={(e) => setNasPath(e.target.value)}
              />
              <button type="button" disabled={!nasPath.trim()} onClick={() => void pro7Path()}>
                Import folder
              </button>
            </div>
          </div>
          <div className="card col">
            <h3>SongSelect</h3>
            <span className="muted small">
              ChordPro (.chordpro, .cho) or lyrics text (.txt) downloaded from CCLI SongSelect. Chords are
              kept but not shown.
            </span>
            <DropZone
              accept=".txt,.chordpro,.cho,.chopro,.pro,.crd"
              // The iPad Files picker greys out extensions it has no type for (.cho, .chordpro): offer
              // every file there; the hub checks what it gets.
              touchAccept=""
              label="Drop SongSelect files"
              touchLabel="Choose SongSelect files"
              onFiles={(f) => void songselectFiles(f)}
            />
            <textarea
              rows={6}
              placeholder="…or paste the SongSelect lyrics or ChordPro text"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <button type="button" disabled={!pasted.trim()} onClick={() => void songselectPaste()}>
              Import pasted text
            </button>
          </div>
          <div className="card col">
            <h3>PowerPoint and PDF</h3>
            <span className="muted small">
              Each page becomes an image slide at 1920×1080. PowerPoint slides can later be made editable in
              the editor (text boxes are approximate; fonts may differ).
            </span>
            <label className="row small" style={{ gap: 8 }}>
              PowerPoint drawn by
              <select
                data-pptx-renderer
                value={renderer}
                onChange={(e) => {
                  const v = e.target.value as PptxRenderer;
                  setRenderer(v);
                  try {
                    localStorage.setItem(RENDERER_KEY, v);
                  } catch {
                    /* storage unavailable: the choice lasts this visit */
                  }
                }}
              >
                <option value="libreoffice">LibreOffice</option>
                <option value="pptx-preview">pptx-preview (experimental)</option>
              </select>
            </label>
            <DropZone
              accept=".pptx,.pdf"
              touchAccept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              label="Drop .pptx or .pdf files"
              touchLabel="Choose .pptx or .pdf files"
              onFiles={(f) => void documents(f)}
            />
          </div>
          {progress !== undefined && (
            <div className="progress">
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </div>
        <div className="col">
          <h3>Import jobs</h3>
          {jobs.map((j) => (
            <JobCard key={j.id} id={j.id} title={j.title} />
          ))}
          {recent
            .filter((r) => !jobs.some((j) => j.id === r.id))
            .map((r) => (
              <JobCard key={r.id} id={r.id} title={`${r.kind} · ${new Date(r.createdAt).toLocaleString()}`} />
            ))}
          {!jobs.length && !recent.length && <span className="muted">No imports yet.</span>}
        </div>
      </div>
    </div>
  );
}

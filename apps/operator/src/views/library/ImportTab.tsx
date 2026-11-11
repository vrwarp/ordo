import { api, upload } from '@ordo/client';
import type { Presentation } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import {
  documentFields,
  importJobTitle,
  isImportJob,
  isPptxName,
  PPTX_NATIVE_JOB,
  type PptxImportChoice,
  readImportChoice,
  writeImportChoice,
} from '../../lib/pptxImport.ts';
import { jobResultPresentationId, useJob } from '../../services/jobs.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { navigate } from '../../useRoute.ts';
import { DropZone } from './MediaTab.tsx';
import { JobProgress, PptxImportCard } from './PptxImportCard.tsx';

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
      <JobProgress value={job?.progress ?? 0} label="Import progress" />
      {job?.error && (
        <div className="banner red small" role="alert">
          {job.error}
        </div>
      )}
      <div className="row">
        {pid && (
          <button type="button" className="small primary" onClick={() => navigate({ name: 'edit', id: pid })}>
            Open presentation
          </button>
        )}
        {job?.log.length ? (
          <button
            type="button"
            className="small"
            aria-expanded={showLog}
            onClick={() => setShowLog(!showLog)}
          >
            {showLog ? 'Hide log' : `Log (${job.log.length} lines)`}
          </button>
        ) : null}
      </div>
      {showLog && job && <div className="logbox">{job.log.join('\n')}</div>}
    </div>
  );
}

type Started = { id: string; kind: string; title: string };

/** An import job's card: the PowerPoint import card for a native import, the plain job card otherwise. */
function ImportJobCard({ id, kind, title }: Started) {
  return kind === PPTX_NATIVE_JOB ? (
    <PptxImportCard id={id} title={title} />
  ) : (
    <JobCard id={id} title={title} />
  );
}

const storage = () => (typeof localStorage === 'undefined' ? undefined : localStorage);

/**
 * How PowerPoint files are imported (design/27 §2, M3): 'Editable (recommended)', the native import, or
 * 'Pictures (LibreOffice)'; 'Extend plain backgrounds to 16:9' for the native import. Remembered per device.
 */
export function PptxImportChoices(props: {
  value: PptxImportChoice;
  onChange: (c: PptxImportChoice) => void;
}) {
  const c = props.value;
  const set = (patch: Partial<PptxImportChoice>) => props.onChange({ ...c, ...patch });
  return (
    <fieldset className="col" style={{ gap: 6, border: 0, margin: 0, padding: 0 }} data-pptx-import-mode>
      <legend className="small" style={{ padding: 0, marginBottom: 4, color: 'var(--fg2)' }}>
        PowerPoint slides
      </legend>
      <label className="check" style={{ alignItems: 'flex-start' }}>
        <input
          type="radio"
          name="pptx-import-mode"
          value="native"
          checked={c.mode === 'native'}
          onChange={() => set({ mode: 'native' })}
        />
        <span className="col" style={{ gap: 2 }}>
          <span>Editable (recommended)</span>
          <span className="muted small">
            Text, pictures and shapes become objects you can edit. What ordo cannot draw (a chart, SmartArt,
            3D) becomes a picture on its slide.
          </span>
        </span>
      </label>
      <label className="check" style={{ alignItems: 'flex-start' }}>
        <input
          type="radio"
          name="pptx-import-mode"
          value="libreoffice"
          checked={c.mode === 'libreoffice'}
          onChange={() => set({ mode: 'libreoffice' })}
        />
        <span className="col" style={{ gap: 2 }}>
          <span>Pictures (LibreOffice)</span>
          <span className="muted small">
            Each slide becomes one picture, as LibreOffice draws it. Its text can be made editable later,
            slide by slide.
          </span>
        </span>
      </label>
      <label className="check" style={{ alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={c.extendBackgrounds}
          disabled={c.mode !== 'native'}
          onChange={(e) => set({ extendBackgrounds: e.target.checked })}
        />
        <span className="col" style={{ gap: 2 }}>
          <span>Extend plain backgrounds to 16:9</span>
          <span className="muted small">
            A 4:3 slide's plain background colour fills the whole screen instead of leaving black bars.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/** ProPresenter 7, SongSelect and PPTX/PDF imports with job progress and logs (prd/05, design/20). */
export function ImportTab() {
  const [jobs, setJobs] = useState<Started[]>([]);
  const [choice, setChoice] = useState<PptxImportChoice>(() => readImportChoice(storage()));
  const [recent, setRecent] = useState<Job[]>([]);
  const [nasPath, setNasPath] = useState('');
  const [pasted, setPasted] = useState('');
  const [progress, setProgress] = useState<number>();
  const jobMap = useLibrary((s) => s.data.jobs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency list
  useEffect(() => {
    void api<Job[] | { jobs: Job[] }>('/jobs')
      .then((r) => setRecent((Array.isArray(r) ? r : r.jobs).filter((j) => isImportJob(j.kind)).slice(0, 10)))
      .catch(() => undefined);
  }, [jobMap]);
  const started = (job: Job, title: string) => setJobs((j) => [{ id: job.id, kind: job.kind, title }, ...j]);

  const pro7Upload = async (files: File[]) => {
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
      for (const [k, v] of documentFields(f.name, choice)) fd.append(k, v);
      try {
        setProgress(0);
        const clientNative = isPptxName(f.name) && choice.mode === 'native';
        if (clientNative) {
          const { importPptxClient } = await import('@ordo/importers');
          const parsed = await importPptxClient(
            f,
            f.name,
            { extendBackgrounds: choice.extendBackgrounds },
            (pct) => setProgress(pct * 0.5),
          );
          fd.append(
            'clientScene',
            new Blob([JSON.stringify(parsed.clientScene)], { type: 'application/json' }),
            'scene.json',
          );
        }
        fd.append('file', f, f.name);
        started(
          await upload<Job>(
            '/import/document',
            fd,
            clientNative ? (pct) => setProgress(0.5 + pct * 0.5) : setProgress,
          ),
          f.name,
        );
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
              Drop individual .pro presentations, playlists, bundles or a .zip of the ProPresenter library
              here. Media found alongside is uploaded. Builds, macros, timers, looks and stage layouts are
              skipped and listed in the log.
            </span>
            <DropZone
              accept=".pro,.proplaylist,.probundle,.zip,application/zip"
              touchAccept=".pro,.proplaylist,.probundle,.zip,application/zip"
              label="Drop ProPresenter files or a library .zip"
              touchLabel="Choose ProPresenter files or a library .zip"
              onFiles={(f) => void pro7Upload(f)}
            />
            <div className="row">
              <input
                className="grow"
                placeholder="…or a folder or file path on the NAS, e.g. /import/ProPresenter"
                value={nasPath}
                onChange={(e) => setNasPath(e.target.value)}
              />
              <button type="button" disabled={!nasPath.trim()} onClick={() => void pro7Path()}>
                Import path
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
              PowerPoint slides become slides you can edit, or one picture each if you prefer. PDF pages
              become picture slides at 1920×1080.
            </span>
            <PptxImportChoices
              value={choice}
              onChange={(c) => {
                setChoice(c);
                writeImportChoice(storage(), c);
              }}
            />
            <DropZone
              accept=".pptx,.pdf"
              touchAccept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              label="Drop .pptx or .pdf files"
              touchLabel="Choose .pptx or .pdf files"
              onFiles={(f) => void documents(f)}
            />
          </div>
          {progress !== undefined && <JobProgress value={progress} label="Upload progress" />}
        </div>
        <div className="col">
          <h3>Import jobs</h3>
          {jobs.map((j) => (
            <ImportJobCard key={j.id} {...j} />
          ))}
          {recent
            .filter((r) => !jobs.some((j) => j.id === r.id))
            .map((r) => (
              <ImportJobCard key={r.id} id={r.id} kind={r.kind} title={importJobTitle(r)} />
            ))}
          {!jobs.length && !recent.length && <span className="muted">No imports yet.</span>}
        </div>
      </div>
    </div>
  );
}

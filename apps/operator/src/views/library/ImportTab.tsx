import { api, upload } from '@ordo/client';
import type { Presentation } from '@ordo/domain';
import type { HubCapabilities, Job } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import { SplitPane } from '../../components/SplitPane.tsx';
import { loadHubCaps, useHubCaps } from '../../lib/hubCaps.ts';
import {
  documentAccept,
  documentFields,
  hubHasLibreOffice,
  importCaps,
  importJobTitle,
  isImportJob,
  isPptxName,
  keepsSlidesWhole,
  PPTX_NATIVE_JOB,
  type PptxImportChoice,
  picturesOffered,
  readImportChoice,
  writeImportChoice,
} from '../../lib/pptxImport.ts';
import { jobResultPresentationId, useJob } from '../../services/jobs.ts';
import { clientScene } from '../../services/pptxParse.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
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
 * 'Pictures (LibreOffice)' is offered only by a hub with LibreOffice (design/27 M9, `caps`; undefined: not
 * known yet); a choice remembered from another hub then imports as editable slides, and the screen says so.
 */
export function PptxImportChoices(props: {
  value: PptxImportChoice;
  onChange: (c: PptxImportChoice) => void;
  caps?: HubCapabilities;
}) {
  // One rule with the upload (`documentFields`): unknown caps offer no pictures.
  const offered = picturesOffered(props.caps);
  const c = props.value;
  // A remembered 'Pictures' choice where the hub cannot make them: editable slides.
  const mode = c.mode === 'libreoffice' && !offered ? 'native' : c.mode;
  const set = (patch: Partial<PptxImportChoice>) => props.onChange({ ...c, ...patch });
  const editableDescription =
    props.caps && !props.caps.pptx.art
      ? 'Text, pictures, shapes, charts, SmartArt, 3D and WordArt become objects ordo draws; anything it cannot draw is listed on the import card.'
      : 'Text, pictures and shapes become objects you can edit. What ordo cannot draw (a chart, SmartArt, 3D) becomes a picture on its slide.';
  return (
    <fieldset className="col" style={{ gap: 6, border: 0, margin: 0, padding: 0 }} data-pptx-import-mode>
      <legend className="small" style={{ padding: 0, marginBottom: 4, color: 'var(--fg2)' }}>
        PowerPoint slides
      </legend>
      {offered ? (
        <>
          <label className="check" style={{ alignItems: 'flex-start' }}>
            <input
              type="radio"
              name="pptx-import-mode"
              value="native"
              checked={mode === 'native'}
              onChange={() => set({ mode: 'native' })}
            />
            <span className="col" style={{ gap: 2 }}>
              <span>Editable (recommended)</span>
              <span className="muted small">{editableDescription}</span>
            </span>
          </label>
          <label className="check" style={{ alignItems: 'flex-start' }}>
            <input
              type="radio"
              name="pptx-import-mode"
              value="libreoffice"
              checked={mode === 'libreoffice'}
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
        </>
      ) : (
        <div className="col" style={{ gap: 2 }}>
          <span>Editable slides</span>
          <span className="muted small">{editableDescription}</span>
        </div>
      )}
      {props.caps && !offered && c.mode === 'libreoffice' && (
        <span className="muted small" data-no-libreoffice>
          This hub has no LibreOffice, so PowerPoint files are imported as editable slides.
        </span>
      )}
      <label className="check" style={{ alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={c.extendBackgrounds}
          disabled={mode !== 'native'}
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
  const caps = useHubCaps();
  const [jobs, setJobs] = useState<Started[]>([]);
  const [choice, setChoice] = useState<PptxImportChoice>(() => readImportChoice(storage()));
  const [recent, setRecent] = useState<Job[]>([]);
  const [nasPath, setNasPath] = useState('');
  const [pasted, setPasted] = useState('');
  const [progress, setProgress] = useState<number>();
  const jobMap = useLibrary((s) => s.data.jobs);
  const fonts = useLibrary((s) => s.data.fonts);
  const live = useLive((s) => s.state.mode === 'live');
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
    // The hub's capabilities decide how a PowerPoint is parsed: a deck dropped before the tab heard them waits
    // briefly for the answer (`importCaps`), never parsed for a LibreOffice the hub turns out not to have.
    const known = files.some((f) => isPptxName(f.name)) ? await importCaps(caps, () => loadHubCaps()) : caps;
    for (const f of files) {
      const fd = new FormData();
      const fields = documentFields(f.name, choice, known);
      for (const [k, v] of fields) fd.append(k, v);
      try {
        setProgress(0);
        // Parsed in the import worker whenever the hub imports it natively (a remembered 'Pictures' choice on a
        // hub without LibreOffice too), for the LibreOffice the hub has or lacks (design/27 M9); never while a
        // playlist is live, and on any failure or timeout the hub parses it (`services/pptxParse.ts`).
        const clientNative = fields.some(([k, v]) => k === 'renderer' && v === 'native');
        if (clientNative) {
          const scene = await clientScene({
            file: f,
            name: f.name,
            extendBackgrounds: choice.extendBackgrounds,
            libreoffice: hubHasLibreOffice(known),
            // Q24.b: heavy slides kept whole when the hub does (its last answer; unknown is no).
            wholeSlides: keepsSlidesWhole(known),
            fonts,
            live,
            onProgress: (pct) => setProgress(pct * 0.5),
          });
          if (scene) fd.append('clientScene', scene, 'scene.json');
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
    <SplitPane
      storageKey="library-import-split"
      panels={[
        {
          id: 'import-sources',
          content: (
            <div className="pl-pane">
              <div className="pl-pane-head">
                <span className="prop-section-title" style={{ margin: 0 }}>
                  Import Sources
                </span>
              </div>
              <div className="studio-well">
                <div className="prop-section">
                  <span className="prop-section-title">ProPresenter 7</span>
                  <span className="muted small">
                    Drop individual .pro presentations, playlists, bundles or a .zip of the ProPresenter
                    library here. Media found alongside is uploaded. Builds, macros, timers, looks and stage
                    layouts are skipped and listed in the log.
                  </span>
                  <DropZone
                    accept=".pro,.proplaylist,.probundle,.zip,application/zip"
                    touchAccept=".pro,.proplaylist,.probundle,.zip,application/zip"
                    label="Drop ProPresenter files or a library .zip"
                    touchLabel="Choose ProPresenter files or a library .zip"
                    onFiles={(f) => void pro7Upload(f)}
                  />
                  <div className="row" style={{ gap: 8 }}>
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

                <div className="prop-section">
                  <span className="prop-section-title">SongSelect (CCLI / ChordPro)</span>
                  <span className="muted small">
                    ChordPro (.chordpro, .cho) or lyrics text (.txt) downloaded from CCLI SongSelect. Chords
                    are kept but not shown.
                  </span>
                  <DropZone
                    accept=".txt,.chordpro,.cho,.chopro,.pro,.crd"
                    touchAccept=""
                    label="Drop SongSelect files"
                    touchLabel="Choose SongSelect files"
                    onFiles={(f) => void songselectFiles(f)}
                  />
                  <textarea
                    rows={5}
                    placeholder="…or paste the SongSelect lyrics or ChordPro text"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                  />
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" disabled={!pasted.trim()} onClick={() => void songselectPaste()}>
                      Import pasted text
                    </button>
                  </div>
                </div>

                <div className="prop-section">
                  <span className="prop-section-title">PowerPoint &amp; PDF</span>
                  <span className="muted small">
                    PowerPoint slides (.pptx, .ppsx, .potx, .pptm) become slides you can edit
                    {caps?.pptx.pictures === false ? '' : ', or one picture each if you prefer'}. PDF pages
                    become picture slides at 1920×1080.
                  </span>
                  {caps && !caps.pdf && (
                    <span className="muted small" data-no-pdf>
                      PDF import needs poppler-utils on the hub.
                    </span>
                  )}
                  <PptxImportChoices
                    value={choice}
                    caps={caps}
                    onChange={(c) => {
                      setChoice(c);
                      writeImportChoice(storage(), c);
                    }}
                  />
                  <DropZone
                    accept={documentAccept(caps)}
                    touchAccept={`${documentAccept(caps)},application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation`}
                    label={caps && !caps.pdf ? 'Drop PowerPoint files' : 'Drop PowerPoint or PDF files'}
                    touchLabel={
                      caps && !caps.pdf ? 'Choose PowerPoint files' : 'Choose PowerPoint or PDF files'
                    }
                    onFiles={(f) => void documents(f)}
                  />
                </div>
                {progress !== undefined && (
                  <div className="prop-section">
                    <JobProgress value={progress} label="Upload progress" />
                  </div>
                )}
              </div>
            </div>
          ),
        },
        {
          id: 'import-jobs',
          size: 440,
          min: 300,
          max: 680,
          content: (
            <div className="studio-sidebar">
              <div className="pl-pane-head">
                <span className="prop-section-title" style={{ margin: 0 }}>
                  Import Jobs ({jobs.length + recent.filter((r) => !jobs.some((j) => j.id === r.id)).length})
                </span>
              </div>
              <div className="pl-pane-scroll col" style={{ padding: 14, gap: 12 }}>
                {jobs.map((j) => (
                  <ImportJobCard key={j.id} {...j} />
                ))}
                {recent
                  .filter((r) => !jobs.some((j) => j.id === r.id))
                  .map((r) => (
                    <ImportJobCard key={r.id} id={r.id} kind={r.kind} title={importJobTitle(r)} />
                  ))}
                {!jobs.length && !recent.length && (
                  <div className="muted small" style={{ padding: 8 }}>
                    No imports yet. Drop a ProPresenter, SongSelect, PowerPoint, or PDF file on the left to
                    track conversion progress and logs here.
                  </div>
                )}
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}

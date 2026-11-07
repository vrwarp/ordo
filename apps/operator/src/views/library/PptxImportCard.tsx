import type { Presentation } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { useState } from 'react';
import {
  approximatedSlides,
  classCounts,
  hiddenCount,
  loStatus,
  missingLine,
  missingSummary,
  type NativeImportFallback,
  type NativeImportResult,
  plural,
  readNativeFallback,
  readNativeResult,
} from '../../lib/pptxImport.ts';
import { jobResultPresentationId, useJob } from '../../services/jobs.ts';
import { useLibrary } from '../../state/library.ts';
import { navigate } from '../../useRoute.ts';

const stateTone = (s: Job['state']) => (s === 'done' ? 'green' : s === 'failed' ? 'red' : 'amber');
const bannerClass = (tone: 'amber' | 'green' | 'red') =>
  tone === 'amber' ? 'banner small' : `banner ${tone} small`;

/** A job's progress bar, announced to assistive technology as a progress bar. */
export function JobProgress({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * The import card of a native PowerPoint import (design/27 §3.4, §5, §10; M3 item H): how many slides are
 * editable, partly pictures or pictures, what LibreOffice still has to draw, fonts to upload, and what was
 * approximated. Follows the import job, its LibreOffice follow-up and, when the deck went to the picture
 * import instead, that job. On a hub without LibreOffice (design/27 M9, `NativeImportResult.libreoffice`)
 * nothing waits for it: the card names what ordo could not draw instead, and says nothing of LibreOffice.
 */
export function PptxImportCard({ id, title }: { id: string; title: string }) {
  const job = useJob(id);
  const result = readNativeResult(job?.result);
  const fallback = readNativeFallback(job?.result);
  const lo = useJob(result?.pending ? result.loJobId : undefined);
  const fallbackJob = useJob(fallback?.jobId);
  const pid = result?.presentationId;
  const presentation = useLibrary((s) => (pid ? s.data.presentations.find((p) => p.id === pid) : undefined));
  const [showLog, setShowLog] = useState(false);
  return (
    <PptxImportCardView
      title={title}
      job={job}
      result={result}
      fallback={fallback}
      fallbackJob={fallbackJob}
      lo={lo}
      presentation={presentation}
      showLog={showLog}
      onToggleLog={() => setShowLog(!showLog)}
      onOpen={(p) => navigate({ name: 'edit', id: p })}
    />
  );
}

export function PptxImportCardView(props: {
  title: string;
  job: Job | undefined;
  result?: NativeImportResult;
  fallback?: NativeImportFallback;
  fallbackJob?: Job;
  lo?: Job;
  presentation?: Pick<Presentation, 'sections'>;
  showLog: boolean;
  onToggleLog(): void;
  onOpen(presentationId: string): void;
}) {
  const { job, result, fallback, fallbackJob } = props;
  const state = job?.state ?? 'queued';
  const pid = result?.presentationId ?? jobResultPresentationId(fallbackJob);
  return (
    <section
      className="card col"
      style={{ gap: 6 }}
      aria-label={`PowerPoint import: ${props.title}`}
      data-pptx-import
    >
      <div className="row">
        <b className="grow ellipsis">{props.title}</b>
        <span className={`tag ${stateTone(state)}`}>{state}</span>
      </div>
      <JobProgress value={job?.progress ?? 0} label="Import progress" />
      {job?.error && (
        <div className="banner red small" role="alert">
          {job.error}
        </div>
      )}
      {result && <NativeSummary result={result} lo={props.lo} presentation={props.presentation} />}
      {fallback && (
        <div className="banner small" role="status">
          The slides could not be made editable here
          {fallback.reason ? ` (${fallback.reason})` : ''}: they are imported as pictures with LibreOffice
          instead
          {fallbackJob ? ` (${fallbackJob.state}).` : '.'}
          {fallbackJob?.error ? ` ${fallbackJob.error}` : ''}
        </div>
      )}
      <div className="row wrap">
        {pid && (
          <button type="button" className="small primary" onClick={() => props.onOpen(pid)}>
            Open presentation
          </button>
        )}
        {job?.log.length ? (
          <button type="button" className="small" aria-expanded={props.showLog} onClick={props.onToggleLog}>
            {props.showLog ? 'Hide log' : `Log (${job.log.length} lines)`}
          </button>
        ) : null}
      </div>
      {props.showLog && job && <div className="logbox">{job.log.join('\n')}</div>}
    </section>
  );
}

/** The import's result: per-class counts, compact slides, LibreOffice work, fonts and approximations. */
function NativeSummary(props: {
  result: NativeImportResult;
  lo?: Job;
  presentation?: Pick<Presentation, 'sections'>;
}) {
  const r = props.result;
  const lo = loStatus(r.pending, props.lo);
  const approx = props.presentation ? approximatedSlides(props.presentation) : { slides: [], more: 0 };
  const hidden = props.presentation ? hiddenCount(props.presentation) : 0;
  const noLo = r.libreoffice === false;
  // What ordo could not draw: from the slides when the presentation is here (it may have changed since).
  const gaps = props.presentation
    ? missingSummary(props.presentation)
    : { slides: r.missing ?? 0, kinds: [] };
  const missing = missingLine(gaps.slides, gaps.kinds);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span>{plural(r.slides, 'slide')}:</span>
        <ul
          className="row wrap"
          aria-label="Slides by kind"
          style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}
        >
          {classCounts(r).map((c) => (
            <li key={c.cls}>
              <span className={`tag ${c.count ? c.tone : ''}`} data-class={c.cls}>
                {c.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {r.hybrid > 0 &&
        (noLo ? (
          <span className="muted small">
            Partly drawn: what ordo cannot draw is left out, and each slide says what; the rest of the slide
            is editable.
          </span>
        ) : (
          <span className="muted small">
            Partly pictures: what ordo cannot edit (a chart, SmartArt, 3D or WordArt) is a picture drawn by
            LibreOffice; the rest of the slide is editable.
          </span>
        ))}
      {r.picture > 0 && (
        <span className="muted small">
          {noLo
            ? 'Not drawn: ordo could not rebuild these slides, so they keep only their text, for search.'
            : 'Pictures: ordo could not rebuild these slides, so they show a picture of the PowerPoint slide.'}
        </span>
      )}
      {missing && (
        <div className="banner small" role="status" data-missing>
          {missing}
        </div>
      )}
      {hidden > 0 && (
        <span className="muted small" data-hidden-count>
          {plural(hidden, 'hidden slide')}: Next skips them during the service and a click in the slide grid
          shows them, as in PowerPoint.
        </span>
      )}
      {r.compact > 0 && (
        <div className="banner small">
          {noLo
            ? `${plural(r.compact, 'slide')} kept only ${r.compact === 1 ? 'its' : 'their'} text to keep the presentation small enough to send to every screen.`
            : `${plural(r.compact, 'slide')} became ${r.compact === 1 ? 'a picture' : 'pictures'} to keep the presentation small enough to send to every screen.`}
        </div>
      )}
      {lo && (
        <div className={bannerClass(lo.tone)} role="status" data-lo-status>
          {lo.text}
          {lo.detail && <div className="small">{lo.detail}</div>}
        </div>
      )}
      {r.missingFonts.length > 0 && (
        <div className="col" style={{ gap: 4 }} data-missing-fonts>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {r.missingFonts.map((f) => (
              <li key={f}>Upload {f} for exact line breaks.</li>
            ))}
          </ul>
          <a className="btn small" href="#/library/fonts" style={{ alignSelf: 'flex-start' }}>
            Upload fonts
          </a>
        </div>
      )}
      {approx.slides.length > 0 && (
        <details data-approximated>
          <summary>Approximated on {plural(approx.slides.length + approx.more, 'slide')}</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {approx.slides.map((s) => (
              <li key={s.slideId}>
                <b>
                  Slide {s.number}
                  {s.hidden ? ' (hidden)' : ''}
                </b>
                : {s.notes.join('; ')}
              </li>
            ))}
          </ul>
          {approx.more > 0 && <span className="muted small">…and {plural(approx.more, 'more slide')}.</span>}
        </details>
      )}
      {r.notes.length > 0 && (
        <details data-import-notes>
          <summary>Import notes ({r.notes.length})</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {r.notes.map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the notes are fixed once the job is done
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

import type { Presentation } from '@ordo/domain';
import type { PptxReimportPlan } from '@ordo/protocol';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { Check } from '../../components/fields.tsx';
import {
  type ApproximatedSlide,
  approximatedSlides,
  classCounts,
  type ImportReport,
  importReport,
  missingSlideFonts,
  plural,
} from '../../lib/pptxImport.ts';
import { planSummary, reimportPlan } from '../../lib/pptxReimport.ts';
import { useLibrary } from '../../state/library.ts';
import { errorText } from '../../state/toasts.ts';
import { JobProgress } from '../library/PptxImportCard.tsx';
import { selectSlide, useEditor } from './editorStore.ts';
import { type ReimportRun, reimportRunning, startReimport, useReimport } from './pptxJobs.ts';

/**
 * The Presentation panel's PowerPoint report (design/27 §11 item 12, §15 M4; M4 item F): what the import
 * made of the deck (`source.native` counts, legacy picture pages), what waits for LibreOffice or failed, the
 * fonts the hub lacks, the slides it approximated (each opens its slide), the import log (`source.log`), and
 * 'Re-import from PowerPoint…' with its dialog (the plan, made-editable slides each with 'Keep as it is').
 * Only for a presentation imported from PowerPoint.
 */
export function PptxReport({ p, readOnly }: { p: Presentation; readOnly: boolean }) {
  const fonts = useLibrary((s) => s.data.fonts);
  const run = useReimport((s) => s.runs[p.id]);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLElement>(null);
  const report = useMemo(() => importReport(p), [p]);
  const approx = useMemo(() => approximatedSlides(p), [p]);
  const missing = useMemo(
    () =>
      missingSlideFonts(
        p.sections.flatMap((s) => s.slides),
        fonts.map((f) => f.family),
      ),
    [p, fonts],
  );
  if (!report) return null;
  const close = () => {
    setOpen(false);
    // Focus goes back where the volunteer was: the button, or the report while the re-import runs.
    requestAnimationFrame(() => {
      const b = opener.current;
      (b && !b.disabled ? b : region.current)?.focus();
    });
  };
  return (
    <>
      <PptxReportView
        report={report}
        approx={approx}
        missingFonts={missing}
        readOnly={readOnly}
        run={run}
        openerRef={opener}
        regionRef={region}
        onReimport={() => setOpen(true)}
        onOpenSlide={(id) => selectSlide(id)}
      />
      {open && <ReimportDialog p={p} onClose={close} />}
    </>
  );
}

export function PptxReportView(props: {
  report: ImportReport;
  approx: { slides: ApproximatedSlide[]; more: number };
  missingFonts: readonly string[];
  readOnly: boolean;
  /** The re-import followed in this visit. */
  run?: ReimportRun;
  openerRef?: RefObject<HTMLButtonElement | null>;
  /** The report itself, focused when the dialog closes on a running re-import (its button disabled). */
  regionRef?: RefObject<HTMLElement | null>;
  onReimport(): void;
  onOpenSlide(slideId: string): void;
}) {
  const { report: r, approx, run } = props;
  const running = reimportRunning(run);
  const whole = run?.what === 'reimport';
  return (
    <section
      className="card col small"
      aria-label="Imported from PowerPoint"
      ref={props.regionRef}
      tabIndex={-1}
      data-pptx-report
    >
      <b>Imported from PowerPoint</b>
      {r.native ? (
        <ul className="row" style={{ listStyle: 'none', margin: 0, padding: 0, flexWrap: 'wrap' }}>
          {classCounts(r.native).map((c) => (
            <li key={c.cls}>
              <span className={`tag ${c.count ? c.tone : ''}`} data-class={c.cls}>
                {c.text}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <span data-legacy>
          Imported as pictures ({r.renderer === 'pptx-preview' ? 'pptx-preview' : 'LibreOffice'}): its text is
          not editable. Re-import from PowerPoint to make the slides editable.
        </span>
      )}
      {r.native && r.pages > 0 && (
        <span>
          {plural(r.pages, 'picture slide')} from an earlier import: a re-import makes them editable.
        </span>
      )}
      {r.hidden > 0 && (
        <span className="muted">
          {plural(r.hidden, 'hidden slide')}: Next skips them, a click in the slide grid shows them.
        </span>
      )}
      {r.edited > 0 && (
        <span className="muted" data-edited-count>
          {plural(r.edited, 'slide')} edited in ordo since the import: a re-import keeps{' '}
          {r.edited === 1 ? 'it' : 'them'} as {r.edited === 1 ? 'it is' : 'they are'}.
        </span>
      )}
      {r.pending > 0 && (
        <div className="banner small" role="status">
          LibreOffice is still drawing part of {plural(r.pending, 'slide')}.
        </div>
      )}
      {r.failed > 0 && (
        <div className="banner small" data-failed>
          LibreOffice could not draw {plural(r.failed, 'slide')}: {r.failed === 1 ? 'it shows' : 'they show'}{' '}
          what ordo rebuilt. Reset a slide from PowerPoint, or re-import, to try again.
        </div>
      )}
      {props.missingFonts.length > 0 && (
        <div className="col" style={{ gap: 4 }} data-missing-fonts>
          <span>Fonts this hub does not have (lines can break elsewhere than in PowerPoint):</span>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {props.missingFonts.map((f) => (
              <li key={f}>{f}</li>
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
                <button type="button" className="small ghost" onClick={() => props.onOpenSlide(s.slideId)}>
                  Slide {s.number}
                  {s.hidden ? ' (hidden)' : ''}
                </button>
                : {s.notes.join('; ')}
              </li>
            ))}
          </ul>
          {approx.more > 0 && <span className="muted">…and {plural(approx.more, 'more slide')}.</span>}
        </details>
      )}
      {r.log.length > 0 && (
        <details data-import-log>
          <summary>Import log ({plural(r.log.length + r.logMore, 'line')})</summary>
          {r.logMore > 0 && (
            <span className="muted">The {plural(r.logMore, 'older line')} are left out.</span>
          )}
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {r.log.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the log is fixed until the next import
              <li key={i}>
                {l.warn && <span className="tag amber">warning</span>} {l.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      {running && whole && (
        <div className="col" style={{ gap: 4 }} role="status" data-reimport-status>
          <span>
            {run?.state === 'queued'
              ? 'The re-import waits for its turn.'
              : `Re-importing from PowerPoint (${Math.round((run?.progress ?? 0) * 100)}%).`}
          </span>
          <JobProgress value={run?.progress ?? 0} label="Re-import from PowerPoint" />
        </div>
      )}
      {run?.state === 'failed' && whole && (
        <div className="banner red small" role="alert">
          The re-import failed{run.error ? `: ${run.error}` : '.'}
        </div>
      )}
      <button
        type="button"
        className="small"
        ref={props.openerRef}
        disabled={props.readOnly || running}
        onClick={props.onReimport}
        style={{ alignSelf: 'flex-start' }}
      >
        Re-import from PowerPoint…
      </button>
      <span className="muted">
        {props.readOnly
          ? 'The presentation can be re-imported after the service.'
          : running && !whole
            ? 'A slide of this presentation is being rebuilt from PowerPoint.'
            : 'Converts the stored PowerPoint file again: slides not edited in ordo and picture slides are rebuilt.'}
      </span>
    </section>
  );
}

/** The dialog's state while its plan loads. */
type PlanState = { plan?: PptxReimportPlan; error?: string };

/** 'Re-import from PowerPoint…': the plan (`GET`), the made-editable slides to keep, then the job. */
function ReimportDialog({ p, onClose }: { p: Presentation; onClose(): void }) {
  const dirty = useEditor((s) => s.dirty);
  const [state, setState] = useState<PlanState>({});
  const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    reimportPlan(p.id).then(
      (plan) => {
        if (!gone) setState(plan ? { plan } : { error: 'The hub did not say what a re-import would do.' });
      },
      (e) => {
        if (!gone) setState({ error: errorText(e) });
      },
    );
    return () => {
      gone = true;
    };
  }, [p.id]);
  const confirm = async () => {
    setBusy(true);
    const ok = await startReimport(p, keep.size ? { keep: [...keep] } : {}, 'reimport');
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <ReimportDialogView
      {...state}
      keep={keep}
      dirty={dirty}
      busy={busy}
      onKeep={(id, on) =>
        setKeep((k) => {
          const next = new Set(k);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        })
      }
      onConfirm={() => void confirm()}
      onClose={onClose}
    />
  );
}

export function ReimportDialogView(props: {
  plan?: PptxReimportPlan;
  error?: string;
  /** Made-editable slides ticked 'Keep as it is'. */
  keep: ReadonlySet<string>;
  /** Unsaved edits (saved first). */
  dirty: boolean;
  busy?: boolean;
  onKeep(slideId: string, keep: boolean): void;
  onConfirm(): void;
  onClose(): void;
}) {
  const { plan } = props;
  const sum = plan ? planSummary(plan) : undefined;
  const changes = sum
    ? sum.rebuild + sum.pages + sum.madeEditable.filter((s) => !props.keep.has(s.slideId)).length
    : 0;
  return (
    <Dialog
      title="Re-import from PowerPoint"
      onClose={props.onClose}
      width={560}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!sum || !changes || props.busy}
            onClick={props.onConfirm}
            autoFocus
          >
            Re-import
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 8 }} data-reimport-dialog>
        {!plan && !props.error && <span role="status">Reading what a re-import would do…</span>}
        {props.error && (
          <div className="banner red small" role="alert">
            {props.error}
          </div>
        )}
        {sum && (
          <>
            <span>ordo converts the PowerPoint file this presentation was imported from again.</span>
            <ul style={{ margin: 0, paddingLeft: 18 }} data-plan>
              {sum.rebuild > 0 && (
                <li>
                  {plural(sum.rebuild, 'slide')} not edited in ordo {sum.rebuild === 1 ? 'is' : 'are'} rebuilt
                  from it.
                </li>
              )}
              {sum.pages > 0 && (
                <li>
                  {plural(sum.pages, 'picture slide')}{' '}
                  {sum.pages === 1 ? 'becomes an editable slide' : 'become editable slides'}.
                </li>
              )}
              {sum.keptEdited > 0 && (
                <li>
                  {plural(sum.keptEdited, 'slide')} edited in ordo {sum.keptEdited === 1 ? 'stays' : 'stay'}{' '}
                  as {sum.keptEdited === 1 ? 'it is' : 'they are'} ('Reset slide from PowerPoint' rebuilds
                  one).
                </li>
              )}
              {sum.other > 0 && (
                <li>
                  {plural(sum.other, 'other slide')} (not from this file){' '}
                  {sum.other === 1 ? 'stays as it is' : 'stay as they are'}.
                </li>
              )}
              <li>
                Slide notes, timings, backgrounds, sections and arrangements are kept
                {sum.userObjects > 0
                  ? `, and ${plural(sum.userObjects, 'object')} added in ordo stay on top`
                  : ''}
                .
              </li>
            </ul>
            {sum.madeEditable.length > 0 && (
              <fieldset className="col" style={{ gap: 4 }} data-made-editable>
                <legend>Slides made editable before</legend>
                <span className="muted">
                  Their page picture and the text boxes that repeat the PowerPoint text are replaced by the
                  rebuilt slide; anything else on them stays on top. Keep a slide to leave it as it is.
                </span>
                {sum.madeEditable.map((s) => (
                  <Check
                    key={s.slideId}
                    label={`Slide ${s.number}: keep as it is`}
                    value={props.keep.has(s.slideId)}
                    onChange={(v) => props.onKeep(s.slideId, v)}
                  />
                ))}
              </fieldset>
            )}
            {!changes && (
              <span role="status">
                Nothing to re-import: no slide comes unedited from the PowerPoint file.
              </span>
            )}
            <span className="muted">
              The re-import saves a new revision: History can bring back the presentation as it is now.
              {props.dirty ? ' Your unsaved changes are saved first.' : ''}
            </span>
          </>
        )}
      </div>
    </Dialog>
  );
}

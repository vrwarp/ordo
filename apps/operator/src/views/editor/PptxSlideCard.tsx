import type { Presentation, Slide } from '@ordo/domain';
import type { HubCapabilities } from '@ordo/protocol';
import { confirmDialog } from '../../components/Confirm.tsx';
import { Check } from '../../components/fields.tsx';
import { useHubCaps } from '../../lib/hubCaps.ts';
import {
  canDrawOriginal,
  missingSlideFonts,
  missingText,
  offersReferencePdf,
  originalMediaId,
  showsPicture,
  slideClassText,
  slideEdited,
  slideMissing,
} from '../../lib/pptxImport.ts';
import { useLibrary } from '../../state/library.ts';
import { setSlideShows } from './actions.ts';
import { useEditor } from './editorStore.ts';
import {
  type ReferenceJob,
  referenceRunning,
  requestOriginals,
  requestOriginalsPdf,
  setShowOriginal,
  useOriginal,
} from './original.ts';
import { type ReimportRun, reimportRunning, startReimport, useReimport } from './pptxJobs.ts';

/**
 * The PowerPoint card of a slide imported natively (design/27 §5, §11 item 12; M3 item H, M4 item F): what
 * kind of slide it became, what the import approximated (`Slide.pptx.notes`), LibreOffice work still to
 * come, the fonts this hub lacks for it ('Upload font', the Fonts tab), 'Show original' (the PowerPoint
 * picture over the slide in the editor, to compare), 'Show the PowerPoint picture on the screens'
 * (`Slide.pptx.show`; it warns when the slide was edited, since the picture does not show edits, and asks
 * LibreOffice for the pictures when there are none yet) and 'Reset slide from PowerPoint' (a re-import of
 * this slide, `reset`).
 *
 * Design/27 M9: what nothing draws on the slide ('Not drawn: a chart', `Slide.pptx.missing`); on a hub
 * without LibreOffice (`useHubCaps`) 'Show original' needs a picture the slide already has, and the card offers
 * 'Add PowerPoint's pictures (PDF)…' instead of asking LibreOffice.
 */
export function PptxSlideCard({ slide, p, readOnly }: { slide: Slide; p: Presentation; readOnly: boolean }) {
  const caps = useHubCaps();
  const on = useOriginal((s) => !!s.on[p.id]);
  const job = useOriginal((s) => s.jobs[p.id]);
  const dirty = useEditor((s) => s.dirty);
  const fonts = useLibrary((s) => s.data.fonts);
  const run = useReimport((s) => s.runs[p.id]);
  if (!slide.pptx) return null;
  const edited = slideEdited(slide);
  const savedFirst = dirty ? '\n\nYour changes are saved first.' : '';
  const toggle = async (next: boolean) => {
    if (!next || originalMediaId(slide) || referenceRunning(job)) {
      setShowOriginal(p.id, next);
      return;
    }
    const ok = await confirmDialog(
      'Show the original slides',
      `LibreOffice draws every slide of this presentation as PowerPoint shows it, so you can compare. This takes a minute or two and does not change what the screens show.${savedFirst}`,
      'Draw the originals',
    );
    if (ok) await requestOriginals(p);
  };
  const onScreens = async () => {
    const warn = edited
      ? ' It shows the slide as it was imported: the changes made in ordo since do not show (objects added in ordo still show over it).'
      : '';
    if (originalMediaId(slide)) {
      if (
        edited &&
        !(await confirmDialog(
          'Show the PowerPoint picture',
          `The screens show the PowerPoint picture of this slide instead of its objects.${warn}`,
          'Show the picture',
        ))
      )
        return;
      setSlideShows(slide.id, 'picture');
      return;
    }
    const ok = await confirmDialog(
      'Show the PowerPoint picture',
      `LibreOffice first draws every slide of this presentation as PowerPoint shows it (a minute or two); then the screens show this slide's picture instead of its objects.${warn}${savedFirst}`,
      'Draw the pictures',
    );
    if (ok) await requestOriginals(p, [slide.id]);
  };
  const reset = async () => {
    const ok = await confirmDialog(
      'Reset slide from PowerPoint',
      `The slide becomes again what the PowerPoint file has: the changes made to its text, pictures and shapes in ordo are replaced. Objects you added in ordo stay on top, and its notes, timing and background stay. History keeps the slide as it is now.${savedFirst}`,
      'Reset slide',
      true,
    );
    if (ok) await startReimport(p, { slideIds: [slide.id], reset: [slide.id] }, 'reset', slide.id);
  };
  return (
    <PptxSlideCardView
      slide={slide}
      readOnly={readOnly}
      on={on}
      job={job}
      edited={edited}
      missingFonts={missingSlideFonts(
        [slide],
        fonts.map((f) => f.family),
      )}
      reimport={run}
      caps={caps}
      onAddPdf={(file) => void requestOriginalsPdf(p, file)}
      onToggle={(next) => void toggle(next)}
      onShowPicture={() => void onScreens()}
      onShowObjects={() => !readOnly && setSlideShows(slide.id, 'objects')}
      onReset={() => void reset()}
    />
  );
}

export function PptxSlideCardView(props: {
  slide: Slide;
  readOnly: boolean;
  /** 'Show original' is on for this presentation. */
  on: boolean;
  /** The reference job asked for in this visit. */
  job?: ReferenceJob;
  /** The slide's imported objects changed since the import (`slideEdited`). */
  edited?: boolean;
  /** Families of the slide's text this hub cannot draw with their own widths (`missingSlideFonts`). */
  missingFonts?: readonly string[];
  /** The presentation's re-import followed in this visit (a 'Reset slide' of this slide shows here). */
  reimport?: ReimportRun;
  /** What the hub's tools allow (design/27 M9); undefined: not known yet (LibreOffice assumed). */
  caps?: HubCapabilities;
  /** 'Add PowerPoint's pictures (PDF)…': the PDF chosen. */
  onAddPdf?(file: File): void;
  onToggle(on: boolean): void;
  onShowObjects(): void;
  onShowPicture?(): void;
  onReset?(): void;
}) {
  const { slide, job, edited = false, reimport } = props;
  const pptx = slide.pptx;
  if (!pptx) return null;
  const gaps = slideMissing(slide);
  const cls = slideClassText(pptx.class, gaps.length > 0);
  const notDrawn = missingText(gaps);
  const notes = (pptx.notes ?? []).filter((n) => n.trim());
  const fonts = props.missingFonts ?? [];
  const has = !!originalMediaId(slide);
  const running = referenceRunning(job);
  const drawable = canDrawOriginal(slide, props.caps);
  const pdf = offersReferencePdf(slide, props.caps) && !!props.onAddPdf;
  // Showing a picture that exists never writes; drawing the pictures saves a revision, so not while live.
  const disabled = !has && !running && (!drawable || props.readOnly);
  let hint: string;
  if (running)
    hint =
      props.caps && !props.caps.pptx.reference
        ? `The PowerPoint pictures are made from the PDF (${Math.round((job?.progress ?? 0) * 100)}%).`
        : `LibreOffice is drawing the PowerPoint pictures (${Math.round((job?.progress ?? 0) * 100)}%).`;
  else if (has)
    hint = props.on
      ? 'The canvas shows the PowerPoint slide as LibreOffice draws it. The screens still show the slide as rebuilt.'
      : 'Compare this slide with the PowerPoint slide.';
  else if (!canDrawOriginal(slide)) hint = 'A hidden slide has no PowerPoint picture to compare with.';
  else if (!drawable)
    hint = pdf
      ? 'Export the deck as PDF from PowerPoint to compare with the original.'
      : 'This hub has no LibreOffice to draw the PowerPoint pictures.';
  else if (props.readOnly) hint = 'The PowerPoint pictures can be drawn after the service.';
  else hint = 'LibreOffice first draws every slide of the presentation as PowerPoint shows it.';
  const resetting = !!reimport && reimportRunning(reimport) && reimport.slideId === slide.id;
  const busy = reimportRunning(reimport);
  // Showing the picture needs one that exists (a write) or LibreOffice to draw it (a revision): not while live.
  const canShowPicture =
    pptx.class !== 'picture' && !showsPicture(slide) && (has || drawable) && !!props.onShowPicture;
  let resetHint: string;
  if (resetting)
    resetHint = `Resetting the slide from the PowerPoint file (${Math.round((reimport?.progress ?? 0) * 100)}%).`;
  else if (props.readOnly) resetHint = 'The slide can be reset after the service.';
  else if (busy) resetHint = 'A re-import of this presentation is running.';
  else if (edited || pptx.failed)
    resetHint = 'Brings back the slide as the PowerPoint file has it. Objects you added in ordo stay on top.';
  else resetHint = 'Nothing to reset: the slide is as it was imported.';
  return (
    <section className="card col small" aria-label="From PowerPoint" data-pptx-card>
      <div className="row">
        <b className="grow">From PowerPoint</b>
        <span className={`tag ${cls.tone}`} data-class={pptx.class}>
          {cls.label}
        </span>
      </div>
      <span className="muted">{cls.text}</span>
      {notDrawn && (
        <span data-missing>
          <b>{notDrawn}</b>
        </span>
      )}
      {edited && (
        <span className="muted" data-edited>
          Edited in ordo since the import.
        </span>
      )}
      {pptx.pending && (
        <div className="banner small" role="status">
          LibreOffice is still drawing part of this slide; it appears when it is ready.
        </div>
      )}
      {pptx.failed && !pptx.pending && (
        <div className="banner small" data-failed>
          LibreOffice could not draw part of this slide: it shows what ordo rebuilt. Reset the slide from
          PowerPoint to try again.
        </div>
      )}
      {notes.length > 0 && (
        <div className="col" style={{ gap: 2 }} data-pptx-notes>
          <span>What was approximated</span>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {notes.map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a slide's notes are fixed by its import
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {fonts.length > 0 && (
        <div className="col" style={{ gap: 4 }} data-missing-fonts>
          <span>
            {fonts.length === 1 ? 'A font' : 'Fonts'} this hub does not have: {fonts.join(', ')}. The text is
            drawn in another font, so its lines can break elsewhere than in PowerPoint.
          </span>
          <a className="btn small" href="#/library/fonts" style={{ alignSelf: 'flex-start' }}>
            Upload font
          </a>
        </div>
      )}
      {pptx.class !== 'picture' && (
        <div className="col" style={{ gap: 2 }}>
          <Check
            label="Show original"
            value={props.on && (has || running)}
            disabled={disabled}
            onChange={props.onToggle}
          />
          <span className="muted" role={running ? 'status' : undefined}>
            {hint}
          </span>
        </div>
      )}
      {pdf && (
        <label className={`btn small${props.readOnly || running ? ' disabled' : ''}`} data-reference-pdf>
          Add PowerPoint's pictures (PDF)…
          <input
            type="file"
            accept=".pdf,application/pdf"
            hidden
            disabled={props.readOnly || running}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) props.onAddPdf?.(f);
            }}
          />
        </label>
      )}
      {job?.state === 'failed' && (
        <div className="banner red small" role="alert">
          {props.caps && !props.caps.pptx.reference
            ? "The PDF's pages could not be used as the PowerPoint pictures"
            : 'LibreOffice could not draw the PowerPoint pictures'}
          {job.error ? `: ${job.error}` : '.'}
        </div>
      )}
      {canShowPicture && (
        <div className="col" style={{ gap: 2 }} data-show-picture>
          <button
            type="button"
            className="small"
            disabled={props.readOnly || running}
            onClick={props.onShowPicture}
            style={{ alignSelf: 'flex-start' }}
          >
            Show the PowerPoint picture on the screens
          </button>
          <span className="muted">
            {edited
              ? 'The picture shows the slide as it was imported, without the changes made in ordo.'
              : 'For a slide ordo does not rebuild closely enough: the screens show the picture instead of its objects.'}
          </span>
        </div>
      )}
      {showsPicture(slide) && (
        <div className="banner small col" style={{ gap: 6 }} data-shows-picture>
          <span>This slide is set to show its PowerPoint picture on the screens instead of its objects.</span>
          {edited && <span>The picture does not show the changes made in ordo since the import.</span>}
          <button
            type="button"
            className="small"
            disabled={props.readOnly}
            onClick={props.onShowObjects}
            style={{ alignSelf: 'flex-start' }}
          >
            Show the objects instead
          </button>
        </div>
      )}
      {props.onReset && (
        <div className="col" style={{ gap: 2 }} data-reset>
          <button
            type="button"
            className="small"
            disabled={props.readOnly || busy || !(edited || pptx.failed)}
            onClick={props.onReset}
            style={{ alignSelf: 'flex-start' }}
          >
            Reset slide from PowerPoint
          </button>
          <span className="muted" role={resetting ? 'status' : undefined}>
            {resetHint}
          </span>
        </div>
      )}
      {reimport?.state === 'failed' && reimport.slideId === slide.id && (
        <div className="banner red small" role="alert">
          The slide could not be reset from PowerPoint{reimport.error ? `: ${reimport.error}` : '.'}
        </div>
      )}
    </section>
  );
}

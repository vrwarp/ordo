import type { Presentation, Slide } from '@ordo/domain';
import { confirmDialog } from '../../components/Confirm.tsx';
import { Check } from '../../components/fields.tsx';
import {
  canDrawOriginal,
  originalMediaId,
  showObjects,
  showsPicture,
  slideClassText,
} from '../../lib/pptxImport.ts';
import { change, useEditor } from './editorStore.ts';
import { updateSlide } from './ops.ts';
import {
  type ReferenceJob,
  referenceRunning,
  requestOriginals,
  setShowOriginal,
  useOriginal,
} from './original.ts';

/**
 * The PowerPoint card of a slide imported natively (design/27 §5, §11 item 12; M3 item H): what kind of slide
 * it became, what the import approximated (`Slide.pptx.notes`), LibreOffice work still to come, and
 * 'Show original' (the PowerPoint picture over the slide, to compare).
 */
export function PptxSlideCard({ slide, p, readOnly }: { slide: Slide; p: Presentation; readOnly: boolean }) {
  const on = useOriginal((s) => !!s.on[p.id]);
  const job = useOriginal((s) => s.jobs[p.id]);
  const dirty = useEditor((s) => s.dirty);
  if (!slide.pptx) return null;
  const toggle = async (next: boolean) => {
    if (!next || originalMediaId(slide) || referenceRunning(job)) {
      setShowOriginal(p.id, next);
      return;
    }
    const ok = await confirmDialog(
      'Show the original slides',
      `LibreOffice draws every slide of this presentation as PowerPoint shows it, so you can compare. This takes a minute or two and does not change what the screens show.${dirty ? '\n\nYour changes are saved first.' : ''}`,
      'Draw the originals',
    );
    if (ok) await requestOriginals(p);
  };
  return (
    <PptxSlideCardView
      slide={slide}
      readOnly={readOnly}
      on={on}
      job={job}
      onToggle={(next) => void toggle(next)}
      onShowObjects={() => !readOnly && change((q) => updateSlide(q, slide.id, showObjects))}
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
  onToggle(on: boolean): void;
  onShowObjects(): void;
}) {
  const { slide, job } = props;
  const pptx = slide.pptx;
  if (!pptx) return null;
  const cls = slideClassText(pptx.class);
  const notes = (pptx.notes ?? []).filter((n) => n.trim());
  const has = !!originalMediaId(slide);
  const running = referenceRunning(job);
  const drawable = canDrawOriginal(slide);
  // Showing a picture that exists never writes; drawing the pictures saves a revision, so not while live.
  const disabled = !has && !running && (!drawable || props.readOnly);
  let hint: string;
  if (running)
    hint = `LibreOffice is drawing the PowerPoint pictures (${Math.round((job?.progress ?? 0) * 100)}%).`;
  else if (has)
    hint = props.on
      ? 'The canvas shows the PowerPoint slide as LibreOffice draws it. The screens still show the slide as rebuilt.'
      : 'Compare this slide with the PowerPoint slide.';
  else if (!drawable) hint = 'A hidden slide has no PowerPoint picture to compare with.';
  else if (props.readOnly) hint = 'The PowerPoint pictures can be drawn after the service.';
  else hint = 'LibreOffice first draws every slide of the presentation as PowerPoint shows it.';
  return (
    <section className="card col small" aria-label="From PowerPoint" data-pptx-card>
      <div className="row">
        <b className="grow">From PowerPoint</b>
        <span className={`tag ${cls.tone}`} data-class={pptx.class}>
          {cls.label}
        </span>
      </div>
      <span className="muted">{cls.text}</span>
      {pptx.pending && (
        <div className="banner small" role="status">
          LibreOffice is still drawing part of this slide; it appears when it is ready.
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
      {job?.state === 'failed' && (
        <div className="banner red small" role="alert">
          LibreOffice could not draw the PowerPoint pictures{job.error ? `: ${job.error}` : '.'}
        </div>
      )}
      {showsPicture(slide) && (
        <div className="banner small col" style={{ gap: 6 }} data-shows-picture>
          <span>This slide is set to show its PowerPoint picture on the screens instead of its objects.</span>
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
    </section>
  );
}

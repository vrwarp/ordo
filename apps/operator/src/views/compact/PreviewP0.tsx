import { useMemo } from 'react';
import { t } from '../../i18n/index.ts';
import { flatSlides } from '../../lib/lookPreviews.ts';
import { useLibrary } from '../../state/library.ts';
import { navigate } from '../../useRoute.ts';
import { LookPreviews } from '../editor/LookPreviews.tsx';
import { Icon } from './icons.tsx';

/**
 * A presentation's slides on every screen, one slide at a time (design/28 §2.2; P1's slide preview through the
 * Stage lens replaces it): Previous and Next, "Slide 3 of 8", and the slide under each look in settings as the
 * outputs draw it (LookPreviews as it is, with its loop rules and the Bottom-Third Stream's own text). The slide
 * comes from `#/previews/<id>/<slideId>`; stepping replaces the history entry, so Back leaves the previews.
 * No side list and no "Open in editor": the canvas editor never opens on a phone.
 */
export function PreviewP0({ id, slideId }: { id?: string; slideId?: string }) {
  const presentation = useLibrary((s) => s.data.presentations.find((p) => p.id === id));
  const slides = useMemo(() => (presentation ? flatSlides(presentation) : []), [presentation]);
  if (!presentation)
    return (
      <div className="compact-body">
        <p className="compact-empty">{t('preview.missing')}</p>
      </div>
    );
  if (!slides.length)
    return (
      <div className="compact-body">
        <p className="compact-empty">{t('preview.noSlides')}</p>
      </div>
    );
  const found = slides.findIndex((s) => s.id === slideId);
  const index = Math.max(found, 0);
  const activeSlide = slides[index]!;
  const speakerNotes = activeSlide.notes?.trim() ?? '';
  const step = (d: number) => {
    const next = slides[index + d];
    if (next) navigate({ name: 'previews', id: presentation.id, slideId: next.id }, { replace: true });
  };
  return (
    <div className="compact-body compact-preview" data-compact-preview>
      <div className="compact-stepper">
        <button type="button" className="compact-step" onClick={() => step(-1)} disabled={index === 0}>
          <Icon name="previous" />
          <span>{t('preview.previous')}</span>
        </button>
        <span className="compact-position" aria-live="polite" data-slide-position>
          {t('preview.position', { n: index + 1, total: slides.length })}
        </span>
        <button
          type="button"
          className="compact-step"
          onClick={() => step(1)}
          disabled={index === slides.length - 1}
        >
          <span>{t('preview.next')}</span>
          <Icon name="next" />
        </button>
      </div>
      {speakerNotes && (
        <section className="compact-notes-card" data-compact-notes aria-label={t('preview.notes')}>
          <div className="compact-notes-head">{t('preview.notes')}</div>
          <div className="compact-notes-body" dir="auto">
            {speakerNotes}
          </div>
        </section>
      )}
      <LookPreviews presentation={presentation} slideId={activeSlide.id} />
    </div>
  );
}

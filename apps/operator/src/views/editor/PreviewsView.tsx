import type { Presentation, Slide } from '@ordo/domain';
import { firstText } from '@ordo/domain';
import { useMemo, useState } from 'react';
import { useMediaLookup, useVisible } from '../../hooks.ts';
import { flatSlides } from '../../lib/lookPreviews.ts';
import { stillHash, useThumb } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import { navigate } from '../../useRoute.ts';
import { LookPreviews } from './LookPreviews.tsx';

function StripSlide(props: { p: Presentation; slide: Slide; index: number; selected: boolean }) {
  const media = useMediaLookup();
  const [ref, visible] = useVisible<HTMLButtonElement>();
  const bgId = props.slide.backgroundMediaId ?? props.p.backgroundMediaId;
  const url = useThumb(
    props.slide,
    { isSong: props.p.kind === 'song', media, bg: bgId ? stillHash(media(bgId)) : undefined, width: 320 },
    visible,
  );
  const text = firstText(props.slide);
  return (
    <button
      ref={ref}
      type="button"
      className={`preview-strip-slide${props.selected ? ' sel' : ''}`}
      aria-pressed={props.selected}
      aria-label={`Slide ${props.index + 1}${text ? `: ${text.split('\n')[0]}` : ''}`}
      onClick={() => navigate({ name: 'previews', id: props.p.id, slideId: props.slide.id })}
    >
      {url ? <img src={url} alt="" /> : <span className="ph">{text || props.index + 1}</span>}
      <span className="num">{props.index + 1}</span>
    </button>
  );
}

/**
 * Look previews for a whole presentation (design/15 "iPad editing"): pick a song, step through its slides
 * in the strip, and see each one on the main screen, the lobby lower third, the livestream key and the
 * stage display, as the outputs will draw them.
 */
export function PreviewsView({ id, slideId }: { id?: string; slideId?: string }) {
  const presentations = useLibrary((s) => s.data.presentations);
  const [filter, setFilter] = useState('');
  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return presentations
      .filter((p) => !p.archived && (!f || p.title.toLowerCase().includes(f)))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [presentations, filter]);
  const current = presentations.find((p) => p.id === id);
  const slides = current ? flatSlides(current) : [];
  const sel = slides.find((s) => s.id === slideId) ?? slides[0];
  return (
    <div className="split previews-view">
      <div className="side col" style={{ gap: 2 }}>
        <h4>Previews</h4>
        <input
          placeholder="Find a presentation"
          aria-label="Find a presentation"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginBottom: 8 }}
        />
        {list.map((p) => (
          <a
            key={p.id}
            href={`#/previews/${encodeURIComponent(p.id)}`}
            className={p.id === id ? 'active' : ''}
          >
            <span className="ellipsis">{p.title}</span>
          </a>
        ))}
        {!list.length && <span className="muted small">No presentations.</span>}
      </div>
      <div className="col previews-main" style={{ minHeight: 0, overflow: 'auto', padding: 16, gap: 12 }}>
        {current ? (
          <>
            <div className="row">
              <h3 style={{ margin: 0 }} className="grow ellipsis">
                {current.title}
              </h3>
              <button type="button" onClick={() => navigate({ name: 'edit', id: current.id })}>
                Open in editor
              </button>
            </div>
            <div className="preview-strip" role="toolbar" aria-label="Slides">
              {slides.map((s, i) => (
                <StripSlide key={s.id} p={current} slide={s} index={i} selected={s.id === sel?.id} />
              ))}
            </div>
            <LookPreviews presentation={current} slideId={sel?.id} />
          </>
        ) : (
          <div className="center muted">Choose a presentation to see its slides in every look.</div>
        )}
      </div>
    </div>
  );
}

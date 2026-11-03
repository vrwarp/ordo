import { type Cue, firstText, type Look, type Media, type Slide } from '@ordo/domain';
import type { OutputHealthEntry } from '@ordo/protocol';
import { fileUrl } from '@ordo/client';
import { memo } from 'react';
import { useVisible } from '../../hooks.ts';
import { stillHash, useThumb } from '../../services/thumbs.ts';

export type ThumbMarks = {
  live: boolean;
  armed: boolean;
  /** Per-output arm dots (only for the armed/live cue). */
  dots?: { id: string; name: string; dot: string }[];
  waiting?: boolean;
};

/** A slide thumbnail rendered by the worker, with a text fallback until it arrives. */
export const SlideThumb = memo(function SlideThumb(props: {
  slide?: Slide;
  isSong: boolean;
  bgMediaId?: string;
  media: (id: string) => Media | undefined;
  look?: Look;
  label: string;
  number?: number;
  marks: ThumbMarks;
  width: number;
  onClick?: () => void;
  onDoubleClick?: () => void;
  footer?: React.ReactNode;
}) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const bg = props.bgMediaId ? stillHash(props.media(props.bgMediaId)) : undefined;
  const url = useThumb(
    props.slide,
    { isSong: props.isSong, bg, media: props.media, look: props.look, width: props.width >= 260 ? 480 : 320 },
    visible,
  );
  const cls = `thumb ${props.marks.live ? 'live' : ''} ${props.marks.armed && !props.marks.live ? 'armed' : ''}`;
  return (
    <div ref={ref} className={cls} onClick={props.onClick} onDoubleClick={props.onDoubleClick} title={props.label}>
      {url || (!props.slide && bg && visible) ? (
        <div className="img" style={{ backgroundImage: `url(${url ?? fileUrl(bg!)})` }} />
      ) : (
        <div className="fallback-text">{props.slide ? firstText(props.slide) || props.label : props.label}</div>
      )}
      {props.number !== undefined && <span className="num">{props.number}</span>}
      {props.marks.dots && props.marks.dots.length > 0 && (
        <span className="dots">
          {props.marks.dots.map((d) => (
            <span key={d.id} className={`dot sm ${d.dot}`} title={`${d.name}: ${d.dot}`} />
          ))}
        </span>
      )}
      {props.marks.waiting && <span className="wait" title="Waiting for outputs to arm" />}
      <div className="cap">
        <span className="ellipsis grow">{props.label}</span>
        {props.footer}
      </div>
    </div>
  );
});

export type { Cue, OutputHealthEntry };

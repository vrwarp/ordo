import { fileUrl } from '@ordo/client';
import { type Cue, firstText, type Look, type Media, type Slide } from '@ordo/domain';
import type { OutputHealthEntry } from '@ordo/protocol';
import { memo } from 'react';
import { midiTriggerBadge, slideMidiTrigger } from '../../components/MidiTriggerPicker.tsx';
import { useVisible } from '../../hooks.ts';
import type { SectionTone } from '../../lib/sectionColors.ts';
import { stillHash, useThumb } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';

export type ThumbMarks = {
  live: boolean;
  armed: boolean;
  /** Per-output arm dots (only for the armed/live cue). */
  dots?: { id: string; name: string; dot: string }[];
  waiting?: boolean;
  /** Active auto-advance countdown for a live loop slide. */
  autoAdvance?: { durationMs: number; elapsedMs: number; key: string };
};

export type SlideSectionBand = {
  label: string;
  short?: string;
  tone: SectionTone;
  /** True on the first slide of a section group (shows the section badge + label). */
  isFirst?: boolean;
  onJump?: () => void;
  onDoubleJump?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
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
  /** A hidden slide (design/27 §9): drawn dimmed; Next skips it, a click still shows it. */
  hidden?: boolean;
  /** ProPresenter-style color-coded footer band fused onto the slide frame (design/30 §5.1). */
  sectionBand?: SlideSectionBand;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  footer?: React.ReactNode;
}) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const midiPresets = useLibrary((s) => s.data.settings.surfaces.midiPresets);
  const midiBadge = props.slide ? midiTriggerBadge(slideMidiTrigger(props.slide), midiPresets) : null;
  const bg = props.bgMediaId ? stillHash(props.media(props.bgMediaId)) : undefined;
  const url = useThumb(
    props.slide,
    { isSong: props.isSong, bg, media: props.media, look: props.look, width: props.width >= 260 ? 480 : 320 },
    visible,
  );
  const isTransparent = !bg && props.isSong;
  const cls = `thumb${props.marks.live ? ' live' : ''}${props.marks.armed && !props.marks.live ? ' armed' : ''}${props.hidden ? ' hidden-slide' : ''}${isTransparent ? ' is-transparent' : ''}`;
  const band = props.sectionBand;
  return (
    <div
      ref={ref}
      className={cls}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
      title={props.label}
    >
      <div className="img-canvas">
        {url || (!props.slide && bg && visible) ? (
          <div className="img" style={{ backgroundImage: `url(${url ?? fileUrl(bg!)})` }} />
        ) : (
          <div className="fallback-text">
            {props.slide ? firstText(props.slide) || props.label : props.label}
          </div>
        )}
        {props.marks.autoAdvance && (
          <div className="thumb-loop-progress" data-loop-progress aria-hidden="true">
            <div
              key={props.marks.autoAdvance.key}
              className="thumb-loop-progress-fill"
              style={{
                animationDuration: `${props.marks.autoAdvance.durationMs}ms`,
                animationDelay: `-${props.marks.autoAdvance.elapsedMs}ms`,
              }}
            />
          </div>
        )}
      </div>
      {props.marks.dots && props.marks.dots.length > 0 && (
        <span className="dots">
          {props.marks.dots.map((d) => (
            <span key={d.id} className={`dot sm ${d.dot}`} title={`${d.name}: ${d.dot}`} />
          ))}
        </span>
      )}
      {props.marks.waiting && <span className="wait" title="Waiting for outputs to arm" />}
      {band ? (
        <div
          className="cap-band"
          style={{ background: band.tone.bg, color: band.tone.fg }}
          onContextMenu={band.onContextMenu}
        >
          {band.isFirst ? (
            band.onJump ? (
              <button
                type="button"
                className="sec-jump-btn ellipsis grow"
                onClick={(e) => {
                  e.stopPropagation();
                  band.onJump?.();
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  band.onDoubleJump?.();
                }}
                title={`Jump to ${band.label}`}
              >
                <span className="sec-badge">{band.short || band.label}</span>
                {props.number !== undefined && <span className="num">{props.number}</span>}
                <span className="ellipsis" style={{ fontWeight: 500, opacity: 0.94 }}>
                  {props.label}
                </span>
              </button>
            ) : (
              <span className="row ellipsis grow" style={{ gap: 5, alignItems: 'center' }}>
                <span className="sec-badge">{band.short || band.label}</span>
                {props.number !== undefined && <span className="num">{props.number}</span>}
                <span className="ellipsis" style={{ fontWeight: 500, opacity: 0.94 }}>
                  {props.label}
                </span>
              </span>
            )
          ) : (
            <span className="row ellipsis grow" style={{ gap: 5, alignItems: 'center' }}>
              {props.number !== undefined && <span className="num">{props.number}</span>}
              <span className="ellipsis" style={{ opacity: 0.9, fontWeight: 500 }}>
                {props.label}
              </span>
            </span>
          )}
          {midiBadge && (
            <span
              className="tag"
              title={midiBadge.title}
              style={{
                fontSize: 11,
                padding: '0 5px',
                lineHeight: '15px',
                background: 'rgba(0,0,0,0.35)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                maxWidth: 96,
              }}
            >
              {midiBadge.color && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: midiBadge.color,
                    flexShrink: 0,
                  }}
                />
              )}
              <span className="ellipsis">{midiBadge.label}</span>
            </span>
          )}
          {props.footer}
        </div>
      ) : (
        <div className="cap">
          {props.number !== undefined && <span className="num">{props.number}</span>}
          <span className="ellipsis grow">{props.label}</span>
          {midiBadge && (
            <span
              className="tag"
              title={midiBadge.title}
              style={{
                fontSize: 9,
                padding: '1px 4px',
                lineHeight: '12px',
                background: 'var(--panel-alt)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                maxWidth: 96,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {midiBadge.color && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: midiBadge.color,
                    flexShrink: 0,
                  }}
                />
              )}
              <span className="ellipsis">{midiBadge.label}</span>
            </span>
          )}
          {props.footer}
        </div>
      )}
    </div>
  );
});

export type { Cue, OutputHealthEntry };

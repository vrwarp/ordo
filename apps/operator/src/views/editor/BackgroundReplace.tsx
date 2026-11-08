import { fileUrl } from '@ordo/client';
import type { Media, Presentation, Slide } from '@ordo/domain';
import { useId, useState } from 'react';
import { stillHash } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import { toast } from '../../state/toasts.ts';
import { removeSlideBackground, replaceBackgroundWith, replaceDeckBackground } from './actions.ts';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import {
  type BackgroundScope,
  deckBackground,
  type SlideBackground,
  slideBackground,
  slidesUsingBackground,
} from './ops/slides.ts';

/*
 * 'Replace background' (design/27 §11 item 7; M4 item E): the Slide panel's background with its scope,
 * this slide or every slide using the same picture, and the Presentation panel's 'Replace on all slides'.
 * Both go through `replaceBackground` (one undo step): `role: 'bg'` pictures are re-cropped, never
 * distorted; a video becomes a motion background.
 */

/** Where the picture comes from, as the panel says it. */
export function backgroundSource(from: SlideBackground['from'] | undefined): string {
  if (from === 'object') return 'From PowerPoint';
  if (from === 'slide') return 'This slide only';
  if (from === 'presentation') return "The presentation's default";
  return 'No background picture';
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A background's picture, its name and the small preview the pickers show. */
function Preview({ name, thumb }: { name: string; thumb?: string }) {
  return (
    <div
      aria-hidden
      title={name}
      style={{
        width: 96,
        height: 54,
        flex: 'none',
        borderRadius: 4,
        border: '1px solid var(--line)',
        background: thumb ? `#000 center/cover url(${thumb})` : '#000',
      }}
    />
  );
}

export type BackgroundReplaceViewProps = {
  /** The background's media name ('None' without one, 'Missing media' when it is gone). */
  name: string;
  thumb?: string;
  from?: SlideBackground['from'];
  scope: BackgroundScope;
  /** Slides that show the same background (`slidesUsingBackground`), this one included. */
  count: number;
  /** Whether the slide has a background of its own to remove; `hasDefault`: the presentation has one. */
  ownBackground: boolean;
  hasDefault: boolean;
  readOnly: boolean;
  onScope: (s: BackgroundScope) => void;
  onReplace: () => void;
  onRemove: () => void;
};

/**
 * The Slide panel's background, props only: the picture the slide shows and where it comes from,
 * 'Replace…', the scope as a radio group ('This slide', 'All N slides using it'), and 'None' (or 'Use the
 * default') for a background of the slide's own.
 */
export function BackgroundReplaceView(props: BackgroundReplaceViewProps) {
  const id = useId();
  const none = !props.from;
  return (
    <div className="col" style={{ gap: 6 }} role="group" aria-labelledby={`${id}-head`} data-slide-background>
      <span id={`${id}-head`} className="small" style={{ color: 'var(--fg2)' }}>
        Background
      </span>
      <div className="row">
        <Preview name={props.name} thumb={props.thumb} />
        <span className="grow col" style={{ gap: 2, minWidth: 0 }}>
          <span className="ellipsis small">{props.name}</span>
          <span className="muted small">{backgroundSource(props.from)}</span>
        </span>
        <button type="button" className="small" disabled={props.readOnly} onClick={props.onReplace}>
          Replace…
        </button>
        {props.ownBackground && (
          <button type="button" className="small" disabled={props.readOnly} onClick={props.onRemove}>
            {props.hasDefault ? 'Use the default' : 'None'}
          </button>
        )}
      </div>
      <fieldset
        className="col"
        style={{ gap: 4, border: 0, margin: 0, padding: 0 }}
        disabled={props.readOnly}
      >
        <legend className="small" style={{ padding: 0, marginBottom: 2, color: 'var(--fg2)' }}>
          Replace on
        </legend>
        <label className="check">
          <input
            type="radio"
            name={`${id}-scope`}
            value="slide"
            checked={props.scope === 'slide'}
            onChange={() => props.onScope('slide')}
          />
          This slide
        </label>
        <label className="check">
          <input
            type="radio"
            name={`${id}-scope`}
            value="all"
            checked={props.scope === 'all'}
            onChange={() => props.onScope('all')}
          />
          {none
            ? `All ${plural(props.count, 'slide')} without a background picture`
            : `All ${plural(props.count, 'slide')} using it`}
        </label>
      </fieldset>
    </div>
  );
}

/** The library's media item `id`, its name and its preview. */
function useMediaInfo(id: string | undefined): { name: string; thumb?: string; media?: Media } {
  const media = useLibrary((s) => s.data.media);
  if (!id) return { name: 'None' };
  const m = media.find((x) => x.id === id);
  const h = stillHash(m);
  return { name: m?.name ?? 'Missing media', thumb: h ? fileUrl(h) : undefined, media: m };
}

/** The Slide panel's background section, bound to the editor (`BackgroundReplaceView`). */
export function SlideBackgroundSection({
  slide,
  p,
  readOnly,
}: {
  slide: Slide;
  p: Presentation;
  readOnly: boolean;
}) {
  const [scope, setScope] = useState<BackgroundScope>('slide');
  const [picking, setPicking] = useState(false);
  const cur = slideBackground(p, slide);
  const info = useMediaInfo(cur?.mediaId);
  const count = slidesUsingBackground(p, cur?.mediaId).length;
  return (
    <>
      <BackgroundReplaceView
        name={info.name}
        thumb={info.thumb}
        from={cur?.from}
        scope={scope}
        count={count}
        ownBackground={!!slide.backgroundMediaId}
        hasDefault={!!p.backgroundMediaId}
        readOnly={readOnly}
        onScope={setScope}
        onReplace={() => setPicking(true)}
        onRemove={() => !readOnly && removeSlideBackground(slide.id)}
      />
      {picking && (
        <MediaPickerDialog
          title={
            scope === 'all' ? `Replace the background on ${plural(count, 'slide')}` : 'Choose a background'
          }
          kinds={['image', 'video']}
          backgroundsFirst
          needsSize
          onClose={() => setPicking(false)}
          onPick={(m) => {
            setPicking(false);
            if (readOnly) return;
            replaceBackgroundWith(slide.id, m, scope);
            if (scope === 'all' && count > 1)
              toast(`Background replaced on ${plural(count, 'slide')}.`, 'ok');
          }}
        />
      )}
    </>
  );
}

export type ReplaceOnAllSlidesViewProps = {
  /** The deck's background (`deckBackground`): its name, or undefined with none. */
  name?: string;
  count: number;
  readOnly: boolean;
  onReplace: () => void;
};

/** The Presentation panel's 'Replace on all slides…', props only, with what it will replace. */
export function ReplaceOnAllSlidesView(props: ReplaceOnAllSlidesViewProps) {
  return (
    <div className="row" data-replace-all-backgrounds>
      <span className="grow muted small">
        {props.name
          ? `${props.name} is the background of ${plural(props.count, 'slide')}.`
          : `${plural(props.count, 'slide')} without a background picture.`}
      </span>
      <button
        type="button"
        className="small"
        disabled={props.readOnly || !props.count}
        onClick={props.onReplace}
      >
        Replace on all slides…
      </button>
    </div>
  );
}

/**
 * 'Replace on all slides…' bound to the editor: the deck's background (its default, else the picture most
 * slides show) replaced on every slide using it, with a picture of any aspect (`replaceBackgroundOf`).
 */
export function ReplaceOnAllSlides({ p, readOnly }: { p: Presentation; readOnly: boolean }) {
  const [picking, setPicking] = useState(false);
  const old = deckBackground(p);
  const info = useMediaInfo(old);
  const count = slidesUsingBackground(p, old).length;
  return (
    <>
      <ReplaceOnAllSlidesView
        name={old ? info.name : undefined}
        count={count}
        readOnly={readOnly}
        onReplace={() => setPicking(true)}
      />
      {picking && (
        <MediaPickerDialog
          title={`Replace the background on ${plural(count, 'slide')}`}
          kinds={['image', 'video']}
          backgroundsFirst
          needsSize
          onClose={() => setPicking(false)}
          onPick={(m) => {
            setPicking(false);
            if (readOnly) return;
            replaceDeckBackground(old, m);
            toast(`Background replaced on ${plural(count, 'slide')}.`, 'ok');
          }}
        />
      )}
    </>
  );
}

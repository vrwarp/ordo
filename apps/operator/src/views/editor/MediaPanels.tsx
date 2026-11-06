import {
  type ImageObject,
  type Media,
  type MediaOnEnd,
  playingObject,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import { useId, useState } from 'react';
import { Check, NumberField, Select } from '../../components/fields.tsx';
import { clipNotice } from '../../lib/slideMedia.ts';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import { change } from './editorStore.ts';
import {
  makePlaying,
  type PlayPatch,
  patchSlideSound,
  playInPlace,
  posterOnly,
  removeSlideSound,
  replaceVideo,
  type SoundPatch,
  setPlay,
  setSlideSound,
} from './mediaOps.ts';
import { updateObject, updateSlide } from './ops.ts';

type Start = 'auto' | 'click';
const START: { value: Start; label: string }[] = [
  { value: 'auto', label: 'Automatically' },
  { value: 'click', label: 'On click (F8)' },
];

/**
 * The volume field's range: the playlist item's gain field goes up to +20 dB too (the engine caps a source at
 * +24 dB with loudness normalisation); −100 dB is the schema's floor, PowerPoint's silent volume.
 */
const GAIN_MIN = -100;
const GAIN_MAX = 20;

/**
 * The video options of an ImageObject that plays a clip in its box (design/27 §11 item 14): start, loop,
 * what happens at the end, volume, mute, hide while not playing, replace, 'Use poster only'. A picture whose
 * media is a video (its poster) offers to play it. Renders nothing for other pictures.
 */
export function VideoPanel(props: {
  o: ImageObject;
  slide: Slide;
  media: (id: string) => Media | undefined;
  readOnly: boolean;
}) {
  const { o, slide, media, readOnly } = props;
  const [picking, setPicking] = useState(false);
  const head = useId();
  const edit = (fn: (x: SlideObject) => SlideObject, key?: string) => {
    if (!readOnly) change((p) => updateObject(p, slide.id, o.id, fn), key);
  };
  if (!o.play) {
    const poster = media(o.mediaId);
    if (poster?.kind !== 'video') return null;
    return (
      <section className="col" aria-labelledby={head}>
        <h4 id={head}>Video</h4>
        <span className="muted small">This picture shows the poster of the video “{poster.name}”.</span>
        <button type="button" className="small" disabled={readOnly} onClick={() => edit(playInPlace)}>
          Play the video in the slide
        </button>
      </section>
    );
  }
  const play = o.play;
  const clip = media(play.mediaId);
  const notice = clipNotice('video', clip);
  const playing = playingObject(slide);
  const other = playing && playing.id !== o.id ? playing : undefined;
  const loop = play.loop ?? clip?.loop ?? false;
  const hidden = play.showWhenStopped === false;
  const set = (patch: PlayPatch, key?: string) => edit((x) => setPlay(x, patch), key);
  const onEnd: { value: MediaOnEnd; label: string }[] = [
    { value: 'hold', label: 'Hold the last frame' },
    { value: 'black', label: hidden ? 'Rewind and hide the video' : 'Rewind to the poster' },
    { value: 'advance', label: 'Go to the next slide' },
  ];
  return (
    <section className="col" aria-labelledby={head}>
      <h4 id={head}>Video</h4>
      <div className="row">
        <span className="grow ellipsis small">{clip?.name ?? 'Missing video'}</span>
        <button type="button" className="small" disabled={readOnly} onClick={() => setPicking(true)}>
          Replace video
        </button>
      </div>
      {other && (
        <div className="banner small col" role="status">
          <span>
            A slide plays one video: “{media(other.play.mediaId)?.name ?? 'another video'}” plays (it is lower
            on the slide), and this one shows its poster.
          </span>
          <button
            type="button"
            className="small"
            disabled={readOnly}
            onClick={() => !readOnly && change((p) => makePlaying(p, slide.id, o.id))}
          >
            Play this one instead
          </button>
        </div>
      )}
      {notice && (
        <div className="banner small" role="status">
          {notice}
        </div>
      )}
      <Select
        label="Start"
        value={play.start ?? 'auto'}
        options={START}
        disabled={readOnly}
        onChange={(start) => set({ start })}
      />
      {(play.start ?? 'auto') === 'click' && (
        <span className="muted small">
          The slide goes live with the video paused at its start; Play (F8) starts it.
        </span>
      )}
      <Check label="Loop" value={loop} disabled={readOnly} onChange={(v) => set({ loop: v })} />
      <Select
        label="At the end"
        value={play.onEnd ?? 'hold'}
        options={onEnd}
        disabled={readOnly || loop}
        onChange={(v) => set({ onEnd: v })}
      />
      <div className="row wrap">
        <NumberField
          label="Volume (dB)"
          value={play.gainDb ?? clip?.audio?.gainDb ?? 0}
          min={GAIN_MIN}
          max={GAIN_MAX}
          disabled={readOnly || !!play.muted}
          onChange={(gainDb) => set({ gainDb }, `play:${o.id}:gain`)}
        />
        <Check
          label="Mute"
          value={!!play.muted}
          disabled={readOnly}
          onChange={(v) => set({ muted: v || undefined })}
        />
      </div>
      <Check
        label="Hide while not playing"
        value={hidden}
        disabled={readOnly}
        onChange={(v) => set({ showWhenStopped: v ? false : undefined })}
      />
      <button type="button" className="small" disabled={readOnly} onClick={() => edit(posterOnly)}>
        Use poster only
      </button>
      {picking && (
        <MediaPickerDialog
          title="Choose a video"
          kinds={['video']}
          onClose={() => setPicking(false)}
          onPick={(m) => {
            edit((x) => replaceVideo(x, m));
            setPicking(false);
          }}
        />
      )}
    </section>
  );
}

/**
 * The slide's own sound (design/27 §11 item 14): choose or replace it, start, loop, volume, mute and how many
 * shown slides it plays across. It replaces playlist audio that is playing when the slide starts it.
 */
export function SlideSoundPanel(props: {
  slide: Slide;
  media: (id: string) => Media | undefined;
  readOnly: boolean;
}) {
  const { slide, media, readOnly } = props;
  const [picking, setPicking] = useState(false);
  const head = useId();
  const edit = (fn: (s: Slide) => Slide, key?: string) => {
    if (!readOnly) change((p) => updateSlide(p, slide.id, fn), key);
  };
  const sound = slide.audio;
  const m = sound ? media(sound.mediaId) : undefined;
  const notice = sound ? clipNotice('sound', m) : undefined;
  const set = (patch: SoundPatch, key?: string) => edit((s) => patchSlideSound(s, patch), key);
  return (
    <section className="col" aria-labelledby={head}>
      <h4 id={head}>Sound</h4>
      <div className="row">
        <span className="grow ellipsis small">{sound ? (m?.name ?? 'Missing sound') : 'None'}</span>
        <button type="button" className="small" disabled={readOnly} onClick={() => setPicking(true)}>
          {sound ? 'Replace' : 'Choose'}
        </button>
        {sound && (
          <button type="button" className="small" disabled={readOnly} onClick={() => edit(removeSlideSound)}>
            Remove
          </button>
        )}
      </div>
      {notice && (
        <div className="banner small" role="status">
          {notice}
        </div>
      )}
      {sound && (
        <>
          <Select
            label="Start"
            value={sound.start ?? 'auto'}
            options={START}
            disabled={readOnly}
            onChange={(start) => set({ start })}
          />
          <Check
            label="Loop"
            value={sound.loop ?? m?.loop ?? false}
            disabled={readOnly}
            onChange={(v) => set({ loop: v })}
          />
          <div className="row wrap">
            <NumberField
              label="Volume (dB)"
              value={sound.gainDb ?? m?.audio?.gainDb ?? 0}
              min={GAIN_MIN}
              max={GAIN_MAX}
              disabled={readOnly || !!sound.muted}
              onChange={(gainDb) => set({ gainDb }, `sound:${slide.id}:gain`)}
            />
            <Check
              label="Mute"
              value={!!sound.muted}
              disabled={readOnly}
              onChange={(v) => set({ muted: v || undefined })}
            />
          </div>
          <NumberField
            label="Plays across (slides)"
            value={sound.slides ?? 1}
            min={1}
            max={999}
            disabled={readOnly}
            onChange={(n) => set({ slides: Math.round(n) }, `sound:${slide.id}:slides`)}
          />
          <span className="muted small">
            Counts the shown slides of this presentation in the playlist, this one first. Going back to this
            slide while the sound plays does not restart it. When the slide starts its sound, playlist audio
            that is playing stops.
          </span>
        </>
      )}
      {picking && (
        <MediaPickerDialog
          title="Choose a sound"
          kinds={['audio']}
          onClose={() => setPicking(false)}
          onPick={(x) => {
            edit((s) => setSlideSound(s, x));
            setPicking(false);
          }}
        />
      )}
    </section>
  );
}

import {
  DEFAULT_LYRIC_STYLE,
  type LiveState,
  type Media,
  type MediaContent,
  type Presentation,
  type ResolvedPlaylist,
  type Slide,
  expandCues,
} from '@ordo/domain';
import { liveState, media, resolved } from './fixtures.test-util.ts';

/**
 * Test fixtures for clips playing inside their slides (design/27 §7.2): the fixture playlist plus a
 * 'clips' deck. c1 plays 'vid' in object v1, c2 plays 'vid2' in v2 (click start, hidden while not
 * playing), c3 has no clip, c4 plays 'vid' in v4. The media layer is filled by hand, as the reducer will.
 */

const title: Slide['objects'][number] = {
  id: 'title',
  type: 'text',
  box: { x: 100, y: 80, w: 1720, h: 200, rotation: 0 },
  text: 'Announcements',
  style: DEFAULT_LYRIC_STYLE,
  opacity: 1,
};

const clipSlide = (id: string, objectId: string, play: Record<string, unknown>): Slide => ({
  id,
  objects: [
    {
      id: objectId,
      type: 'image',
      box: { x: 480, y: 270, w: 960, h: 540, rotation: 0 },
      mediaId: 'hold',
      play: { mediaId: 'vid', ...play },
      fit: 'cover',
      opacity: 1,
      radius: 0,
    },
    title,
  ],
});

export const clips: Presentation = {
  id: 'clips',
  rev: 1,
  title: 'Clips',
  kind: 'slides',
  meta: { tags: [] },
  sections: [
    {
      id: 's',
      label: 'Main',
      short: 'M',
      slides: [
        clipSlide('c1', 'v1', {}),
        clipSlide('c2', 'v2', { mediaId: 'vid2', start: 'click', showWhenStopped: false }),
        { id: 'c3', objects: [title] },
        clipSlide('c4', 'v4', {}),
      ],
    },
  ],
  arrangements: [],
  archived: false,
};

const vid2: Media = {
  ...media.vid!,
  id: 'vid2',
  name: 'Trailer',
  delivery: { hash: 'd3', bytes: 10, mime: 'video/mp4', path: 'files/d3' },
};

export const withClips: ResolvedPlaylist = {
  ...resolved,
  playlist: {
    ...resolved.playlist,
    items: [...resolved.playlist.items, { id: 'i4', kind: 'presentation', presentationId: 'clips' }],
  },
  presentations: { ...resolved.presentations, clips },
  media: { ...media, vid2 },
};

export const clipCues = expandCues(withClips);
export const cueOf = (slideId: string): number => clipCues.findIndex((c) => c.slideId === slideId);

/** The object and clip slide `slideId` plays, if any. */
export function clipOf(slideId: string): { objectId: string; mediaId: string } | undefined {
  for (const s of clips.sections[0]!.slides)
    if (s.id === slideId)
      for (const o of s.objects)
        if (o.type === 'image' && o.play) return { objectId: o.id, mediaId: o.play.mediaId };
  return undefined;
}

/**
 * Slide `slideId` of the clips deck live at hub time `at`, its media layer as the reducer fills it
 * (`media` overrides; null leaves the layer empty), the slide layer showing `slideOnLayer`.
 */
export function clipLive(
  slideId: string,
  m: Partial<MediaContent> | null = {},
  opts: { slideOnLayer?: string; at?: number; seq?: number; armed?: number } = {},
): LiveState {
  const at = opts.at ?? 1000;
  const seq = opts.seq ?? 4;
  const i = cueOf(slideId);
  const s = liveState({ resolved: withClips, cues: clipCues, seq, live: i, armed: opts.armed });
  const shown = opts.slideOnLayer ?? slideId;
  const clip = clipOf(slideId);
  return {
    ...s,
    layers: {
      ...s.layers,
      slide: {
        content: { kind: 'slide', cueIndex: cueOf(shown), presentationId: 'clips', slideId: shown },
        at,
        seq,
      },
      media:
        m && clip
          ? {
              content: {
                kind: 'media',
                cueIndex: i,
                mediaId: clip.mediaId,
                mediaKind: 'video',
                objectId: clip.objectId,
                loop: false,
                onEnd: 'hold',
                state: 'playing',
                startedAt: at,
                positionMs: 0,
                ...m,
              },
              at,
              seq,
            }
          : { content: null, at, seq },
    },
  };
}

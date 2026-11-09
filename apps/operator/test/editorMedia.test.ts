import {
  type FileRef,
  type ImageObject,
  Media,
  playingObject,
  Presentation,
  type Slide,
  Slide as SlideSchema,
} from '@ordo/domain';
import { clampSlide } from '@ordo/renderer';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { fileKind, filesForKinds, kindsText, mediaAccept } from '../src/lib/mediaKinds.ts';
import { clipNotice, slideMediaTags } from '../src/lib/slideMedia.ts';
import { useLibrary } from '../src/state/library.ts';
import { change, openPresentation, undo, useEditor } from '../src/views/editor/editorStore.ts';
import { SlideSoundPanel, VideoPanel } from '../src/views/editor/MediaPanels.tsx';
import {
  addVideo,
  defaultPlay,
  makePlaying,
  newVideo,
  patchSlideSound,
  playInPlace,
  posterOnly,
  removeSlideSound,
  replaceVideo,
  setPlay,
  setSlideSound,
  videoBox,
} from '../src/views/editor/mediaOps.ts';
import { getSlide, newImage, updateObject, updateSlide } from '../src/views/editor/ops.ts';

// ---- fixtures ----

const file = (hash: string, mime: string): FileRef => ({ hash, bytes: 1, mime, path: `${hash}.bin` });
const media = (x: Partial<Media> & Pick<Media, 'id' | 'kind'>): Media =>
  Media.parse({
    name: x.id,
    original: file(`${x.id}-o`, 'application/octet-stream'),
    state: 'ready',
    ...x,
  });

const CLIP = media({
  id: 'clip',
  kind: 'video',
  name: 'Welcome clip',
  width: 1280,
  height: 720,
  poster: file('clip-poster', 'image/jpeg'),
  delivery: file('clip-mp4', 'video/mp4'),
  audio: { gainDb: -6 },
});
const CLIP2 = media({ id: 'clip2', kind: 'video', name: 'Second clip', poster: file('p2', 'image/jpeg') });
const BUSY = media({ id: 'busy', kind: 'video', name: 'Still transcoding', state: 'processing' });
const BAD = media({ id: 'bad', kind: 'video', name: 'Broken', state: 'failed' });
const PHOTO = media({ id: 'photo', kind: 'image', name: 'Photo', width: 4000, height: 3000 });
const SONG = media({ id: 'song', kind: 'audio', name: 'Walk-in music', loop: true });
const LIB = [CLIP, CLIP2, BUSY, BAD, PHOTO, SONG];
const lookup = (id: string) => LIB.find((m) => m.id === id);

function deck(...slides: Slide[]): Presentation {
  return Presentation.parse({
    id: 'deck',
    title: 'Announcements',
    kind: 'slides',
    sections: [{ id: 'sec', label: 'Main', short: 'M', slides }],
    arrangements: [{ id: 'arr', name: 'Default', sectionIds: ['sec'] }],
  });
}
const slide = (id: string, objects: Slide['objects'] = [], extra: Partial<Slide> = {}): Slide =>
  SlideSchema.parse({ id, objects, ...extra });
const image = (id: string, mediaId: string, extra: Partial<ImageObject> = {}): ImageObject => ({
  ...newImage(mediaId),
  id,
  ...extra,
});
const html = (el: ReactElement) => renderToStaticMarkup(el);

/**
 * Server rendering reads a zustand store's initial state (useSyncExternalStore's server snapshot), so the
 * component tests seed it there as well as in the live state.
 */
function seed<T extends object>(
  store: { getInitialState: () => T; setState: (p: Partial<T>) => void },
  p: Partial<T>,
) {
  Object.assign(store.getInitialState(), p);
  store.setState(p);
}

// ---- ops ----

describe("'Add video to slide' (design/27 §11 item 14)", () => {
  it('adds an ImageObject showing the poster that plays the clip, starting automatically, once, holding', () => {
    const o = newVideo(CLIP);
    expect(o.type).toBe('image');
    expect(o.mediaId).toBe('clip');
    expect(o.play).toEqual({ mediaId: 'clip', start: 'auto', loop: false, onEnd: 'hold' });
    expect(o.fit).toBe('contain');
    expect(o.box).toEqual({ x: 320, y: 180, w: 1280, h: 720, rotation: 0 });
    // A valid stored slide, and the drawers' clamp keeps the play options.
    const s = slide('s1', [o]);
    expect(SlideSchema.safeParse(s).success).toBe(true);
    expect((clampSlide(s).objects[0] as ImageObject).play).toEqual(o.play);
  });

  it('sizes the box to the video, scaled down to fit the slide and centred', () => {
    expect(videoBox({ width: 3840, height: 2160 })).toEqual({ x: 0, y: 0, w: 1920, h: 1080, rotation: 0 });
    expect(videoBox({ width: 1080, height: 1920 })).toEqual({ x: 656, y: 0, w: 608, h: 1080, rotation: 0 });
    expect(videoBox({ width: 640, height: 360 })).toEqual({ x: 640, y: 360, w: 640, h: 360, rotation: 0 });
    expect(videoBox({})).toEqual({ x: 0, y: 0, w: 1920, h: 1080, rotation: 0 });
  });

  it('adds on top and reports the video that already plays on the slide', () => {
    const p = deck(slide('s1', [image('t', 'photo')]));
    const first = addVideo(p, 's1', CLIP);
    expect(first.playing).toBeUndefined();
    const s1 = getSlide(first.p, 's1')!;
    expect(s1.objects.map((o) => o.id)).toEqual(['t', first.id]);
    expect(playingObject(s1)?.id).toBe(first.id);
    const second = addVideo(first.p, 's1', CLIP2);
    expect(second.playing?.id).toBe(first.id);
    // The runtime plays the first one in z order; the new one shows its poster.
    expect(playingObject(getSlide(second.p, 's1')!)?.id).toBe(first.id);
    expect(addVideo(p, 'nope', CLIP)).toEqual({ p, id: '' });
  });

  it('is one undo step through the editor store', () => {
    const p = deck(slide('s1'));
    openPresentation(p);
    change((q) => addVideo(q, 's1', CLIP).p);
    const ed = useEditor.getState();
    expect(ed.dirty).toBe(true);
    expect(ed.canUndo).toBe(true);
    expect(getSlide(ed.draft!, 's1')!.objects).toHaveLength(1);
    undo();
    expect(getSlide(useEditor.getState().draft!, 's1')!.objects).toHaveLength(0);
  });
});

describe('video options', () => {
  const o = newVideo(CLIP);

  it('patches play options; undefined restores the default', () => {
    const a = setPlay(o, { start: 'click', loop: true, gainDb: -12, muted: true, showWhenStopped: false });
    expect((a as ImageObject).play).toEqual({
      mediaId: 'clip',
      start: 'click',
      loop: true,
      onEnd: 'hold',
      gainDb: -12,
      muted: true,
      showWhenStopped: false,
    });
    const b = setPlay(a, { muted: undefined, showWhenStopped: undefined });
    expect((b as ImageObject).play).not.toHaveProperty('muted');
    expect((b as ImageObject).play).not.toHaveProperty('showWhenStopped');
    // Pictures that do not play are left alone.
    const still = image('i', 'photo');
    expect(setPlay(still, { loop: true })).toBe(still);
  });

  it('replace video swaps the clip and its poster and keeps the options', () => {
    const a = setPlay(o, { start: 'click', onEnd: 'advance' });
    const r = replaceVideo(a, CLIP2) as ImageObject;
    expect(r.mediaId).toBe('clip2');
    expect(r.play).toEqual({ mediaId: 'clip2', start: 'click', loop: false, onEnd: 'advance' });
    // A PowerPoint clip with its own poster picture: the new clip's poster replaces it.
    const imported = image('v', 'poster-img', { play: { mediaId: 'clip' } });
    expect((replaceVideo(imported, CLIP2) as ImageObject).mediaId).toBe('clip2');
  });

  it("'Use poster only' and playing a video poster in place", () => {
    const still = posterOnly(o) as ImageObject;
    expect(still).not.toHaveProperty('play');
    expect(still.mediaId).toBe('clip');
    expect((playInPlace(still) as ImageObject).play).toEqual(defaultPlay('clip'));
    expect(playInPlace(o)).toBe(o);
  });

  it("'Play this one instead' leaves one playing object on the slide", () => {
    const a = image('a', 'clip', { play: defaultPlay('clip') });
    const b = image('b', 'clip2', { play: { mediaId: 'clip2', loop: true } });
    const p = deck(slide('s1', [a, image('c', 'photo'), b]));
    expect(playingObject(getSlide(p, 's1')!)?.id).toBe('a');
    const q = makePlaying(p, 's1', 'b');
    const s = getSlide(q, 's1')!;
    expect(playingObject(s)?.id).toBe('b');
    expect(s.objects.filter((x) => x.type === 'image' && x.play).map((x) => x.id)).toEqual(['b']);
    expect((s.objects[2] as ImageObject).play).toEqual({ mediaId: 'clip2', loop: true });
    // Only a playing object can take over.
    expect(makePlaying(p, 's1', 'c')).toEqual(p);
  });
});

describe('slide sound', () => {
  const s = slide('s1');

  it('chooses, patches and removes the sound', () => {
    const a = setSlideSound(s, SONG);
    expect(a.audio).toEqual({ mediaId: 'song', start: 'auto', loop: false });
    const b = patchSlideSound(a, { start: 'click', loop: true, gainDb: -3, slides: 3 });
    expect(b.audio).toEqual({ mediaId: 'song', start: 'click', loop: true, gainDb: -3, slides: 3 });
    // Replacing keeps the options; one slide is the default.
    const c = patchSlideSound(setSlideSound(b, { id: 'other' }), { slides: 1, gainDb: undefined });
    expect(c.audio).toEqual({ mediaId: 'other', start: 'click', loop: true });
    expect(SlideSchema.safeParse(c).success).toBe(true);
    expect(clampSlide(c).audio).toEqual(c.audio);
    expect(removeSlideSound(c)).not.toHaveProperty('audio');
    expect(patchSlideSound(s, { loop: true })).toBe(s);
    expect(removeSlideSound(s)).toBe(s);
  });

  it('saves with the presentation', () => {
    const p = updateSlide(deck(s), 's1', (x) => patchSlideSound(setSlideSound(x, SONG), { slides: 4 }));
    expect(Presentation.parse(JSON.parse(JSON.stringify(p))).sections[0]!.slides[0]!.audio).toEqual({
      mediaId: 'song',
      start: 'auto',
      loop: false,
      slides: 4,
    });
  });
});

// ---- helpers ----

describe('clip readiness and slide tags', () => {
  it('says why a clip or sound will not play', () => {
    expect(clipNotice('video', CLIP)).toBeUndefined();
    expect(clipNotice('video', BUSY)).toMatch(/still processing: the slide shows its poster/);
    expect(clipNotice('video', BAD)).toMatch(/could not be processed/);
    expect(clipNotice('video', undefined)).toMatch(/missing/);
    expect(clipNotice('video', PHOTO)).toMatch(/not a video/);
    expect(clipNotice('sound', SONG)).toBeUndefined();
    expect(clipNotice('sound', CLIP)).toBeUndefined();
    expect(clipNotice('sound', PHOTO)).toMatch(/no sound/);
  });

  it('tags slides that play a video in place or their own sound', () => {
    expect(slideMediaTags(undefined, lookup)).toEqual([]);
    expect(slideMediaTags(slide('s', [image('i', 'photo')]), lookup)).toEqual([]);
    // A video poster that does not play is not tagged.
    expect(slideMediaTags(slide('s', [image('i', 'clip')]), lookup)).toEqual([]);
    const both = slide('s', [newVideo(CLIP)], { audio: { mediaId: 'song', slides: 3 } });
    expect(slideMediaTags(both, lookup)).toEqual([
      { kind: 'video', title: 'Plays Welcome clip in the slide' },
      { kind: 'audio', title: 'Plays Walk-in music across 3 slides' },
    ]);
    const busy = slideMediaTags(slide('s', [newVideo(BUSY)]), lookup);
    expect(busy).toHaveLength(1);
    expect(busy[0]!.notice).toMatch(/still processing/);
    expect(busy[0]!.title).toBe(busy[0]!.notice);
  });
});

describe('media pickers take their kinds only (design/27 §11 item 6)', () => {
  it('limits the file chooser', () => {
    expect(mediaAccept(['image'])).toBe('image/*,.gif,.jpg,.jpeg,.png,.webp,.svg');
    expect(mediaAccept(['image'])).not.toMatch(/video|mp4|mov/);
    expect(mediaAccept(['video'])).toBe('video/*,.mov,.mp4,.m4v,.webm');
    expect(mediaAccept(['audio'])).toMatch(/^audio\/\*,/);
    expect(mediaAccept(['video', 'image'])).toBe(
      'video/*,image/*,.mov,.mp4,.m4v,.webm,.gif,.jpg,.jpeg,.png,.webp,.svg',
    );
  });

  it('classes files as the hub does and keeps only the picker kinds', () => {
    expect(fileKind({ name: 'IMG_0001.JPG', type: 'image/jpeg' })).toBe('image');
    expect(fileKind({ name: 'clip.mov', type: 'video/quicktime' })).toBe('video');
    expect(fileKind({ name: 'song.m4a', type: 'audio/mp4' })).toBe('audio');
    expect(fileKind({ name: 'song.ogg', type: 'video/ogg' })).toBe('audio');
    expect(fileKind({ name: 'no-extension', type: 'video/mp4' })).toBe('video');
    expect(fileKind({ name: 'deck.pptx', type: '' })).toBeUndefined();
    const files = [{ name: 'a.png' }, { name: 'b.mp4' }, { name: 'c.mp3' }];
    expect(filesForKinds(files, ['image'])).toEqual({ ok: [files[0]], rejected: [files[1], files[2]] });
    expect(kindsText(['image'])).toBe('images');
    expect(kindsText(['video', 'image'])).toBe('videos or images');
    expect(kindsText(['audio'])).toBe('sounds');
  });
});

// ---- components (server-rendered markup) ----

describe('VideoPanel', () => {
  const o = newVideo(CLIP);
  const s = slide('s1', [o]);

  it('shows the options of a playing object', () => {
    const out = html(createElement(VideoPanel, { o, slide: s, media: lookup, readOnly: false }));
    expect(out).toContain('<h4');
    expect(out).toContain('Welcome clip');
    for (const text of [
      'Replace video',
      'Start',
      'Automatically',
      'On click (F8)',
      'Loop',
      'At the end',
      'Hold the last frame',
      'Rewind to the poster',
      'Go to the next slide',
      'Volume (dB)',
      'Mute',
      'Hide while not playing',
      'Use poster only',
    ])
      expect(out).toContain(text);
    // Volume falls back to the clip's own gain; nothing is disabled; no notice.
    expect(out).toMatch(/type="number"[^>]*value="-6"/);
    expect(out).not.toContain('disabled');
    expect(out).not.toContain('role="status"');
    expect(out).not.toContain('paused at its start');
  });

  it('reflects stored options', () => {
    const x = setPlay(o, {
      start: 'click',
      loop: true,
      muted: true,
      showWhenStopped: false,
      gainDb: -20,
    }) as ImageObject;
    const out = html(
      createElement(VideoPanel, { o: x, slide: slide('s1', [x]), media: lookup, readOnly: false }),
    );
    expect(out).toContain('paused at its start; Play (F8) starts it');
    expect(out).toMatch(/<option value="click" selected="">/);
    expect(out).toContain('Rewind and hide the video');
    // Looping never ends, and a muted clip has no volume to set.
    expect(out).toMatch(/<select disabled="">/);
    expect(out).toMatch(/type="number"[^>]*disabled=""[^>]*value="-20"|value="-20"[^>]*disabled=""/);
    expect((out.match(/type="checkbox" checked=""/g) ?? []).length).toBe(3);
  });

  it('says which object plays and offers to switch', () => {
    const first = image('first', 'clip2', { play: defaultPlay('clip2') });
    const out = html(
      createElement(VideoPanel, { o, slide: slide('s1', [first, o]), media: lookup, readOnly: false }),
    );
    expect(out).toContain('A slide plays one video: “Second clip” plays');
    expect(out).toContain('Play this one instead');
    const own = html(
      createElement(VideoPanel, { o: first, slide: slide('s1', [first, o]), media: lookup, readOnly: false }),
    );
    expect(own).not.toContain('Play this one instead');
  });

  it('warns when the clip is not ready', () => {
    const x = newVideo(BUSY);
    const out = html(
      createElement(VideoPanel, { o: x, slide: slide('s1', [x]), media: lookup, readOnly: false }),
    );
    expect(out).toContain('role="status"');
    expect(out).toContain('still processing: the slide shows its poster');
  });

  it('offers to play a video poster, and nothing for a picture', () => {
    const poster = image('p', 'clip');
    const out = html(createElement(VideoPanel, { o: poster, slide: s, media: lookup, readOnly: false }));
    expect(out).toContain('Play the video in the slide');
    expect(out).toContain('Welcome clip');
    expect(
      html(createElement(VideoPanel, { o: image('i', 'photo'), slide: s, media: lookup, readOnly: false })),
    ).toBe('');
  });

  it('is read-only while the presentation is live', () => {
    const out = html(createElement(VideoPanel, { o, slide: s, media: lookup, readOnly: true }));
    const buttons = out.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b).toContain('disabled');
    for (const c of out.match(/<(input|select)[^>]*>/g) ?? []) expect(c).toContain('disabled');
  });
});

describe('SlideSoundPanel', () => {
  it('offers a sound for a slide without one', () => {
    const out = html(createElement(SlideSoundPanel, { slide: slide('s1'), media: lookup, readOnly: false }));
    expect(out).toContain('Sound');
    expect(out).toContain('None');
    expect(out).toContain('>Choose</button>');
    expect(out).not.toContain('Plays across');
  });

  it('shows the options of a slide sound', () => {
    const s = slide('s1', [], { audio: { mediaId: 'song', start: 'click', slides: 3 } });
    const out = html(createElement(SlideSoundPanel, { slide: s, media: lookup, readOnly: false }));
    for (const text of [
      'Walk-in music',
      '>Replace</button>',
      '>Remove</button>',
      'Start',
      'Loop',
      'Volume (dB)',
      'Mute',
      'Plays across (slides)',
      'playlist audio that is playing stops',
    ])
      expect(out).toContain(text);
    expect(out).toMatch(/<option value="click" selected="">/);
    // Loop follows the media's own setting until it is set here.
    expect(out).toMatch(/type="checkbox" checked=""/);
    expect(out).toMatch(/value="3"/);
  });

  it('warns about a missing sound', () => {
    const s = slide('s1', [], { audio: { mediaId: 'gone' } });
    const out = html(createElement(SlideSoundPanel, { slide: s, media: lookup, readOnly: false }));
    expect(out).toContain('Missing sound');
    expect(out).toContain('The sound is missing from the library: the slide plays no sound.');
  });
});

describe('the editor panels with the stores', () => {
  const p = deck(
    slide('s1', [newVideo(CLIP), image('pic', 'photo')], { audio: { mediaId: 'song' } }),
    slide('s2', [image('plain', 'photo')]),
  );
  const video = getSlide(p, 's1')!.objects[0]!;
  beforeEach(() => {
    seed(useLibrary, { data: { ...useLibrary.getState().data, media: LIB } });
  });

  it('ObjectPanel: a video object has its poster and video sections', async () => {
    seed(useEditor, { id: p.id, draft: p, base: p, slideId: 's1', objectId: video.id });
    const { ObjectPanel } = await import('../src/views/editor/ObjectPanel.tsx');
    const out = html(createElement(ObjectPanel, { o: video, readOnly: false }));
    expect(out).toContain('<b class="grow">Video</b>');
    expect(out).toContain('Poster');
    expect(out).toContain('Replace video');
    const pic = getSlide(p, 's1')!.objects[1]!;
    const still = html(createElement(ObjectPanel, { o: pic, readOnly: false }));
    expect(still).toContain('<b class="grow">Image</b>');
    expect(still).not.toContain('Replace video');
    // A locked picture (a SmartArt picture, the art): move, resize, delete and z-order only.
    const replace = (markup: string) => /<button[^>]*>Replace<\/button>/.exec(markup)?.[0] ?? '';
    expect(replace(still)).not.toContain('disabled');
    const locked = html(createElement(ObjectPanel, { o: { ...pic, locked: true }, readOnly: false }));
    expect(replace(locked)).toContain('disabled');
    expect((locked.match(/disabled=""/g) ?? []).length).toBeGreaterThan(
      (still.match(/disabled=""/g) ?? []).length + 1,
    );
  });

  it('SlidePanel: the slide sound section', async () => {
    seed(useEditor, { id: p.id, draft: p, base: p, slideId: 's1', objectId: undefined });
    const { SlidePanel } = await import('../src/views/editor/SlidePanel.tsx');
    const out = html(createElement(SlidePanel, { slide: getSlide(p, 's1')!, p, readOnly: false }));
    expect(out).toContain('Walk-in music');
    expect(out).toContain('Plays across (slides)');
  });

  it("EditorView: '+ Video' next to '+ Image'", async () => {
    seed(useEditor, { id: p.id, draft: p, base: p, slideId: 's1', objectId: undefined });
    const { EditorView } = await import('../src/views/editor/EditorView.tsx');
    const out = html(createElement(EditorView, { id: p.id }));
    expect(out).toMatch(
      /\+ Image<\/button><button type="button" title="Add a video that plays in the slide">\+ Video<\/button>/,
    );
  });

  it('SlideGrid: video and audio tags on slide thumbnails', async () => {
    const { expandCues } = await import('@ordo/domain');
    const { SlideGrid } = await import('../src/views/live/SlideGrid.tsx');
    const busy = updateObject(p, 's2', 'plain', (o) => ({
      ...o,
      mediaId: 'busy',
      play: defaultPlay('busy'),
    }));
    const playlist = {
      id: 'pl',
      name: 'Sunday',
      items: [{ id: 'it', kind: 'presentation' as const, presentationId: p.id }],
    };
    const media = Object.fromEntries(LIB.map((m) => [m.id, m]));
    const cues = expandCues({ playlist: playlist as never, presentations: { [p.id]: busy }, media });
    const op = {
      playlist: playlist as never,
      live: false,
      cues,
      presentation: () => busy,
      media: lookup,
    };
    const out = html(createElement(SlideGrid, { op, viewItem: 0 }));
    const tags = out.match(/<span class="tag[^"]*"[^>]*>[a-z]+<\/span>/g) ?? [];
    expect(tags).toEqual([
      '<span class="tag" title="Plays Welcome clip in the slide">video</span>',
      '<span class="tag" title="Plays Walk-in music">audio</span>',
      expect.stringMatching(
        /^<span class="tag amber" title="The video is still processing[^"]*">video<\/span>$/,
      ),
    ]);
  });
});

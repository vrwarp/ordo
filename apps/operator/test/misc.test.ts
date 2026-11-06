import { describe, expect, it } from 'vitest';
import { initialState, reduce, reduceAll } from '@ordo/live-state';
import type { OutputHealthEntry } from '@ordo/protocol';
import { keyFace } from '@ordo/surfaces';
import { type Media, type Presentation, type SlideObject, parseLyrics, songFromParsed } from '@ordo/domain';
import { DoublePressGuard } from '../src/lib/confirm.ts';
import { allowedForRole, parseRoute, routeHash } from '../src/lib/route.ts';
import { armDot, cacheSummary, outputDot } from '../src/lib/health.ts';
import { deckView } from '../src/lib/deckView.ts';
import { applyLibraryDelta, type LibraryData } from '../src/lib/libraryData.ts';
import { swSource } from '../src/sw/template.ts';

function entry(p: Partial<OutputHealthEntry> = {}): OutputHealthEntry {
  return {
    outputId: 'o',
    connected: true,
    lastSeen: Date.now(),
    presented: 1,
    missed: 0,
    longTasks: 0,
    lateFlips: 0,
    cache: { ready: 1, total: 1 },
    gpuLost: 0,
    videoDropped: 0,
    ...p,
  };
}

describe('clear-all double press', () => {
  it('fires on the second press within 2 s only', () => {
    const g = new DoublePressGuard();
    expect(g.press(0)).toBe(false);
    expect(g.pendingUntil(500)).toBe(2000);
    expect(g.press(1500)).toBe(true);
    expect(g.pendingUntil(1600)).toBeUndefined();
    expect(g.press(5000)).toBe(false);
    expect(g.press(7500)).toBe(false);
    expect(g.press(8000)).toBe(true);
  });
});

describe('routes', () => {
  it('parses and formats hash routes', () => {
    expect(parseRoute('')).toEqual({ name: 'live' });
    expect(parseRoute('#/edit/abc')).toEqual({ name: 'edit', id: 'abc' });
    expect(parseRoute('#/settings/midi')).toEqual({ name: 'settings', page: 'midi' });
    expect(parseRoute('#/settings/bogus')).toEqual({ name: 'settings', page: 'outputs' });
    expect(parseRoute('#/library/media')).toEqual({ name: 'library', tab: 'media' });
    expect(parseRoute('#/nope')).toBeNull();
    expect(routeHash({ name: 'playlists', id: 'x y' })).toBe('#/playlists/x%20y');
    expect(allowedForRole({ name: 'live' }, 'edit')).toBe(false);
    expect(allowedForRole({ name: 'edit', id: 'a' }, 'edit')).toBe(true);
  });
});

describe('health dots', () => {
  it('derives output and arm colours', () => {
    expect(outputDot(undefined)).toBe('red');
    expect(outputDot(entry())).toBe('green');
    expect(outputDot(entry({ cache: { ready: 1, total: 3 } }))).toBe('amber');
    const s = { ...initialState(), armed: 2 };
    expect(armDot(entry({ armed: 2, armedOk: true }), 2, s)).toBe('green');
    expect(armDot(entry({ armed: 2, armedOk: false }), 2, s)).toBe('red');
    expect(armDot(entry({ armed: 1 }), 2, s)).toBe('amber');
    expect(armDot(entry({ connected: false }), 2, s)).toBe('grey');
    expect(cacheSummary([entry({ cache: { ready: 2, total: 4 } })], { ready: 3, total: 4 }).frac).toBe(0.5);
  });
});

describe('deck view', () => {
  it('lists sections and highlights the live one', () => {
    const p = songFromParsed(parseLyrics('Verse 1\na\n\nChorus\nb'));
    let s = reduce(initialState(), {
      k: 'goLive',
      resolved: {
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'x',
          items: [{ id: 'i', kind: 'presentation', presentationId: p.id }],
        },
        presentations: { [p.id]: p },
        media: {},
        fonts: [],
        looks: [],
        files: [],
        manifestId: 'm',
      },
    });
    s = reduce(s, { k: 'go', cueIndex: 1, at: 1 });
    const v = deckView(s, true);
    expect(v.sections.map((x) => x.short)).toEqual(['V1', 'C']);
    expect(v.liveSectionPos).toBe(1);
  });

  it("lights the play key for F8's target: a waiting click sound, then the slide video, then the audio", () => {
    const file = { hash: 'h', bytes: 1, mime: 'x', path: 'p' };
    const media = (id: string, kind: Media['kind']): Media => ({
      id,
      rev: 1,
      name: id,
      tags: [],
      kind,
      original: file,
      delivery: file,
      state: 'ready',
      loop: false,
      isBackground: false,
    });
    const clip = {
      id: 'v',
      type: 'image',
      box: { x: 100, y: 100, w: 800, h: 450, rotation: 0 },
      mediaId: 'clip',
      fit: 'contain',
      opacity: 1,
      radius: 0,
      play: { mediaId: 'clip' },
    } as SlideObject;
    const mix: Presentation = {
      id: 'mix',
      rev: 1,
      title: 'Mix',
      kind: 'slides',
      meta: { tags: [] },
      sections: [
        {
          id: 's',
          label: 'S',
          short: 'S',
          // b: an autoplay video and a sound that starts on click.
          slides: [
            { id: 'a', objects: [] },
            { id: 'b', objects: [clip], audio: { mediaId: 'sfx', start: 'click' } },
          ],
        },
      ],
      arrangements: [],
      archived: false,
    };
    const resolved = {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'x',
        items: [
          { id: 'i0', kind: 'media' as const, mediaId: 'bed', loop: true },
          { id: 'i1', kind: 'presentation' as const, presentationId: 'mix' },
        ],
      },
      presentations: { mix },
      media: { bed: media('bed', 'audio'), clip: media('clip', 'video'), sfx: media('sfx', 'audio') },
      fonts: [],
      looks: [],
      files: [],
      manifestId: 'm',
    };
    const play = { action: { id: 'mediaPlayPause' as const }, label: 'Play' };
    // Cue 0: the playlist audio plays; F8 pauses it.
    let s = reduceAll(initialState(), [
      { k: 'goLive', resolved },
      { k: 'go', cueIndex: 0, at: 100 },
    ]);
    let v = deckView(s, true);
    expect(v.mediaPlaying).toBe(true);
    expect(v.slideSoundWaiting).toBeUndefined();
    // Cue 2: the video plays and the click sound waits; F8 starts the sound, so the key offers Play.
    s = reduce(s, { k: 'go', cueIndex: 2, at: 200 });
    expect(s.layers.media.content?.state).toBe('playing');
    v = deckView(s, true);
    expect(v.mediaPlaying).toBe(false);
    expect(v.slideSoundWaiting).toBe(true);
    expect(keyFace(play, v)).toMatchObject({ label: 'Play', sub: 'sound' });
    // F8 started the sound: the next F8 pauses the video.
    s = reduce(s, { k: 'media.play', at: 500 });
    expect(s.audio.content).toMatchObject({ mediaId: 'sfx', state: 'playing' });
    v = deckView(s, true);
    expect(v.mediaPlaying).toBe(true);
    expect(v.slideSoundWaiting).toBeUndefined();
    expect(keyFace(play, v)).toMatchObject({ label: 'Pause' });
    expect(keyFace(play, v).sub).toBeUndefined();
    // The video paused while the sound plays on: F8 resumes the video, so the key offers Play.
    s = reduce(s, { k: 'media.play', at: 900 });
    expect(s.layers.media.content?.state).toBe('paused');
    expect(s.audio.content?.state).toBe('playing');
    expect(deckView(s, true).mediaPlaying).toBe(false);
  });
});

describe('library deltas', () => {
  it('upserts, deletes and updates settings keys', () => {
    const d = {
      seq: 1,
      presentations: [],
      playlists: [{ id: 'a', rev: 1, name: 'A', items: [] }],
      media: [],
      fonts: [],
      themes: [],
      folders: [],
      settings: { general: { venueName: 'x' } } as unknown as LibraryData['settings'],
      jobs: {},
    } as LibraryData;
    const r = applyLibraryDelta(d, [
      { kind: 'playlist', id: 'a', deleted: true },
      { kind: 'playlist', id: 'b', entity: { id: 'b', rev: 1, name: 'B', items: [] } },
      { kind: 'settings', id: 'general', entity: { venueName: 'y' } },
      { kind: 'settings', id: 'weird' },
    ]);
    expect(r.data.playlists.map((p) => p.id)).toEqual(['b']);
    expect(r.data.settings.general.venueName).toBe('y');
    expect(r.refetchSettings).toBe(true);
    expect(d.playlists).toHaveLength(1);
  });
});

describe('service worker', () => {
  it('never caches /api or /ws', () => {
    const src = swSource(['index.html', 'assets/a.js'], 'v1');
    expect(src).toContain("url.pathname.includes('/api/')");
    expect(src).toContain('"assets/a.js"');
    expect(() => new Function(src)).not.toThrow();
  });
});

describe('RecoveringGate (review item 29)', () => {
  it('does not flash "Recovering" after a long main-thread task, but shows a real restart and a hung core', async () => {
    const { RecoveringGate } = await import('../src/lib/recovering.ts');
    const g = new RecoveringGate(500);
    let t = 0;
    expect(g.judge(t, false, 100)).toBe(false);
    t += 500;
    expect(g.judge(t, false, 200)).toBe(false);
    // A 2.5 s main-thread block: the first tick after it sees a 2.5 s old heartbeat (still queued).
    t += 2500;
    expect(g.judge(t, false, 2600)).toBe(false);
    t += 500;
    expect(g.judge(t, false, 100)).toBe(false);
    // A restart in progress always shows.
    t += 500;
    expect(g.judge(t, true, 100)).toBe(true);
    // A core that stops beating while this thread ticks on time shows after 750 ms.
    t += 500;
    expect(g.judge(t, false, 600)).toBe(false);
    t += 500;
    expect(g.judge(t, false, 1100)).toBe(true);
  });
});

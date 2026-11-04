import { DEFAULT_LOOKS, parseLyrics, songFromParsed } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import { describe, expect, it } from 'vitest';
import {
  type CapabilityEnv,
  detectCapabilities,
  forcedProfile,
  profileFor,
  requestPersistentStorage,
} from '../src/lib/capabilities.ts';
import { flatSlides, lookBackgroundId, previewLooks, slideAndNext } from '../src/lib/lookPreviews.ts';
import { allowedForRole, parseRoute, routeHash } from '../src/lib/route.ts';
import { fetchVenueLive, fromSummary, summarize } from '../src/lib/venueLive.ts';

const mq =
  (matches: Record<string, boolean>) =>
  (q: string): { matches: boolean } => ({ matches: !!matches[q] });

/** Chrome on the venue PC: WebHID, Web MIDI, Window Management, fullscreen, a mouse. */
const chromeDesktop: CapabilityEnv = {
  navigator: {
    hid: {},
    requestMIDIAccess: () => undefined,
    gpu: {},
    storage: { getDirectory: () => undefined },
  },
  window: { getScreenDetails: () => undefined },
  document: { fullscreenEnabled: true },
  matchMedia: mq({ '(pointer: fine)': true, '(hover: hover)': true }),
  mediaElementProto: { setSinkId: () => undefined },
  elementProto: { requestFullscreen: () => undefined },
};

/** iPadOS Safari: none of the venue APIs, a finger, element fullscreen reported on, installed. */
const ipadSafari: CapabilityEnv = {
  navigator: { storage: { getDirectory: () => undefined, persist: () => undefined }, standalone: true },
  window: {},
  document: { fullscreenEnabled: true },
  matchMedia: mq({ '(pointer: coarse)': true, '(hover: none)': true }),
  mediaElementProto: {},
  elementProto: { requestFullscreen: () => undefined },
};

describe('capability detection (design/15 iPad editing)', () => {
  it('Chrome desktop has everything a live service needs: full profile', () => {
    const c = detectCapabilities(chromeDesktop);
    expect(c).toEqual({
      hid: true,
      midi: true,
      windowManagement: true,
      fullscreenPopups: true,
      sinkId: true,
      opfs: true,
      webgpu: true,
      coarsePointer: false,
      standalone: false,
    });
    expect(profileFor(c, 'operate')).toBe('full');
  });

  it('iPad Safari gets the edit profile, also with the operate PIN', () => {
    const c = detectCapabilities(ipadSafari);
    expect(c).toMatchObject({
      hid: false,
      midi: false,
      windowManagement: false,
      fullscreenPopups: false,
      sinkId: false,
      webgpu: false,
      coarsePointer: true,
      standalone: true,
    });
    expect(profileFor(c, 'operate')).toBe('edit');
    expect(profileFor(c, 'edit')).toBe('edit');
  });

  it('the edit role is always the edit profile, even on the venue PC', () => {
    expect(profileFor(detectCapabilities(chromeDesktop), 'edit')).toBe('edit');
    expect(profileFor(detectCapabilities(chromeDesktop), 'edit', 'full')).toBe('edit');
  });

  it('a touchscreen PC with Chrome keeps the full profile (Window Management decides)', () => {
    const c = detectCapabilities({
      ...chromeDesktop,
      matchMedia: mq({ '(pointer: coarse)': true, '(hover: none)': true }),
    });
    expect(c.coarsePointer).toBe(true);
    expect(c.fullscreenPopups).toBe(false);
    expect(profileFor(c, 'operate')).toBe('full');
  });

  it('a desktop browser without WebHID or Window Management but with fullscreen windows stays full', () => {
    const c = detectCapabilities({
      ...ipadSafari,
      matchMedia: mq({ '(pointer: fine)': true }),
      navigator: {},
    });
    expect(c.fullscreenPopups).toBe(true);
    expect(profileFor(c, 'operate')).toBe('full');
  });

  it('standalone from display-mode, and empty or throwing environments detect nothing', () => {
    expect(detectCapabilities({ matchMedia: mq({ '(display-mode: standalone)': true }) }).standalone).toBe(
      true,
    );
    const none = detectCapabilities({});
    expect(Object.values(none).every((v) => v === false)).toBe(true);
    expect(profileFor(none, 'operate')).toBe('edit');
    const throwing = detectCapabilities({
      matchMedia: () => {
        throw new Error('no');
      },
    });
    expect(throwing.coarsePointer).toBe(false);
  });

  it('a forced profile (support and tests) applies to the operate role only', () => {
    expect(forcedProfile('?profile=edit', null)).toBe('edit');
    expect(forcedProfile('', 'full')).toBe('full');
    expect(forcedProfile('?profile=x', 'nope')).toBeNull();
    expect(profileFor(detectCapabilities(chromeDesktop), 'operate', 'edit')).toBe('edit');
    expect(profileFor(detectCapabilities(ipadSafari), 'operate', 'full')).toBe('full');
  });

  it('persistent storage is requested once per device', async () => {
    const store = new Map<string, string>();
    const local = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    let asked = 0;
    const nav = {
      storage: {
        persist: async () => {
          asked++;
          return true;
        },
        persisted: async () => false,
      },
    };
    expect(await requestPersistentStorage(nav, local)).toBe(true);
    expect(await requestPersistentStorage(nav, local)).toBeUndefined();
    expect(asked).toBe(1);
    expect(await requestPersistentStorage({}, local)).toBeUndefined();
  });
});

describe('edit-profile routes', () => {
  it('the previews route round-trips', () => {
    expect(parseRoute('#/previews')).toEqual({ name: 'previews', id: undefined, slideId: undefined });
    expect(parseRoute('#/previews/p1/s2')).toEqual({ name: 'previews', id: 'p1', slideId: 's2' });
    expect(routeHash({ name: 'previews', id: 'p1', slideId: 's2' })).toBe('#/previews/p1/s2');
    expect(routeHash({ name: 'previews' })).toBe('#/previews');
  });

  it('an edit-profile device never opens the live view, the checklist or output settings', () => {
    expect(allowedForRole({ name: 'live' }, 'operate', 'edit')).toBe(false);
    expect(allowedForRole({ name: 'checklist' }, 'operate', 'edit')).toBe(false);
    for (const page of ['outputs', 'audio', 'keys', 'streamdeck', 'midi', 'backups', 'diagnostics'])
      expect(allowedForRole({ name: 'settings', page }, 'operate', 'edit'), page).toBe(false);
    for (const page of ['themes', 'pins', 'looks', 'general', 'messages'])
      expect(allowedForRole({ name: 'settings', page }, 'operate', 'edit'), page).toBe(true);
    expect(allowedForRole({ name: 'settings', page: 'themes' }, 'edit', 'edit')).toBe(false);
    expect(allowedForRole({ name: 'previews' }, 'edit', 'edit')).toBe(true);
    // The venue PC: unchanged.
    expect(allowedForRole({ name: 'live' }, 'operate')).toBe(true);
    expect(allowedForRole({ name: 'settings', page: 'outputs' }, 'operate', 'full')).toBe(true);
  });
});

describe('look previews', () => {
  const song = songFromParsed(parseLyrics('Song\n\nVerse 1\na\nb\n\nChorus\nc\nd\n'), { title: 'Song' });

  it('orders the looks main, lower third, stream, stage', () => {
    const shuffled = [DEFAULT_LOOKS[3]!, DEFAULT_LOOKS[2]!, DEFAULT_LOOKS[0]!, DEFAULT_LOOKS[1]!];
    expect(previewLooks(shuffled).map((l) => l.kind)).toEqual(['main', 'lowerThird', 'stream', 'stage']);
  });

  it('finds the slide and the next one, falling back to the first', () => {
    const all = flatSlides(song);
    expect(all.length).toBe(2);
    expect(slideAndNext(song, all[0]!.id)).toMatchObject({ slide: all[0], next: all[1], index: 0 });
    expect(slideAndNext(song, all[1]!.id)).toMatchObject({ slide: all[1], next: undefined, index: 1 });
    expect(slideAndNext(song, 'gone')).toMatchObject({ slide: all[0], index: 0 });
  });

  it('a look shows the slide background only when its background layer is visible', () => {
    const p = { ...song, backgroundMediaId: 'bg' };
    const slide = flatSlides(p)[0]!;
    const [main, lower] = DEFAULT_LOOKS;
    expect(lookBackgroundId(main!, p, slide)).toBe('bg');
    expect(lookBackgroundId(main!, p, { ...slide, backgroundMediaId: 'own' })).toBe('own');
    expect(lookBackgroundId(lower!, p, slide)).toBeUndefined();
    expect(lookBackgroundId({ ...lower!, holdingMediaId: 'hold' }, p, slide)).toBe('hold');
  });
});

describe('venue live summary', () => {
  it('is undefined when idle', () => {
    expect(summarize(initialState())).toBeUndefined();
    expect(fromSummary({ seq: 1, mode: 'idle', lockedPresentationIds: [] })).toBeUndefined();
  });

  it('keeps what the chip and the editor lock need from GET /live/summary', () => {
    expect(
      fromSummary({
        seq: 4,
        mode: 'live',
        playlistId: 'pl',
        playlistName: 'Sunday',
        liveLabel: 'Verse 1',
        lockedPresentationIds: ['b', 'a'],
      }),
    ).toEqual({ playlistId: 'pl', playlistName: 'Sunday', cueLabel: 'Verse 1', presentationIds: ['a', 'b'] });
  });

  it('reads the summary with either PIN and falls back to GET /live only for operate on an older hub', async () => {
    const seen: string[] = [];
    const summary = async <T>(path: string): Promise<T> => {
      seen.push(path);
      return { seq: 2, mode: 'live', playlistId: 'pl', playlistName: 'S', lockedPresentationIds: ['a'] } as T;
    };
    expect(await fetchVenueLive('edit', summary)).toMatchObject({ seq: 2, live: { presentationIds: ['a'] } });
    expect(seen).toEqual(['/live/summary']);
    const old = async <T>(path: string): Promise<T> => {
      seen.push(path);
      if (path === '/live/summary') throw Object.assign(new Error('not found'), { status: 404 });
      return { seq: 7, state: initialState() } as T;
    };
    expect(await fetchVenueLive('operate', old)).toEqual({ seq: 7, live: undefined });
    await expect(fetchVenueLive('edit', old)).rejects.toThrow('not found');
  });
});

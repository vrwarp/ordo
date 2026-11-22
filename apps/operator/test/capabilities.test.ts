import { DEFAULT_LOOKS, parseLyrics, songFromParsed } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import { describe, expect, it, vi } from 'vitest';
import {
  BAKE_MIN_MEMORY_GB,
  BAKE_ROLES,
  type BakeInput,
  bakeEngine,
  type CapabilityEnv,
  canBake,
  detectCapabilities,
  forcedProfile,
  profileFor,
  requestPersistentStorage,
  useCapabilities,
} from '../src/lib/capabilities.ts';
import { bakeGate, forcedBakeOff, readBakeWorld } from '../src/lib/bakeWorld.ts';
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

  it('an iPad with a trackpad (fine pointer, hover, fullscreen API) is still an editor', () => {
    const c = detectCapabilities({
      ...ipadSafari,
      matchMedia: mq({ '(pointer: fine)': true, '(hover: hover)': true }),
    });
    expect(c.coarsePointer).toBe(false);
    expect(c.fullscreenPopups).toBe(true);
    expect(profileFor(c, 'operate')).toBe('edit');
  });

  it('a desktop browser without WebHID or Window Management (Firefox, Safari) edits only', () => {
    const c = detectCapabilities({
      ...ipadSafari,
      matchMedia: mq({ '(pointer: fine)': true }),
      navigator: {},
    });
    expect(profileFor(c, 'operate')).toBe('edit');
    expect(profileFor({ ...c, hid: true }, 'operate')).toBe('full');
    expect(profileFor({ ...c, windowManagement: true }, 'operate')).toBe('full');
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
    // The forced-profile guard (design/28 §3.1, §10 item 1): a forced `full` on a device with neither Window
    // Management nor WebHID (iPad Safari, a phone, Android Chrome) would give a broken operator; ignored.
    expect(profileFor(detectCapabilities(ipadSafari), 'operate', 'full')).toBe('edit');
  });

  it('a forced full profile needs Window Management or WebHID; a forced edit always applies', () => {
    const none = detectCapabilities({ ...ipadSafari, navigator: {}, window: {} });
    expect(none.hid || none.windowManagement).toBe(false);
    expect(profileFor(none, 'operate', 'full')).toBe('edit');
    expect(profileFor({ ...none, windowManagement: true }, 'operate', 'full')).toBe('full');
    expect(profileFor({ ...none, hid: true }, 'operate', 'full')).toBe('full');
    expect(profileFor(none, 'operate', 'edit')).toBe('edit');
    expect(profileFor(detectCapabilities(chromeDesktop), 'operate', 'edit')).toBe('edit');
    expect(profileFor(detectCapabilities(chromeDesktop), 'operate', 'full')).toBe('full');
    // Never over the edit role.
    expect(profileFor(detectCapabilities(chromeDesktop), 'edit', 'full')).toBe('edit');
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
    expect(parseRoute('#/library/themes')).toEqual({ name: 'library', tab: 'themes' });
    expect(parseRoute('#/settings/themes')).toEqual({ name: 'library', tab: 'themes' });
    expect(routeHash({ name: 'library', tab: 'themes' })).toBe('#/library/themes');
  });

  it('an edit-profile device never opens the live view, the checklist or output settings', () => {
    expect(allowedForRole({ name: 'live' }, 'operate', 'edit')).toBe(false);
    expect(allowedForRole({ name: 'checklist' }, 'operate', 'edit')).toBe(false);
    for (const page of ['outputs', 'audio', 'keys', 'streamdeck', 'midi', 'backups', 'diagnostics'])
      expect(allowedForRole({ name: 'settings', page }, 'operate', 'edit'), page).toBe(false);
    for (const page of ['pins', 'looks', 'general', 'messages'])
      expect(allowedForRole({ name: 'settings', page }, 'operate', 'edit'), page).toBe(true);
    expect(allowedForRole({ name: 'library', tab: 'themes' }, 'edit', 'edit')).toBe(true);
    expect(allowedForRole({ name: 'library', tab: 'themes' }, 'operate', 'edit')).toBe(true);
    expect(allowedForRole({ name: 'settings', page: 'looks' }, 'edit', 'edit')).toBe(false);
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

  it('the next slide follows the first arrangement, as the stage display does', () => {
    const [a, b] = song.sections;
    const arranged = {
      ...song,
      arrangements: [{ id: 'arr', name: 'Sunday', sectionIds: [b!.id, a!.id, b!.id] }],
    };
    const all = flatSlides(song);
    // Authoring order says nothing follows the last slide; the arrangement plays section A after B.
    expect(slideAndNext(arranged, all[1]!.id)).toMatchObject({ slide: all[1], next: all[0] });
    expect(slideAndNext(arranged, all[0]!.id)).toMatchObject({ slide: all[0], next: all[1] });
  });

  it('the next slide skips hidden slides, as Next does (design/27 §9)', () => {
    const all = flatSlides(song);
    const withHidden = {
      ...song,
      sections: [
        { ...song.sections[0]!, slides: [all[0]!, { ...all[0]!, id: 'h', hidden: true }] },
        song.sections[1]!,
      ],
    };
    expect(slideAndNext(withHidden, all[0]!.id)).toMatchObject({ slide: all[0], next: all[1] });
    // A hidden slide still previews, followed by the next shown one.
    expect(slideAndNext(withHidden, 'h')).toMatchObject({ slide: { id: 'h' }, next: all[1] });
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

describe('bake gate (who makes the pictures of heavy slides)', () => {
  const finePointer = mq({ '(pointer: fine)': true, '(hover: hover)': true });

  /** Chrome on a desktop over a plain http LAN address: a secure-context-only API is missing, so none of the three exist. */
  const chromeOverHttp: CapabilityEnv = {
    navigator: { storage: { getDirectory: () => undefined } },
    window: {},
    document: { fullscreenEnabled: true },
    matchMedia: finePointer,
    mediaElementProto: { setSinkId: () => undefined },
    elementProto: { requestFullscreen: () => undefined },
  };
  /** An iPad with a keyboard and trackpad: fine pointer, hover, installed, none of the Chromium APIs. */
  const ipadWithMouse: CapabilityEnv = { ...ipadSafari, matchMedia: finePointer };
  const desktopSafari: CapabilityEnv = { ...ipadSafari, navigator: {}, matchMedia: finePointer };
  const desktopFirefox: CapabilityEnv = {
    ...desktopSafari,
    navigator: { requestMIDIAccess: () => undefined },
  };
  /** Android Chrome as e2e/touchdevice.ts models it: a coarse pointer, no WebHID, no Window Management, mobile. */
  const androidChrome: CapabilityEnv = {
    ...ipadSafari,
    navigator: { userAgentData: { mobile: true }, storage: { getDirectory: () => undefined } },
  };

  it('C1 the venue PC is an engine that may bake', () => {
    expect(bakeEngine(chromeDesktop)).toBe(true);
  });

  it('C2 Chrome over plain http (a laptop on a LAN address) is not: none of the three secure-context APIs exist', () => {
    expect(bakeEngine(chromeOverHttp)).toBe(false);
  });

  it('C3 iPad Safari is not', () => {
    expect(bakeEngine(ipadSafari)).toBe(false);
  });

  it('C4 an iPad with a keyboard and trackpad is not (the editor rule of OQ-LE3 is not borrowed here)', () => {
    const c = detectCapabilities(ipadWithMouse);
    expect(c.coarsePointer).toBe(false);
    expect(c.fullscreenPopups).toBe(true);
    expect(bakeEngine(ipadWithMouse)).toBe(false);
  });

  it('C5 desktop Safari and desktop Firefox are not', () => {
    expect(bakeEngine(desktopSafari)).toBe(false);
    expect(bakeEngine(desktopFirefox)).toBe(false);
  });

  it('C6 Android Chromium is not, for two reasons: not an engine of ours and a coarse pointer', () => {
    expect(bakeEngine(androidChrome)).toBe(false);
    expect(detectCapabilities(androidChrome).coarsePointer).toBe(true);
    const input = { ...good(), caps: detectCapabilities(androidChrome), engine: bakeEngine(androidChrome) };
    expect(canBake(input)).toMatchObject({ ok: false, why: 'unsupported' });
    // the pointer alone is enough, and so is the engine alone
    expect(canBake({ ...good(), caps: input.caps })).toMatchObject({ ok: false, why: 'unsupported' });
    expect(canBake({ ...good(), engine: input.engine })).toMatchObject({ ok: false, why: 'unsupported' });
  });

  it('C7 userAgentData alone counts, unless it says mobile', () => {
    expect(bakeEngine({ navigator: { userAgentData: { mobile: false } } })).toBe(true);
    expect(bakeEngine({ navigator: { userAgentData: {} } })).toBe(true);
    expect(bakeEngine({ navigator: { userAgentData: { mobile: true } } })).toBe(false);
    expect(bakeEngine({ window: { getScreenDetails: () => undefined } })).toBe(true);
    expect(bakeEngine({ navigator: { hid: {} } })).toBe(true);
    expect(bakeEngine({})).toBe(false);
    expect(bakeEngine({ navigator: null, window: 5 })).toBe(false);
  });

  /** A computer that may bake: the venue PC, regular layout, the hub's switch on, an operator session. */
  function good(): BakeInput {
    return {
      caps: detectCapabilities(chromeDesktop),
      engine: true,
      layout: 'regular',
      phone: false,
      demo: false,
      hub: 'on',
      secure: true,
      offscreen: true,
      worker: true,
      memoryGb: 8,
      role: 'operate',
      forcedOff: false,
    };
  }

  it('C8 everything in order bakes, and may list', () => {
    expect(canBake(good())).toEqual({ ok: true, list: true });
  });

  it('C9 a coarse pointer does not, C10 a compact layout does not, C11 a phone does not', () => {
    const coarse = detectCapabilities({
      ...chromeDesktop,
      matchMedia: mq({ '(pointer: coarse)': true, '(hover: none)': true }),
    });
    expect(canBake({ ...good(), caps: coarse })).toMatchObject({ ok: false, why: 'unsupported' });
    expect(canBake({ ...good(), layout: 'compact' })).toMatchObject({
      ok: false,
      why: 'unsupported',
      list: false,
    });
    expect(canBake({ ...good(), phone: true })).toMatchObject({ ok: false, why: 'unsupported', list: false });
  });

  it('C12 the demo is off, C13 the hub wins: a switch that is off is off on a capable device, C14 no answer is unknown', () => {
    expect(canBake({ ...good(), demo: true })).toEqual({ ok: false, why: 'off', list: false });
    expect(canBake({ ...good(), hub: 'off' })).toEqual({ ok: false, why: 'off', list: false });
    // even a phone with the hub off says off: nobody makes pictures, whatever this device is
    expect(canBake({ ...good(), hub: 'off', phone: true })).toMatchObject({ ok: false, why: 'off' });
    expect(canBake({ ...good(), hub: undefined })).toEqual({ ok: false, why: 'unknown', list: false });
    // the demo wins over everything
    expect(canBake({ ...good(), demo: true, hub: undefined })).toMatchObject({ why: 'off' });
  });

  it('C15 no OffscreenCanvas or no Worker, and a page that is not a secure context, do not bake', () => {
    expect(canBake({ ...good(), offscreen: false })).toMatchObject({ ok: false, why: 'unsupported' });
    expect(canBake({ ...good(), worker: false })).toMatchObject({ ok: false, why: 'unsupported' });
    expect(canBake({ ...good(), secure: false })).toMatchObject({ ok: false, why: 'unsupported' });
  });

  it('C16 under 4 GB of memory does not bake; 4, 8 and no answer do', () => {
    expect(BAKE_MIN_MEMORY_GB).toBe(4);
    expect(canBake({ ...good(), memoryGb: 2 })).toMatchObject({ ok: false, why: 'unsupported' });
    expect(canBake({ ...good(), memoryGb: 0.5 })).toMatchObject({ ok: false, why: 'unsupported' });
    expect(canBake({ ...good(), memoryGb: 4 })).toMatchObject({ ok: true });
    expect(canBake({ ...good(), memoryGb: 8 })).toMatchObject({ ok: true });
    expect(canBake({ ...good(), memoryGb: undefined })).toMatchObject({ ok: true });
  });

  it('C17 ?bake=off and localStorage ordo.bake=off make this computer make none (the gate says it)', () => {
    expect(canBake({ ...good(), forcedOff: true })).toMatchObject({
      ok: false,
      why: 'unsupported',
      list: true,
    });
    expect(forcedBakeOff('?bake=off', null)).toBe(true);
    expect(forcedBakeOff('', 'off')).toBe(true);
    expect(forcedBakeOff('?bake=on', 'off')).toBe(false);
    expect(forcedBakeOff('?x=1', 'on')).toBe(false);
    expect(forcedBakeOff('', null)).toBe(false);
  });

  it('C18 the roles that bake are a list: both by default, an editor does not when only operators may (Q30.c.b)', () => {
    expect([...BAKE_ROLES]).toEqual(['operate', 'edit']);
    expect(canBake({ ...good(), role: 'edit' })).toMatchObject({ ok: true });
    expect(canBake({ ...good(), role: 'edit' }, ['operate'])).toMatchObject({
      ok: false,
      why: 'unsupported',
      list: true,
    });
    expect(canBake({ ...good(), role: 'operate' }, ['operate'])).toMatchObject({ ok: true });
    // no session yet: not known
    expect(canBake({ ...good(), role: undefined })).toMatchObject({ ok: false, why: 'unknown', list: false });
    expect(canBake({ ...good(), role: null })).toMatchObject({ ok: false, why: 'unknown' });
  });

  it('C19 an iPad may read the listing and never make a picture; a phone and the demo may not read it', () => {
    const ipad: BakeInput = {
      ...good(),
      caps: detectCapabilities(ipadWithMouse),
      engine: bakeEngine(ipadWithMouse),
      role: 'edit',
    };
    expect(canBake(ipad)).toEqual({ ok: false, why: 'unsupported', list: true });
    expect(canBake({ ...ipad, phone: true })).toMatchObject({ list: false });
    expect(canBake({ ...ipad, layout: 'compact' })).toMatchObject({ list: false });
    expect(canBake({ ...ipad, demo: true })).toMatchObject({ list: false });
    expect(canBake({ ...ipad, hub: 'off' })).toMatchObject({ list: false });
    expect(canBake({ ...ipad, hub: undefined })).toMatchObject({ list: false });
    expect(canBake({ ...ipad, role: undefined })).toMatchObject({ list: false });
  });

  type Stub = {
    navigator: unknown;
    window: Record<string, unknown>;
    document: unknown;
    isSecureContext: boolean;
    search: string;
  };
  let stubbed: Stub;
  function stubBrowser(s: Stub): void {
    stubbed = s;
    vi.stubGlobal('navigator', s.navigator);
    vi.stubGlobal('window', s.window);
    vi.stubGlobal('document', s.document);
    vi.stubGlobal('isSecureContext', s.isSecureContext);
    vi.stubGlobal('location', { search: s.search });
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('Worker', class {});
  }

  it('bakeGate reads the real environment: stubbed globals of the venue PC, then of an iPad with a mouse', () => {
    const was = useCapabilities.getState().caps;
    const parts = { layout: 'regular', phone: false, demo: false, hub: 'on', role: 'operate' } as const;
    try {
      stubBrowser({
        navigator: {
          ...(chromeDesktop.navigator as object),
          userAgentData: { mobile: false },
          deviceMemory: 8,
        },
        window: { getScreenDetails: () => undefined, matchMedia: finePointer },
        document: chromeDesktop.document,
        isSecureContext: true,
        search: '',
      });
      useCapabilities.setState({ caps: detectCapabilities(chromeDesktop) });
      expect(bakeGate(parts)).toEqual({ ok: true, list: true });
      expect(readBakeWorld()).toMatchObject({
        engine: true,
        secure: true,
        offscreen: true,
        worker: true,
        memoryGb: 8,
        forcedOff: false,
      });
      // the same page with ?bake=off, with 2 GB, and without a secure context
      stubBrowser({ ...stubbed, search: '?bake=off' });
      expect(bakeGate(parts)).toMatchObject({ ok: false, why: 'unsupported', list: true });
      stubBrowser({
        ...stubbed,
        search: '',
        navigator: { ...(stubbed.navigator as object), deviceMemory: 2 },
      });
      expect(bakeGate(parts)).toMatchObject({ ok: false, why: 'unsupported' });
      stubBrowser({
        ...stubbed,
        navigator: { ...(stubbed.navigator as object), deviceMemory: 8 },
        isSecureContext: false,
      });
      expect(bakeGate(parts)).toMatchObject({ ok: false, why: 'unsupported' });
      // an iPad with a mouse: the same code, other globals
      stubBrowser({
        navigator: { standalone: true },
        window: { matchMedia: finePointer },
        document: { fullscreenEnabled: true },
        isSecureContext: true,
        search: '',
      });
      useCapabilities.setState({ caps: detectCapabilities(ipadWithMouse) });
      expect(bakeGate({ ...parts, role: 'edit' })).toEqual({ ok: false, why: 'unsupported', list: true });
    } finally {
      vi.unstubAllGlobals();
      useCapabilities.setState({ caps: was });
    }
  });
});

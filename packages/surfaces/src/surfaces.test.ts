import type { MidiMapping } from '@ordo/domain';
import { DEFAULT_KEYMAP } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  type Action,
  type DeckView,
  defaultDeckPages,
  dialActions,
  faceKey,
  KeyboardDriver,
  keyFace,
  lcdText,
  learnFrom,
  MidiDriver,
  matchMidi,
  normalizeCombo,
  pageTarget,
  resolvePageTarget,
  wrapText,
} from './index.ts';

const ev = (
  code: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({
  code,
  key: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('normalizeCombo', () => {
  it('normalizes codes and modifiers', () => {
    expect(normalizeCombo(ev('KeyL', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+L');
    expect(normalizeCombo(ev('KeyL', { metaKey: true }))).toBe('Ctrl+L');
    expect(normalizeCombo(ev('Space'))).toBe('Space');
    expect(normalizeCombo(ev('F8', { shiftKey: true }))).toBe('Shift+F8');
    expect(normalizeCombo(ev('Digit1'))).toBe('Digit1');
    expect(normalizeCombo(ev('ArrowRight', { altKey: true }))).toBe('Alt+ArrowRight');
    expect(normalizeCombo({ ...ev(''), key: ' ' })).toBe('Space');
    expect(normalizeCombo({ ...ev(''), key: 'q' })).toBe('Q');
  });
});

class FakeTarget extends EventTarget {}
function keydown(
  target: EventTarget,
  code: string,
  init: { repeat?: boolean; shiftKey?: boolean; ctrlKey?: boolean; tagName?: string } = {},
) {
  const e = new Event('keydown', { cancelable: true });
  Object.assign(e, {
    code,
    key: '',
    ctrlKey: !!init.ctrlKey,
    metaKey: false,
    altKey: false,
    shiftKey: !!init.shiftKey,
    repeat: !!init.repeat,
    isComposing: false,
  });
  if (init.tagName) {
    // Simulate an event coming from a form field.
    Object.defineProperty(e, 'target', { value: { tagName: init.tagName, isContentEditable: false } });
  }
  target.dispatchEvent(e);
  return e;
}

describe('KeyboardDriver', () => {
  it('dispatches mapped actions and prevents default', () => {
    const got: Action[] = [];
    const d = new KeyboardDriver(DEFAULT_KEYMAP, (a, src) => {
      expect(src).toBe('keyboard');
      got.push(a);
    });
    const t = new FakeTarget();
    d.attach(t as unknown as Window);
    const e = keydown(t, 'Space');
    expect(e.defaultPrevented).toBe(true);
    keydown(t, 'Digit3');
    keydown(t, 'F8', { shiftKey: true });
    keydown(t, 'KeyZ');
    expect(got).toEqual([{ id: 'next' }, { id: 'goToSlide', arg: 3 }, { id: 'mediaRestart' }]);
    d.detach(t as unknown as Window);
    keydown(t, 'Space');
    expect(got).toHaveLength(3);
  });

  it('ignores repeats except for navigation, and text fields', () => {
    const got: Action[] = [];
    const d = new KeyboardDriver(DEFAULT_KEYMAP, (a) => got.push(a), { now: () => 0 });
    const t = new FakeTarget();
    d.attach(t as unknown as Window);
    keydown(t, 'F2', { repeat: true });
    keydown(t, 'ArrowRight', { repeat: true });
    keydown(t, 'Space', { tagName: 'INPUT' });
    keydown(t, 'ShiftLeft', { shiftKey: true });
    expect(got).toEqual([{ id: 'next' }]);
    d.setMap({ KeyB: { id: 'clearAll' }, B: { id: 'logo' } });
    keydown(t, 'KeyB');
    expect(got.at(-1)).toEqual({ id: 'logo' });
  });

  it('never auto-repeats Space, PageUp or PageDown (item 31)', () => {
    const got: Action[] = [];
    const d = new KeyboardDriver(DEFAULT_KEYMAP, (a) => got.push(a), { now: () => 0 });
    const t = new FakeTarget();
    d.attach(t as unknown as Window);
    keydown(t, 'Space');
    for (const code of ['Space', 'PageDown', 'PageUp']) {
      for (let i = 0; i < 30; i++) {
        const e = keydown(t, code, { repeat: true });
        expect(e.defaultPrevented).toBe(true); // a held Space must not scroll the page either
      }
    }
    expect(got).toEqual([{ id: 'next' }]);
    keydown(t, 'PageDown');
    expect(got).toHaveLength(2);
  });

  it('rate-limits held arrow keys to about four steps a second (item 31)', () => {
    const got: Action[] = [];
    let now = 1000;
    const d = new KeyboardDriver(DEFAULT_KEYMAP, (a) => got.push(a), { now: () => now });
    const t = new FakeTarget();
    d.attach(t as unknown as Window);
    keydown(t, 'ArrowRight');
    // Chrome repeats at ~30 Hz: a second of held key should step about four times, not thirty.
    for (let i = 0; i < 30; i++) {
      now += 33;
      keydown(t, 'ArrowRight', { repeat: true });
    }
    expect(got.filter((a) => a.id === 'next')).toHaveLength(4);
    // The first press after a release is never delayed.
    now += 10;
    keydown(t, 'ArrowLeft');
    expect(got.at(-1)!.id).toBe('prev');
  });
});

describe('matchMidi', () => {
  const maps: MidiMapping[] = [
    { id: 'n', kind: 'note', number: 60, threshold: 64, action: { id: 'next' } },
    { id: 'p', kind: 'note', number: 62, threshold: 1, channel: 2, action: { id: 'prev' } },
    { id: 'c', kind: 'cc', number: 64, threshold: 64, deviceName: 'FS-1', action: { id: 'go' } },
    { id: 's', kind: 'note', number: 36, threshold: 1, action: { id: 'goToSection', arg: 2 } },
  ];
  it('fires note-on at or above the velocity threshold', () => {
    const cc = new Map<string, number>();
    expect(matchMidi(maps, 'Any', new Uint8Array([0x90, 60, 100]), cc)).toEqual([{ id: 'next' }]);
    expect(matchMidi(maps, 'Any', new Uint8Array([0x90, 60, 64]), cc)).toEqual([{ id: 'next' }]);
    expect(matchMidi(maps, 'Any', new Uint8Array([0x90, 60, 63]), cc)).toEqual([]);
    expect(matchMidi(maps, 'Any', new Uint8Array([0x99, 36, 10]), cc)).toEqual([
      { id: 'goToSection', arg: 2 },
    ]);
  });
  it('ignores note-on with velocity 0 and note-off', () => {
    const cc = new Map<string, number>();
    expect(matchMidi(maps, 'Any', new Uint8Array([0x90, 60, 0]), cc)).toEqual([]);
    expect(matchMidi(maps, 'Any', new Uint8Array([0x80, 60, 100]), cc)).toEqual([]);
  });
  it('filters by channel (1-based) and device name', () => {
    const cc = new Map<string, number>();
    expect(matchMidi(maps, 'Any', new Uint8Array([0x90, 62, 90]), cc)).toEqual([]);
    expect(matchMidi(maps, 'Any', new Uint8Array([0x91, 62, 90]), cc)).toEqual([{ id: 'prev' }]);
    expect(matchMidi(maps, 'Other', new Uint8Array([0xb0, 64, 127]), cc)).toEqual([]);
  });
  it('edge-triggers CC on an upward threshold crossing', () => {
    const cc = new Map<string, number>();
    const send = (v: number) => matchMidi(maps, 'fs-1', new Uint8Array([0xb0, 64, v]), cc);
    expect(send(127)).toEqual([{ id: 'go' }]);
    expect(send(127)).toEqual([]);
    expect(send(100)).toEqual([]);
    expect(send(0)).toEqual([]);
    expect(send(30)).toEqual([]);
    expect(send(64)).toEqual([{ id: 'go' }]);
  });
  it('ignores system and short messages', () => {
    const cc = new Map<string, number>();
    expect(matchMidi(maps, 'Any', new Uint8Array([0xf8]), cc)).toEqual([]);
    expect(matchMidi(maps, 'Any', new Uint8Array([0xf0, 1, 2, 0xf7]), cc)).toEqual([]);
  });
});

describe('MIDI learn', () => {
  it('captures the next qualifying note and suppresses dispatch while learning', async () => {
    const fired: Action[] = [];
    const d = new MidiDriver((a) => fired.push(a));
    d.setMappings([{ id: 'n', kind: 'note', number: 60, threshold: 1, action: { id: 'next' } }]);
    const p = d.learn({ id: 'logo' }, 1000);
    d.handle('Pedal', new Uint8Array([0x90, 60, 0]));
    d.handle('Pedal', new Uint8Array([0x92, 61, 80]));
    const m = await p;
    expect(m).toMatchObject({
      deviceName: 'Pedal',
      kind: 'note',
      number: 61,
      channel: 3,
      action: { id: 'logo' },
    });
    expect(fired).toEqual([]);
    d.handle('Pedal', new Uint8Array([0x90, 60, 100]));
    expect(fired).toEqual([{ id: 'next' }]);
  });
  it('times out with null', async () => {
    const d = new MidiDriver(() => {});
    expect(await d.learn({ id: 'go' }, 10)).toBeNull();
  });
  it('learns CC only on an upward press', () => {
    const cc = new Map<string, number>();
    expect(learnFrom({ id: 'go' }, 'X', new Uint8Array([0xb0, 4, 10]), cc)).toBeNull();
    expect(learnFrom({ id: 'go' }, 'X', new Uint8Array([0xb0, 4, 127]), cc)).toMatchObject({
      kind: 'cc',
      number: 4,
      threshold: 64,
    });
  });
});

describe('defaultDeckPages', () => {
  for (const n of [6, 8, 15, 32]) {
    it(`fills ${n}-key decks with Live, Stage and Audio pages`, () => {
      const pages = defaultDeckPages(n);
      expect(pages.map((p) => p.name)).toEqual(['Live', 'Stage', 'Audio']);
      for (const p of pages) {
        const idx = Object.keys(p.keys).map(Number);
        expect(Math.max(...idx)).toBeLessThan(n);
        // Every page has a way to the next page.
        expect(Object.values(p.keys).some((k) => pageTarget(k) === 'next')).toBe(true);
      }
      const live = Object.values(pages[0]!.keys);
      expect(live.some((k) => k.action?.id === 'next')).toBe(true);
      expect(live.some((k) => k.action?.id === 'clearAll' || k.action?.id === 'go')).toBe(true);
    });
  }
  it('shows sections and the next three items on 15 and 32 key decks', () => {
    for (const n of [15, 32]) {
      const live = Object.values(defaultDeckPages(n)[0]!.keys);
      expect(live.filter((k) => k.dynamic === 'section').length).toBeGreaterThanOrEqual(4);
      expect(live.filter((k) => k.dynamic === 'nextItem').map((k) => k.dynamicIndex)).toEqual([0, 1, 2]);
    }
  });
  it('covers other sizes and none', () => {
    expect(defaultDeckPages(0)).toEqual([]);
    const p3 = defaultDeckPages(3);
    expect(Object.keys(p3[0]!.keys)).toEqual(['0', '1', '2']);
  });
});

const view: DeckView = {
  sections: [
    { short: 'V1', label: 'Verse 1', pos: 0 },
    { short: 'C', label: 'Chorus', pos: 1 },
  ],
  liveSectionPos: 1,
  nextItems: ['Amazing Grace', 'Offering'],
  black: false,
  logo: true,
  mediaPlaying: true,
  liveLabel: 'Chorus 1/2',
  connected: true,
  masterDb: -3,
};

describe('keyFace', () => {
  it('highlights the live section', () => {
    const v1 = keyFace({ dynamic: 'section', dynamicIndex: 0 }, view);
    const c = keyFace({ dynamic: 'section', dynamicIndex: 1 }, view);
    expect(v1).toMatchObject({ label: 'V1', sub: 'Verse 1' });
    expect(v1.ring).toBeUndefined();
    expect(c).toMatchObject({ label: 'C', fg: '#000000', ring: '#ffffff' });
    expect(keyFace({ dynamic: 'section', dynamicIndex: 5 }, view).label).toBe('');
  });
  it('shows upcoming items', () => {
    expect(keyFace({ dynamic: 'nextItem', dynamicIndex: 1 }, view)).toMatchObject({
      label: 'Offering',
      sub: 'Next 2',
    });
    expect(keyFace({ dynamic: 'nextItem', dynamicIndex: 2 }, view).label).toBe('');
  });
  it('reflects state on action keys', () => {
    expect(keyFace({ action: { id: 'mediaPlayPause' }, label: 'Play' }, view).label).toBe('Pause');
    expect(
      keyFace(
        { action: { id: 'mediaPlayPause' }, label: 'Play' },
        { ...view, mediaPlaying: false, slideSoundWaiting: true },
      ),
    ).toMatchObject({ label: 'Play', sub: 'sound' });
    expect(keyFace({ action: { id: 'mediaPlayPause' }, label: 'Play' }, view).sub).toBeUndefined();
    expect(keyFace({ action: { id: 'logo' }, label: 'Logo' }, view)).toMatchObject({
      sub: 'on',
      fg: '#000000',
    });
    expect(keyFace({ action: { id: 'go' }, label: 'GO' }, view).sub).toBe('Chorus 1/2');
    expect(keyFace({ action: { id: 'audioMasterUp' }, label: 'Vol +' }, view).sub).toBe('-3 dB');
    expect(
      keyFace({ action: { id: 'clearAll' }, label: 'Clear all' }, view, { confirming: true }).label,
    ).toBe('Again to clear');
    expect(keyFace({ action: { id: 'go' } }, { ...view, connected: false })).toMatchObject({
      dim: true,
      sub: 'offline',
    });
  });
  it('labels page keys with the destination', () => {
    const pages = defaultDeckPages(15);
    expect(keyFace({ label: 'Page:next' }, view, { pages, pageIndex: 0 }).label).toBe('Stage');
    expect(keyFace({ label: 'Page:next' }, view, { pages, pageIndex: 2 }).label).toBe('Live');
    expect(resolvePageTarget(pages, 0, 'Audio')).toBe(2);
    expect(resolvePageTarget(pages, 0, 'prev')).toBe(2);
  });
  it('changes face keys only when the look changes', () => {
    const k = { dynamic: 'section' as const, dynamicIndex: 0 };
    expect(faceKey(keyFace(k, view))).toBe(faceKey(keyFace(k, { ...view, nextItems: [] })));
    expect(faceKey(keyFace(k, view))).not.toBe(faceKey(keyFace(k, { ...view, liveSectionPos: 0 })));
  });
  it('describes the Plus strip', () => {
    expect(lcdText(view, 'Live')).toEqual({
      title: 'Chorus 1/2',
      sub: 'Live  ·  Master -3 dB  ·  Next: Amazing Grace',
    });
  });
});

describe('dialActions', () => {
  it('maps Plus dials to master gain, playlist scroll and slides', () => {
    expect(dialActions(0, 2)).toEqual([{ id: 'audioMasterUp' }, { id: 'audioMasterUp' }]);
    expect(dialActions(0, -1)).toEqual([{ id: 'audioMasterDown' }]);
    expect(dialActions(1, 1)).toEqual([{ id: 'nextItem' }]);
    expect(dialActions(1, -9)).toHaveLength(5);
    expect(dialActions(0, 'press')).toEqual([{ id: 'audioMute' }]);
    expect(dialActions(3, 1)).toBe('pageNext');
  });
});

describe('wrapText', () => {
  const measure = (s: string) => s.length * 10;
  it('wraps and ellipsises', () => {
    expect(wrapText(measure, 'Amazing Grace', 80, 2)).toEqual(['Amazing', 'Grace']);
    expect(wrapText(measure, 'one two three four', 80, 1)[0]!.endsWith('…')).toBe(true);
  });
});

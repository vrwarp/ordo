/**
 * The layout class and the phone class (design/28 decision 3, §3.1, §3.2; lib/layout.ts): compact only for a
 * device whose capability profile is not full in a small viewport, the deferral while the editor is open, the
 * phone from the screen (never the viewport), and the document attribute on the compact layout only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type CapabilityEnv, detectCapabilities, profileFor } from '../src/lib/capabilities.ts';
import {
  applyLayout,
  COMPACT_QUERY,
  currentLayout,
  isPhone,
  layoutFor,
  nextLayout,
  onLayoutChange,
  resetLayoutForTests,
  signInCap,
  startLayout,
} from '../src/lib/layout.ts';

/** matchMedia for a viewport of w x h CSS px: the compact query evaluated as a browser would. */
function viewport(w: number, h: number, other: Record<string, boolean> = {}) {
  return (q: string): { matches: boolean } => {
    if (q === COMPACT_QUERY) return { matches: w <= 699 || h <= 499 };
    return { matches: !!other[q] };
  };
}

const venuePc: CapabilityEnv = {
  navigator: { hid: {}, requestMIDIAccess: () => undefined },
  window: { getScreenDetails: () => undefined },
  document: { fullscreenEnabled: true },
  matchMedia: viewport(1280, 720, { '(pointer: fine)': true, '(hover: hover)': true }),
  elementProto: { requestFullscreen: () => undefined },
};
const touch = { '(pointer: coarse)': true, '(hover: none)': true };
const phoneEnv: CapabilityEnv = {
  navigator: {},
  window: {},
  document: {},
  matchMedia: viewport(390, 844, touch),
};

const full = profileFor(detectCapabilities(venuePc), 'operate');
const edit = profileFor(detectCapabilities(phoneEnv), 'operate');

afterEach(() => resetLayoutForTests());

describe('layoutFor (decision 3)', () => {
  it('the full profile is regular at every size', () => {
    expect(full).toBe('full');
    for (const [w, h] of [
      [600, 900],
      [1280, 480],
      [300, 300],
      [1280, 720],
    ] as const)
      expect(layoutFor(full, viewport(w, h)(COMPACT_QUERY).matches), `${w}x${h}`).toBe('regular');
  });

  it('the edit profile is compact under 700 wide or 500 tall, regular otherwise', () => {
    expect(edit).toBe('edit');
    for (const [w, h] of [
      [390, 844],
      [360, 800],
      [844, 390],
      [699, 900],
      [700, 499],
    ] as const)
      expect(layoutFor(edit, viewport(w, h)(COMPACT_QUERY).matches), `${w}x${h}`).toBe('compact');
    for (const [w, h] of [
      [834, 1194],
      [1194, 834],
      [800, 1280],
      [700, 500],
    ] as const)
      expect(layoutFor(edit, viewport(w, h)(COMPACT_QUERY).matches), `${w}x${h}`).toBe('regular');
  });

  it('a full-capability device signed in with the edit PIN stays regular at 600x900', () => {
    const caps = detectCapabilities({ ...venuePc, matchMedia: viewport(600, 900) });
    // The session's profile is edit (the edit role), but the layout reads the device's capability profile.
    expect(profileFor(caps, 'edit')).toBe('edit');
    expect(startLayout(profileFor(caps, 'operate'), viewport(600, 900))).toBe('regular');
  });

  it('startLayout applies the same rule before the session', () => {
    expect(startLayout(edit, viewport(390, 844))).toBe('compact');
    expect(startLayout(edit, viewport(834, 1194))).toBe('regular');
    expect(startLayout(full, viewport(390, 844))).toBe('regular');
    expect(startLayout(edit, undefined)).toBe('regular');
    expect(
      startLayout(edit, () => {
        throw new Error('no matchMedia');
      }),
    ).toBe('regular');
  });
});

describe('nextLayout', () => {
  it('regular -> compact waits while the editor is open, then switches at the next navigation', () => {
    expect(nextLayout('regular', 'compact', 'edit')).toBe('regular');
    expect(nextLayout('regular', 'compact', 'library')).toBe('compact');
    expect(nextLayout('regular', 'compact', 'previews')).toBe('compact');
  });

  it('compact -> regular happens at once, the editor open or not', () => {
    expect(nextLayout('compact', 'regular', 'edit')).toBe('regular');
    expect(nextLayout('compact', 'regular', 'library')).toBe('regular');
    expect(nextLayout('compact', 'compact', 'edit')).toBe('compact');
    expect(nextLayout('regular', 'regular', 'edit')).toBe('regular');
  });
});

describe('isPhone and signInCap (§3.2: the screen, never the viewport)', () => {
  it('an edit-capability device with a screen under 600 on its shorter side is a phone', () => {
    expect(isPhone('edit', { width: 390, height: 844 })).toBe(true);
    expect(isPhone('edit', { width: 844, height: 390 })).toBe(true);
    expect(isPhone('edit', { width: 360, height: 800 })).toBe(true);
    expect(isPhone('edit', { width: 834, height: 1194 })).toBe(false);
    expect(isPhone('edit', { width: 800, height: 1280 })).toBe(false);
    expect(isPhone('edit', { width: 600, height: 960 })).toBe(false);
  });

  it('the full profile is never a phone, nor a screen without a size', () => {
    expect(isPhone('full', { width: 390, height: 844 })).toBe(false);
    expect(isPhone('edit', undefined)).toBe(false);
    expect(isPhone('edit', { width: 0, height: 0 })).toBe(false);
    expect(isPhone('edit', { width: Number.NaN, height: 300 })).toBe(false);
  });

  it('a phone asks for the light cap; every other device asks for none', () => {
    expect(signInCap('edit', { width: 390, height: 844 })).toBe('light');
    expect(signInCap('edit', { width: 834, height: 1194 })).toBeUndefined();
    expect(signInCap('full', { width: 390, height: 844 })).toBeUndefined();
  });
});

describe('applyLayout (the store and html[data-layout])', () => {
  function fakeDocument() {
    const attrs = new Map<string, string>();
    const dataset = new Proxy({} as Record<string, string>, {
      get: (_, k: string) => attrs.get(`data-${k}`),
      set: (_, k: string, v: string) => {
        attrs.set(`data-${k}`, String(v));
        return true;
      },
    });
    const documentElement = {
      dataset,
      hasAttribute: (k: string) => attrs.has(k),
      removeAttribute: (k: string) => void attrs.delete(k),
    };
    return { doc: { documentElement } as unknown as Document, attrs };
  }

  it('sets the attribute on compact and removes it on regular; the store follows', () => {
    const { doc, attrs } = fakeDocument();
    const seen: string[] = [];
    onLayoutChange((l) => seen.push(l));
    expect(currentLayout()).toBe('regular');
    applyLayout('regular', doc);
    expect(attrs.has('data-layout')).toBe(false);
    expect(seen).toEqual([]);
    applyLayout('compact', doc);
    expect(attrs.get('data-layout')).toBe('compact');
    expect(currentLayout()).toBe('compact');
    applyLayout('regular', doc);
    expect(attrs.has('data-layout')).toBe(false);
    expect(currentLayout()).toBe('regular');
    expect(seen).toEqual(['compact', 'regular']);
  });
});

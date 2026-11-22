import { DEFAULT_FONT, SCRIPT_FALLBACK_FONTS } from '@ordo/domain';
import { describe, expect, it } from 'vitest';

import { type FaceLike, type FontFile, FontResolver } from './fonts.ts';
import type { FaceRequest } from './types.ts';

/*
 * The bake font profile (design 29 section 1.2; design/27 section 10 "The bake profile"): a picture is made with
 * the library's and the bundled faces only, so the same slide gives the same picture on every computer. In the
 * bake profile a font string holds the exact library face, the loaded fallbacks, the loaded script fallbacks, the
 * loaded default face and the blank face LAST: never the requested family as the computer might have it and never
 * the legacy chain (Inter, Segoe UI, Arial, sans-serif), through which a character no loaded face covers would be
 * drawn by a face of the computer. The resolver reports what it could not resolve.
 */

const BLANK = '"o-blank-01234567"';

/** A resolver with the faces of bake.pins.test.ts: Acme, Carlito, Inter (the default) and Han's first fallback. */
function loadedResolver(options: ConstructorParameters<typeof FontResolver>[1]): FontResolver {
  const r = new FontResolver(undefined, options);
  r.loaded({ family: 'Acme', internal: 'o11111111' });
  r.loaded({ family: 'Carlito', internal: 'o22222222' });
  r.loaded({ family: DEFAULT_FONT, internal: 'o33333333' });
  r.loaded({ family: SCRIPT_FALLBACK_FONTS.Hani![0]!, internal: 'o44444444' });
  return r;
}
const bake = () => loadedResolver({ profile: 'bake', blank: { family: BLANK } });

const base: FaceRequest = {
  family: 'Acme',
  fallbacks: [],
  weight: 400,
  italic: false,
  smallCaps: false,
  sizePx: 48,
  script: '',
};

describe('the bake profile: font strings', () => {
  it('is the exact face, the loaded fallbacks, the loaded script fallbacks, the loaded default and the blank face last', () => {
    const r = bake();
    expect(r.font({ ...base, fallbacks: ['Carlito'] })).toBe(
      `400 48px "o11111111", "o22222222", "o33333333", ${BLANK}`,
    );
    expect(r.font({ ...base, family: 'Calibri', fallbacks: ['Carlito'] })).toBe(
      `400 48px "o22222222", "o33333333", ${BLANK}`,
    );
    expect(r.font({ ...base, script: 'Hani' })).toBe(
      `400 48px "o11111111", "o44444444", "o33333333", ${BLANK}`,
    );
    expect(r.font({ ...base, family: 'Missing' })).toBe(`400 48px "o33333333", ${BLANK}`);
    expect(r.font({ ...base, weight: 700, italic: true, smallCaps: true, sizePx: 31.5 })).toBe(
      `italic small-caps 700 31.5px "o11111111", "o33333333", ${BLANK}`,
    );
  });

  it('never holds the requested family as the computer has it, nor any entry of the legacy chain', () => {
    const r = bake();
    for (const family of ['Missing', 'Segoe UI', 'Arial', 'sans-serif', 'Helvetica Neue']) {
      const s = r.font({ ...base, family, fallbacks: ['Arial'] });
      expect(s, family).not.toContain(`"${family}"`);
      expect(s).not.toContain('"Segoe UI"');
      expect(s).not.toMatch(/(^|, )Arial(,|$)/);
      expect(s).not.toContain('sans-serif');
      expect(s.endsWith(BLANK)).toBe(true);
    }
  });

  it('with nothing loaded is the blank face alone', () => {
    const r = new FontResolver(undefined, { profile: 'bake', blank: { family: BLANK } });
    expect(r.font(base)).toBe(`400 48px ${BLANK}`);
  });

  it('does not repeat a face a request reaches twice (a fallback that is the default)', () => {
    const r = bake();
    expect(r.font({ ...base, fallbacks: [DEFAULT_FONT, 'Acme'] })).toBe(
      `400 48px "o11111111", "o33333333", ${BLANK}`,
    );
  });

  it('is refused without a blank face: a stack of loaded faces with nothing last would reach a system face', () => {
    expect(() => new FontResolver(undefined, { profile: 'bake' })).toThrow(/blank/i);
    expect(() => new FontResolver(undefined, { profile: 'bake', blank: { family: '' } })).toThrow(/blank/i);
  });
});

describe('the bake profile: what could not be resolved', () => {
  it('an empty stack (no loaded face at all) is listed once per family, lower-cased', () => {
    const r = new FontResolver(undefined, { profile: 'bake', blank: { family: BLANK } });
    r.font({ ...base, family: 'Acme' });
    r.font({ ...base, family: 'ACME', weight: 700 });
    r.font({ ...base, family: 'Other' });
    expect(r.bakeReport().empty).toEqual(['acme', 'other']);
  });

  it('a request served only by the default face is a stand-in; a metric substitute or a script fallback is not', () => {
    const r = bake();
    r.font({ ...base, family: 'Garamond' });
    expect(r.bakeReport().standIns).toEqual(['garamond']);
    r.bakeReset();
    // the exact face, a listed fallback (Carlito for Calibri is the converter's choice), a script fallback, the default itself
    r.font(base);
    r.font({ ...base, family: 'Calibri', fallbacks: ['Carlito'] });
    r.font({ ...base, family: 'Garamond', script: 'Hani' });
    r.font({ ...base, family: DEFAULT_FONT });
    expect(r.bakeReport().standIns).toEqual([]);
  });

  it('the chain is every family a request looked at, lower-cased', () => {
    const r = bake();
    r.font({ ...base, family: 'Garamond', fallbacks: ['Carlito', 'Ghost'], script: 'Hani' });
    expect(r.bakeReport().chain).toEqual(
      [
        'garamond',
        'carlito',
        'ghost',
        ...SCRIPT_FALLBACK_FONTS.Hani!.map((f) => f.toLowerCase()),
        DEFAULT_FONT.toLowerCase(),
      ].sort(),
    );
  });

  it('bakeReset empties the report', () => {
    const r = bake();
    r.font({ ...base, family: 'Garamond' });
    expect(r.bakeReport().chain.length).toBeGreaterThan(0);
    r.bakeReset();
    expect(r.bakeReport()).toEqual({ chain: [], empty: [], standIns: [] });
  });

  it("bakeReset advances the generation of a bake resolver (memoised layouts are laid out again) and not a live one's", () => {
    const b = bake();
    const g = b.generation;
    b.bakeReset();
    expect(b.generation).toBe(g + 1);
    const live = loadedResolver(undefined);
    const gl = live.generation;
    live.bakeReset();
    expect(live.generation).toBe(gl);
  });

  it('a live resolver reports nothing and records nothing', () => {
    const r = loadedResolver(undefined);
    r.font({ ...base, family: 'Garamond' });
    expect(r.bakeReport()).toEqual({ chain: [], empty: [], standIns: [] });
    expect(r.failedFamilies()).toEqual([]);
  });
});

/** A host with a face set, files that can fail and timers the test runs. */
function host(failData: Set<string>) {
  const set = new Set<FaceLike>();
  let now = 1000;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    host: {
      set: { add: (f: FaceLike) => set.add(f), delete: (f: FaceLike) => set.delete(f) },
      async data(f: FontFile) {
        if (failData.has(f.hash)) throw new Error('file unavailable');
        return new TextEncoder().encode(f.hash).buffer as ArrayBuffer;
      },
      face: (_name: string, _data: ArrayBuffer | string, _d: FontFaceDescriptors): FaceLike => ({
        load: () => Promise.resolve(),
      }),
      timer(fn: () => void, ms: number) {
        const t = { at: now + ms, fn, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
      now: () => now,
      retry: { firstMs: 1000, maxMs: 1000 },
    },
    async advance(ms: number) {
      now += ms;
      for (const t of timers.splice(0)) {
        if (t.cancelled) continue;
        if (t.at <= now) t.fn();
        else timers.push(t);
      }
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const file = (family: string, hash: string, weight = 400): FontFile => ({
  family,
  weight,
  style: 'normal',
  hash,
});

describe('the bake profile: faces that failed to load', () => {
  it('failedFamilies lists, lower-cased, a family with a wanted face that is not loaded, and not after a retry loads it', async () => {
    const failing = new Set(['acme-bold']);
    const h = host(failing);
    const r = new FontResolver(h.host, { profile: 'bake', blank: { family: BLANK } });
    await r.sync([
      file('Acme', 'acme-regular'),
      file('Acme', 'acme-bold', 700),
      file('Beta', 'beta-regular'),
    ]);
    expect(r.failedFamilies()).toEqual(['acme']);
    // the family still draws, in the faces that loaded
    expect(r.isLoaded('Acme')).toBe(true);
    failing.clear();
    await h.advance(1500);
    expect(r.failedFamilies()).toEqual([]);
  });

  it('a family none of whose faces loaded is listed too', async () => {
    const h = host(new Set(['x-1']));
    const r = new FontResolver(h.host, { profile: 'bake', blank: { family: BLANK } });
    await r.sync([file('Xylo', 'x-1')]);
    expect(r.isLoaded('Xylo')).toBe(false);
    expect(r.failedFamilies()).toEqual(['xylo']);
  });
});

describe('the profile is a property of the resolver, not of its inputs', () => {
  it('reports its profile, and keeps the live profile the default', () => {
    expect(new FontResolver().profile).toBe('live');
    expect(new FontResolver(undefined, { profile: 'live' }).profile).toBe('live');
    expect(bake().profile).toBe('bake');
  });

  it('generation and metricMatch are the same in both profiles for the same inputs', () => {
    const live = loadedResolver(undefined);
    const b = bake();
    expect(b.generation).toBe(live.generation);
    for (const [family, fallbacks] of [
      ['Calibri', ['Carlito']],
      ['Acme', []],
      ['Garamond', []],
    ] as const) {
      expect(b.metricMatch(family, fallbacks), family).toBe(live.metricMatch(family, fallbacks));
    }
  });

  it('the live profile still builds the strings it always did (bake.pins.test.ts has the literals)', () => {
    const r = loadedResolver({});
    expect(r.font({ ...base, family: 'Missing' })).toBe(
      '400 48px "Missing", "o33333333", "Inter", "Segoe UI", Arial, sans-serif',
    );
  });
});

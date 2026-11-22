import { DEFAULT_LYRIC_STYLE, SCRIPT_FALLBACK_FONTS, type Slide } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { frameKey, type FrameSplit, setFrames, splitFrame, underSlides } from './frame.ts';
import { picture, slideOf, squares, textBox } from './frame.test-util.ts';
import { fontString } from './text2d.ts';
import { FontResolver, installFontEnv, LEGACY_FONT_ENV } from './text/fonts.ts';
import type { FaceRequest } from './text/types.ts';
import { clearUnits, setUnitMedia } from './units.ts';

/*
 * The live path does not move (bake-render, sub-wave 3): the underlay frame's key and split and the live font
 * strings, pinned as literals at the unchanged base, BEFORE the bake's whole-under variant and font profile are
 * added beside them. frame.key.test.ts and fonts.test.ts are relational (changes with / equal to); these literals
 * are what makes "the live frame's key and output do not change" and "the live font stack is byte for byte what
 * it was" provable at the head. A change that moves one of them is a change of what every screen draws: it is
 * never a re-record of this file but a decision (and, for the frame, a UNIT_VERSION bump).
 */

afterEach(() => {
  clearUnits();
  setUnitMedia(undefined);
  setFrames(true);
  installFontEnv(LEGACY_FONT_ENV);
});

/** What a split is, as one string: its key and everything about its shape that a screen draws from. */
function pin(split: FrameSplit): string {
  return JSON.stringify({
    key: frameKey(split, 0),
    under: split.under.length,
    direct: split.direct.objects.length,
    rect: split.rect,
    bytes: split.bytes,
    why: split.why,
    cut: split.cut,
    underSlides: underSlides(split).map((s) => s.objects.length),
  });
}

/** The slide of frame.key.test.ts's `split()`: a crowded slide of 300 objects with a picture and a text box. */
function crowded(): Slide {
  return slideOf(
    [...squares(298), picture('pic', 'photo', { x: 10, y: 10, w: 300, h: 200 }), textBox('t', 'Hi')],
    's',
  );
}

/** 340 objects with 24 distinct pictures: past the object count and the picture count. */
function pictured(): Slide {
  const pics = Array.from({ length: 24 }, (_, i) =>
    picture(`pic${i}`, `photo${i}`, {
      x: 40 + (i % 8) * 220,
      y: 100 + Math.floor(i / 8) * 260,
      w: 200,
      h: 240,
    }),
  );
  const texts = Array.from({ length: 16 }, (_, i) =>
    textBox(`tx${i}`, `Line ${i}`, 60, 40 + i * 60, 600, 50),
  );
  return slideOf([...squares(300), ...pics, ...texts], 'pictured');
}

const FRAME = {
  crowded1:
    '{"key":"f2:1jo6zif1ku6tl18p@1","under":100,"direct":200,"rect":{"x":0,"y":0,"w":1920,"h":1080},"bytes":8294400,"why":{"objects":true,"images":false,"targets":false,"bytes":false,"area":false},"cut":0,"underSlides":[100]}',
  crowded2:
    '{"key":"f2:46w6oqovzshb18p@2","under":100,"direct":200,"rect":{"x":0,"y":0,"w":3840,"h":2160},"bytes":33177600,"why":{"objects":true,"images":false,"targets":false,"bytes":false,"area":false},"cut":0,"underSlides":[100]}',
  pictured2:
    '{"key":"f2:1xbew2ksooxug3sx@2","under":308,"direct":32,"rect":{"x":0,"y":0,"w":3840,"h":2160},"bytes":33177600,"why":{"objects":false,"images":true,"targets":false,"bytes":false,"area":false},"cut":0,"underSlides":[200,108]}',
};

describe('the live frame: key and split pinned at the unchanged base', () => {
  it('a crowded slide at scale 1', () => {
    const f = splitFrame(crowded(), 1);
    expect(f, 'a crowded slide is split').toBeDefined();
    expect(pin(f!)).toBe(FRAME.crowded1);
  });

  it('a crowded slide at scale 2', () => {
    const f = splitFrame(crowded(), 2);
    expect(f).toBeDefined();
    expect(pin(f!)).toBe(FRAME.crowded2);
  });

  it('340 objects with 24 distinct pictures at scale 2', () => {
    const f = splitFrame(pictured(), 2);
    expect(f).toBeDefined();
    expect(pin(f!)).toBe(FRAME.pictured2);
  });
});

/** The loaded faces of the font pins: three library families and the script fallback of Han. */
function resolver(): FontResolver {
  const r = new FontResolver();
  r.loaded({ family: 'Acme', internal: 'o11111111' });
  r.loaded({ family: 'Carlito', internal: 'o22222222' });
  r.loaded({ family: 'Inter', internal: 'o33333333' });
  r.loaded({ family: SCRIPT_FALLBACK_FONTS.Hani![0]!, internal: 'o44444444' });
  return r;
}

const base: FaceRequest = {
  family: 'Acme',
  fallbacks: [],
  weight: 400,
  italic: false,
  smallCaps: false,
  sizePx: 48,
  script: '',
};

/** Six requests: the exact face, only a fallback, a script fallback, the raw family, nothing loaded, bold italic caps. */
const REQUESTS: Record<string, { req: FaceRequest; empty?: true }> = {
  exact: { req: { ...base, fallbacks: ['Carlito'] } },
  fallbackOnly: { req: { ...base, family: 'Calibri', fallbacks: ['Carlito'] } },
  script: { req: { ...base, script: 'Hani' } },
  raw: { req: { ...base, family: 'Missing' } },
  nothing: { req: base, empty: true },
  boldItalicCaps: { req: { ...base, weight: 700, italic: true, smallCaps: true, sizePx: 31.5 } },
};

const FONTS: Record<string, string> = {
  exact: '400 48px "o11111111", "o22222222", "o33333333", "Inter", "Segoe UI", Arial, sans-serif',
  fallbackOnly: '400 48px "o22222222", "Calibri", "o33333333", "Inter", "Segoe UI", Arial, sans-serif',
  script: '400 48px "o11111111", "o44444444", "o33333333", "Inter", "Segoe UI", Arial, sans-serif',
  raw: '400 48px "Missing", "o33333333", "Inter", "Segoe UI", Arial, sans-serif',
  nothing: '400 48px "Acme", "Inter", "Segoe UI", Arial, sans-serif',
  boldItalicCaps:
    'italic small-caps 700 31.5px "o11111111", "o33333333", "Inter", "Segoe UI", Arial, sans-serif',
};

describe('the live font resolver: font strings pinned at the unchanged base', () => {
  for (const [name, { req, empty }] of Object.entries(REQUESTS))
    it(`${name}`, () => {
      const r = empty ? new FontResolver() : resolver();
      expect(r.font(req)).toBe(FONTS[name]);
    });

  it('the raw requested family and the legacy tail are in the string of a family that is not loaded', () => {
    const s = resolver().font(REQUESTS.raw!.req);
    expect(s).toContain('"Missing"');
    expect(s).toContain('"Segoe UI"');
    expect(s).toContain('sans-serif');
  });
});

const LEGACY = {
  env: '400 48px "Acme", "Carlito", "Arial", "Inter", "Segoe UI", Arial, sans-serif',
  fontString: '700 168px "Inter", "Inter", "Segoe UI", Arial, sans-serif',
  fontStringItalic: 'italic 700 84px "Acme", "Inter", "Segoe UI", Arial, sans-serif',
};

describe('the legacy font environment: byte for byte what drawers built before the resolver', () => {
  it('LEGACY_FONT_ENV.font', () => {
    expect(LEGACY_FONT_ENV.font({ ...base, family: 'Acme', fallbacks: ['Carlito', 'Arial'] })).toBe(
      LEGACY.env,
    );
  });

  it('fontString with no resolver installed', () => {
    installFontEnv(LEGACY_FONT_ENV);
    expect(fontString(DEFAULT_LYRIC_STYLE, 2)).toBe(LEGACY.fontString);
    expect(
      fontString({ ...DEFAULT_LYRIC_STYLE, fontStyle: 'italic', fontWeight: 700, fontFamily: 'Acme' }, 1),
    ).toBe(LEGACY.fontStringItalic);
  });
});

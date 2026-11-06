import { describe, expect, it } from 'vitest';

import { DEFAULT_GENERAL, DEFAULT_LOOKS, DEFAULT_LYRIC_STYLE, LOOK_LOWER_THIRD } from './defaults.ts';
import { type GoLiveInputs, localDigest, resolvePlaylist } from './goLive.ts';
import { referencedFontFamilies } from './resolve.ts';
import { richSlide } from './rich.test-util.ts';
import type { Font, Look, Presentation } from './schemas.ts';

const presentation = (): Presentation =>
  ({
    id: 'p1',
    rev: 1,
    kind: 'presentation',
    title: 'Sermon',
    sections: [{ id: 'sec', name: 'Main', slides: [richSlide()] }],
    arrangements: [],
  }) as unknown as Presentation;

const font = (family: string, hash: string): Font => ({
  id: `f-${hash}`,
  family,
  weight: 400,
  style: 'normal',
  file: { hash: hash.repeat(64).slice(0, 64), bytes: 10, mime: 'font/ttf', path: `fonts/${hash}.ttf` },
  source: 'upload',
});

describe('referencedFontFamilies', () => {
  it('lists the box, run, bullet and fallback fonts of text objects and the looks’ styles', () => {
    const p = presentation();
    const body = p.sections[0]!.slides[0]!.objects.find((o) => o.type === 'text')!;
    if (body.type !== 'text') throw new Error('no text');
    body.paras![0] = { ...body.paras![0]!, bullet: { char: '•', fontFamily: 'Symbol Sub' } };
    const look: Look = structuredClone(LOOK_LOWER_THIRD);
    if (look.layers.slide.mode === 'lyricOnly')
      look.layers.slide.style = { ...look.layers.slide.style, fallbackFonts: ['Band Fallback'] };
    look.layers.props.style.clock = {
      ...DEFAULT_LYRIC_STYLE,
      fontFamily: 'Clock Face',
      fallbackFonts: ['Clock Fallback'],
      box: { x: 0, y: 0, w: 100, h: 50, rotation: 0 },
    };
    const fams = referencedFontFamilies([p], [look]);
    for (const f of [
      'Calibri',
      'Carlito',
      'Noto Sans Hebrew',
      'Symbol Sub',
      'Band Fallback',
      'Clock Face',
      'Clock Fallback',
      DEFAULT_LYRIC_STYLE.fontFamily,
    ])
      expect(fams).toContain(f);
  });
});

describe('resolvePlaylist fonts', () => {
  it('ships run and fallback faces, matching family names case-insensitively', () => {
    const p = presentation();
    const slide = p.sections[0]!.slides[0]!;
    slide.objects = slide.objects.filter((o) => o.type !== 'image');
    const inputs: GoLiveInputs = {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'Sunday',
        items: [{ id: 'i', kind: 'presentation', presentationId: 'p1' }],
      },
      presentation: (id: string) => (id === 'p1' ? p : undefined),
      media: () => undefined,
      fonts: () => [
        font('calibri', 'a'),
        font('Carlito', 'b'),
        font('Noto Sans Hebrew', 'c'),
        font('Unused', 'd'),
      ],
      looks: DEFAULT_LOOKS,
      general: DEFAULT_GENERAL,
    } as unknown as GoLiveInputs;
    const r = resolvePlaylist(inputs, 'pl', { digest: localDigest });
    expect(r.fonts.map((f) => f.family).sort()).toEqual(['Carlito', 'Noto Sans Hebrew', 'calibri']);
    expect(r.files.map((f) => f.mime)).toEqual(['font/ttf', 'font/ttf', 'font/ttf']);
  });
});

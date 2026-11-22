import type { Slide, SlideObject } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { putBackRaster } from './pptx-raster.ts';

/**
 * `putBackRaster` (Q53, C-SR6): a picture of shapes the job could not make gives its shapes back, in z order and with the
 * origin the picture had where theirs is absent, and takes nothing else from the slide.
 */
const box = { x: 0, y: 0, w: 100, h: 50, rotation: 0 };
const shape = (id: string, origin?: SlideObject['origin']): SlideObject =>
  ({
    id,
    type: 'shape',
    box,
    shape: 'rect',
    opacity: 1,
    radius: 0,
    ...(origin ? { origin } : {}),
  }) as SlideObject;
const picture: SlideObject = {
  id: 'pic',
  type: 'image',
  box,
  mediaId: 'pptxmedia:raster0123456789abcdef',
  fit: 'stretch',
  opacity: 1,
  radius: 0,
  locked: true,
  origin: {
    src: 'pptx',
    role: 'raster',
    shapeId: 9,
    group: 4,
    raster: { cv: 3, rv: 1, pts: 128, h: '0123456789abcdef', n: 2, from: 'slide' },
  },
} as SlideObject;

describe('putBackRaster', () => {
  const slide = { id: 's', objects: [shape('below'), picture, shape('above')] } as Slide;

  it('puts the members back where the picture was, below and above unchanged', () => {
    const out = putBackRaster(slide, {
      uses: ['pic'],
      objects: [shape('m1', { src: 'pptx', role: 'shape', shapeId: 9 }), shape('m2')],
    });
    expect(out.objects.map((o) => o.id)).toEqual(['below', 'm1', 'm2', 'above']);
    // a member without an origin gets the picture's, never its raster field
    expect(out.objects[2]!.origin).toEqual({ src: 'pptx', role: 'raster', shapeId: 9, group: 4 });
    expect(out.objects[1]!.origin).toEqual({ src: 'pptx', role: 'shape', shapeId: 9 });
    expect(JSON.stringify(out)).not.toContain('"raster":{');
    expect(slide.objects).toHaveLength(3);
  });

  it('leaves a slide that holds no such picture as it is (an edit deleted it)', () => {
    const none = { id: 's', objects: [shape('a')] } as Slide;
    expect(putBackRaster(none, { uses: ['pic'], objects: [shape('m1')] })).toBe(none);
  });
});

// ── through the import core's assemble (H8, G16) ────────────────────────────────────────────────────────────────

import type { SlideClass, SlideRef } from '@ordo/pptx-scene';
import { ImportCore, type Draft } from './pptx-core.ts';
import { ImportLog } from './pptx-report.ts';

const FILE = 'c'.repeat(64);
const PH = 'pptxmedia:raster0123456789abcdef';
const KEY = '\u0000raster:' + '0123456789abcdef'.repeat(4);
const oid = (i: number) => `P${i.toString(36).toUpperCase().padStart(25, '0')}`;

function assembled(stored: ReadonlyMap<string, string>) {
  const pic = { ...picture, mediaId: PH } as SlideObject;
  const back = {
    id: PH,
    members: [9, 10],
    uses: ['pic'],
    objects: [shape('m1', { src: 'pptx', role: 'shape', shapeId: 9 }), shape('m2')],
    words: 'Praise the Lord',
  };
  const slide = { id: oid(1), objects: [shape('below'), pic] } as Slide;
  const ref: SlideRef = { index: 3, part: 'ppt/slides/slide4.xml', hidden: false };
  const d: Draft = {
    ref,
    slide,
    media: new Map([[PH, KEY]]),
    cls: 'native' as SlideClass,
    notes: [],
    rasters: [back as never],
  };
  const core = new ImportCore({ lo: false, log: new ImportLog(), warn: () => {}, geomFileBytes: 1 << 20 });
  const out = core.assemble([d], stored, {
    id: oid(2),
    title: 'Deck',
    hash: FILE,
    sections: [],
    slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
    scan: { loop: false },
    hasAlpha: () => false,
    clipIds: new Set(),
    libraryFamilies: [],
  });
  return out.p.sections.flatMap((s) => s.slides)[0]!;
}

describe('ImportCore.assemble with a picture of shapes (H8)', () => {
  it('a stored one is mapped to its media id, gets file and slide, and its words join the slide text', () => {
    const s = assembled(new Map([[KEY, 'media-1']]));
    const img = s.objects.find((o) => o.type === 'image')!;
    expect((img as { mediaId: string }).mediaId).toBe('media-1');
    expect(img.origin?.raster).toMatchObject({ file: FILE, slide: 3, h: '0123456789abcdef' });
    expect(JSON.stringify(s)).not.toContain('pptxmedia:');
    expect(s.pptx?.artText).toBe('Praise the Lord');
  });

  it('one that was not stored is put back first: its shapes are in the slide, no image object with an unmapped id', () => {
    const s = assembled(new Map());
    expect(s.objects.map((o) => o.id)).toEqual(['below', 'm1', 'm2']);
    expect(JSON.stringify(s)).not.toContain('pptxmedia:');
    expect(s.pptx?.artText).toBeUndefined();
  });
});

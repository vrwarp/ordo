import { importPro7, type Pro7ImportOptions } from '@ordo/importers';
import { decodeAs } from '@ordo/importers/proto.ts';
import { describe, expect, it } from 'vitest';
import { buildSyntheticCorpus } from './corpus.ts';

describe('corpus', () => {
  it('buildSyntheticCorpus creates pro7-synth-core with 4 slides', () => {
    const corpus = buildSyntheticCorpus();
    expect(corpus).toHaveLength(3);
    const deck = corpus[0]!;
    expect(deck.name).toBe('pro7-synth-core');
    expect(deck.proFileName).toBe('pro7-synth-core.pro');
    expect(deck.referenceSlides).toHaveLength(4);

    // Verify reference rasters
    const ref1 = deck.referenceSlides[0]!;
    expect(ref1.width).toBe(1920);
    expect(ref1.height).toBe(1080);
    // Background pixel
    const p1Idx = (100 * 1920 + 100) * 4;
    expect(Array.from(ref1.data.subarray(p1Idx, p1Idx + 4))).toEqual([20, 40, 80, 255]);

    const ref2 = deck.referenceSlides[1]!;
    // Black background pixel
    const p2BgIdx = (100 * 1920 + 100) * 4;
    expect(Array.from(ref2.data.subarray(p2BgIdx, p2BgIdx + 4))).toEqual([0, 0, 0, 255]);
    // Coral rect pixel (500, 300)
    const p2CoralIdx = (300 * 1920 + 500) * 4;
    expect(Array.from(ref2.data.subarray(p2CoralIdx, p2CoralIdx + 4))).toEqual([255, 127, 80, 255]);

    const ref3 = deck.referenceSlides[2]!;
    // Transparent pixel (100, 100)
    const p3TransIdx = (100 * 1920 + 100) * 4;
    expect(Array.from(ref3.data.subarray(p3TransIdx, p3TransIdx + 4))).toEqual([0, 0, 0, 0]);
    // Teal bar pixel (200, 850)
    const p3TealIdx = (850 * 1920 + 200) * 4;
    expect(Array.from(ref3.data.subarray(p3TealIdx, p3TealIdx + 4))).toEqual([0, 128, 128, 255]);

    const ref4 = deck.referenceSlides[3]!;
    expect(ref4.width).toBe(1920);
    expect(ref4.height).toBe(1080);
    // Leftmost pixel (0, 540)
    const p4LeftIdx = (540 * 1920 + 0) * 4;
    expect(Array.from(ref4.data.subarray(p4LeftIdx, p4LeftIdx + 4))).toEqual([220, 40, 40, 255]);
    // Rightmost pixel (1919, 540)
    const p4RightIdx = (540 * 1920 + 1919) * 4;
    expect(Array.from(ref4.data.subarray(p4RightIdx, p4RightIdx + 4))).toEqual([40, 80, 220, 255]);
  });

  it('imports pro7-synth-core cleanly into 4 slides with expected boxes and fills', () => {
    const corpus = buildSyntheticCorpus();
    const deck = corpus[0]!;

    const res = importPro7(deck.files, { exportCompat: true } as unknown as Pro7ImportOptions);
    expect(res.presentations).toHaveLength(1);
    const pres = res.presentations[0]!;
    expect(pres.title).toBe('pro7-synth-core');

    const slides = pres.sections.flatMap((s) => s.slides);
    expect(slides).toHaveLength(4);

    // Slide 1: Opaque drawsBackgroundColor slide (rgba(20, 40, 80, 1))
    const s1 = slides[0]!;
    expect(s1.objects).toHaveLength(1);
    const obj1 = s1.objects[0]!;
    expect(obj1.type).toBe('shape');
    if (obj1.type === 'shape') {
      expect(obj1.shape).toBe('rect');
      expect(obj1.box).toEqual({ x: 0, y: 0, w: 1920, h: 1080, rotation: 0 });
      expect(obj1.fill).toEqual({ r: 20, g: 40, b: 80, a: 1 });
    }

    // Slide 2: Opaque black background slide with solid coral rectangle element
    const s2 = slides[1]!;
    expect(s2.objects).toHaveLength(2);
    // Background rect
    const obj2Bg = s2.objects[0]!;
    expect(obj2Bg.type).toBe('shape');
    if (obj2Bg.type === 'shape') {
      expect(obj2Bg.shape).toBe('rect');
      expect(obj2Bg.box).toEqual({ x: 0, y: 0, w: 1920, h: 1080, rotation: 0 });
      expect(obj2Bg.fill).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    }
    // Coral rect
    const obj2Coral = s2.objects[1]!;
    expect(obj2Coral.type).toBe('shape');
    if (obj2Coral.type === 'shape') {
      expect(obj2Coral.shape).toBe('rect');
      expect(obj2Coral.box).toEqual({ x: 480, y: 270, w: 960, h: 540, rotation: 0 });
      expect(obj2Coral.fill).toEqual({ r: 255, g: 127, b: 80, a: 1 });
    }

    // Slide 3: Transparent slide (drawsBackgroundColor: false) with opaque teal lower-third rectangle bar
    const s3 = slides[2]!;
    expect(s3.objects).toHaveLength(1);
    const obj3Teal = s3.objects[0]!;
    expect(obj3Teal.type).toBe('shape');
    if (obj3Teal.type === 'shape') {
      expect(obj3Teal.shape).toBe('rect');
      expect(obj3Teal.box).toEqual({ x: 160, y: 820, w: 1600, h: 160, rotation: 0 });
      expect(obj3Teal.fill).toEqual({ r: 0, g: 128, b: 128, a: 1 });
    }

    // Slide 4: Horizontal linear gradient rectangle (empty-RTF routed to shape)
    const s4 = slides[3]!;
    expect(s4.objects).toHaveLength(1);
    const obj4Grad = s4.objects[0]!;
    expect(obj4Grad.type).toBe('shape');
    if (obj4Grad.type === 'shape') {
      expect(obj4Grad.shape).toBe('rect');
      expect(obj4Grad.box).toEqual({ x: 0, y: 0, w: 1920, h: 1080, rotation: 0 });
      expect(obj4Grad.fill).toEqual({ r: 220, g: 40, b: 40, a: 1 });
      expect(obj4Grad.gradient).toEqual({
        kind: 'linear',
        angle: 0,
        stops: [
          { at: 0, color: { r: 220, g: 40, b: 40, a: 1 } },
          { at: 1, color: { r: 40, g: 80, b: 220, a: 1 } },
        ],
      });
    }
  });

  it('buildSyntheticCorpus creates pro7-synth-shapes with 3 slides and valid rasters', () => {
    const corpus = buildSyntheticCorpus();
    expect(corpus).toHaveLength(3);
    const deck = corpus[1]!;
    expect(deck.name).toBe('pro7-synth-shapes');
    expect(deck.proFileName).toBe('pro7-synth-shapes.pro');
    expect(deck.referenceSlides).toHaveLength(3);

    // Slide 1: Yellow Ellipse
    const ref1 = deck.referenceSlides[0]!;
    expect(ref1.width).toBe(1920);
    expect(ref1.height).toBe(1080);
    // Dark background pixel (100, 100)
    const p1BgIdx = (100 * 1920 + 100) * 4;
    expect(Array.from(ref1.data.subarray(p1BgIdx, p1BgIdx + 4))).toEqual([15, 20, 30, 255]);
    // Center of ellipse (960, 540)
    const p1CenterIdx = (540 * 1920 + 960) * 4;
    expect(Array.from(ref1.data.subarray(p1CenterIdx, p1CenterIdx + 4))).toEqual([240, 180, 40, 255]);

    // Slide 2: Green Rounded Rectangle
    const ref2 = deck.referenceSlides[1]!;
    expect(ref2.width).toBe(1920);
    expect(ref2.height).toBe(1080);
    // Dark background pixel (100, 100)
    const p2BgIdx = (100 * 1920 + 100) * 4;
    expect(Array.from(ref2.data.subarray(p2BgIdx, p2BgIdx + 4))).toEqual([15, 20, 30, 255]);
    // Center of rounded rectangle (960, 540)
    const p2CenterIdx = (540 * 1920 + 960) * 4;
    expect(Array.from(ref2.data.subarray(p2CenterIdx, p2CenterIdx + 4))).toEqual([60, 190, 130, 255]);

    // Slide 3: Purple Custom Diamond
    const ref3 = deck.referenceSlides[2]!;
    expect(ref3.width).toBe(1920);
    expect(ref3.height).toBe(1080);
    // Dark background pixel (100, 100)
    const p3BgIdx = (100 * 1920 + 100) * 4;
    expect(Array.from(ref3.data.subarray(p3BgIdx, p3BgIdx + 4))).toEqual([15, 20, 30, 255]);
    // Center of diamond (960, 540)
    const p3CenterIdx = (540 * 1920 + 960) * 4;
    expect(Array.from(ref3.data.subarray(p3CenterIdx, p3CenterIdx + 4))).toEqual([180, 90, 230, 255]);
  });

  it('decodes pro7-synth-shapes protobuf presentation and cues cleanly', () => {
    const corpus = buildSyntheticCorpus();
    const deck = corpus[1]!;
    const proBytes = deck.files.get(deck.proFileName)!;
    expect(proBytes).toBeDefined();

    const doc = decodeAs('rv.data.Presentation', proBytes);
    expect(doc.name).toBe('pro7-synth-shapes');
    expect(doc.cues).toHaveLength(3);

    const cues = doc.cues as Record<string, unknown>[];
    expect(cues[0]!.name).toBe('Slide 1 - Yellow Ellipse');
    expect(cues[1]!.name).toBe('Slide 2 - Green Rounded Rectangle');
    expect(cues[2]!.name).toBe('Slide 3 - Purple Diamond');
  });

  it('buildSyntheticCorpus creates pro7-synth-masks-and-crops with 3 slides and valid rasters', () => {
    const corpus = buildSyntheticCorpus();
    expect(corpus).toHaveLength(3);
    const deck = corpus[2]!;
    expect(deck.name).toBe('pro7-synth-masks-and-crops');
    expect(deck.proFileName).toBe('pro7-synth-masks-and-crops.pro');
    expect(deck.referenceSlides).toHaveLength(3);
    expect(deck.files.has('Media/quadrants.png')).toBe(true);
    expect(deck.files.has('Media/cyan.png')).toBe(true);

    // Slide 1: Diagonal 315° Linear Gradient (maps to 45° in Ordo)
    const ref1 = deck.referenceSlides[0]!;
    expect(ref1.width).toBe(1920);
    expect(ref1.height).toBe(1080);
    // Top-left pixel (0, 0): t = 1/3000 -> close to start stop [30, 180, 140, 255]
    const p1TlIdx = (0 * 1920 + 0) * 4;
    expect(Array.from(ref1.data.subarray(p1TlIdx, p1TlIdx + 4))).toEqual([30, 180, 140, 255]);
    // Bottom-right pixel (1919, 1079): t = 2999/3000 -> close to end stop [220, 120, 40, 255]
    const p1BrIdx = (1079 * 1920 + 1919) * 4;
    expect(Array.from(ref1.data.subarray(p1BrIdx, p1BrIdx + 4))).toEqual([220, 120, 40, 255]);

    // Slide 2: Cropped Quadrants
    const ref2 = deck.referenceSlides[1]!;
    expect(ref2.width).toBe(1920);
    expect(ref2.height).toBe(1080);
    // Black background pixel (100, 100)
    const p2BgIdx = (100 * 1920 + 100) * 4;
    expect(Array.from(ref2.data.subarray(p2BgIdx, p2BgIdx + 4))).toEqual([0, 0, 0, 255]);
    // Inside red quadrant crop box (500, 300)
    const p2RedIdx = (300 * 1920 + 500) * 4;
    expect(Array.from(ref2.data.subarray(p2RedIdx, p2RedIdx + 4))).toEqual([220, 50, 50, 255]);

    // Slide 3: Ellipse Masked Cyan
    const ref3 = deck.referenceSlides[2]!;
    expect(ref3.width).toBe(1920);
    expect(ref3.height).toBe(1080);
    // Dark background pixel (100, 100)
    const p3BgIdx = (100 * 1920 + 100) * 4;
    expect(Array.from(ref3.data.subarray(p3BgIdx, p3BgIdx + 4))).toEqual([15, 20, 30, 255]);
    // Center of cyan ellipse (960, 540)
    const p3CenterIdx = (540 * 1920 + 960) * 4;
    expect(Array.from(ref3.data.subarray(p3CenterIdx, p3CenterIdx + 4))).toEqual([40, 210, 220, 255]);
  });

  it('imports pro7-synth-masks-and-crops cleanly into 3 slides with expected boxes, fills, and masks', () => {
    const corpus = buildSyntheticCorpus();
    const deck = corpus[2]!;

    const res = importPro7(deck.files, { exportCompat: true } as unknown as Pro7ImportOptions);
    expect(res.presentations).toHaveLength(1);
    const pres = res.presentations[0]!;
    expect(pres.title).toBe('pro7-synth-masks-and-crops');

    const slides = pres.sections.flatMap((s) => s.slides);
    expect(slides).toHaveLength(3);

    // Slide 1: Diagonal Linear Gradient 45°
    const s1 = slides[0]!;
    expect(s1.objects).toHaveLength(1);
    const obj1 = s1.objects[0]!;
    expect(obj1.type).toBe('shape');
    if (obj1.type === 'shape') {
      expect(obj1.shape).toBe('rect');
      expect(obj1.box).toEqual({ x: 0, y: 0, w: 1920, h: 1080, rotation: 0 });
      expect(obj1.gradient).toEqual({
        kind: 'linear',
        angle: 45,
        stops: [
          { at: 0, color: { r: 30, g: 180, b: 140, a: 1 } },
          { at: 1, color: { r: 220, g: 120, b: 40, a: 1 } },
        ],
      });
    }

    // Slide 2: Cropped media element on black background
    const s2 = slides[1]!;
    expect(s2.objects).toHaveLength(2);
    const obj2Bg = s2.objects[0]!;
    expect(obj2Bg.type).toBe('shape');
    if (obj2Bg.type === 'shape') {
      expect(obj2Bg.fill).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    }
    const obj2Media = s2.objects[1]!;
    expect(obj2Media.type).toBe('image');
    if (obj2Media.type === 'image') {
      expect(obj2Media.box).toEqual({ x: 480, y: 270, w: 960, h: 540, rotation: 0 });
      expect(obj2Media.mediaId).toBe('pro7media:Media/quadrants.png');
      expect(obj2Media.fit).toBe('stretch');
      expect(obj2Media.crop).toEqual({ l: 0, t: 0, r: 0.5, b: 0.5 });
    }

    // Slide 3: Ellipse masked cyan media element on dark navy background
    const s3 = slides[2]!;
    expect(s3.objects).toHaveLength(2);
    const obj3Bg = s3.objects[0]!;
    expect(obj3Bg.type).toBe('shape');
    if (obj3Bg.type === 'shape') {
      expect(obj3Bg.fill).toEqual({ r: 15, g: 20, b: 30, a: 1 });
    }
    const obj3Media = s3.objects[1]!;
    expect(obj3Media.type).toBe('image');
    if (obj3Media.type === 'image') {
      expect(obj3Media.box).toEqual({ x: 660, y: 240, w: 600, h: 600, rotation: 0 });
      expect(obj3Media.mediaId).toBe('pro7media:Media/cyan.png');
      expect(obj3Media.mask).toEqual({ preset: 'ellipse' });
    }
  });

  it('decodes pro7-synth-masks-and-crops protobuf presentation and cues cleanly', () => {
    const corpus = buildSyntheticCorpus();
    const deck = corpus[2]!;
    const proBytes = deck.files.get(deck.proFileName)!;
    expect(proBytes).toBeDefined();

    const doc = decodeAs('rv.data.Presentation', proBytes);
    expect(doc.name).toBe('pro7-synth-masks-and-crops');
    expect(doc.cues).toHaveLength(3);

    const cues = doc.cues as Record<string, unknown>[];
    expect(cues[0]!.name).toBe('Slide 1 - Diagonal 315° Linear Gradient');
    expect(cues[1]!.name).toBe('Slide 2 - Cropped Quadrants');
    expect(cues[2]!.name).toBe('Slide 3 - Ellipse Masked Cyan');
  });
});

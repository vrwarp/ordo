import { describe, expect, it } from 'vitest';
import {
  buildSyntheticCorpus,
  encodePro7Presentation,
  makeCueWithElements,
  makeRectElement,
  makeRtfBytes,
} from './corpus.ts';
import { extractDeckSlideSources, sanitizeForJson } from './features.ts';

describe('features', () => {
  it('extracts slide sources from synthetic core deck', () => {
    const corpus = buildSyntheticCorpus();
    const deck = corpus[0]!;
    const proBytes = deck.files.get(deck.proFileName)!;

    const sources = extractDeckSlideSources(proBytes, { exportCompat: true });
    expect(sources).toHaveLength(4);

    // Slide 1 has drawsBgColor
    expect(sources[0]!.slideNumber).toBe(1);
    expect(sources[0]!.cueName).toBe('Slide 1 - Opaque Blue BG');
    expect(sources[0]!.features).toContain('drawsBgColor');
    expect(sources[0]!.features).not.toContain('transparentPlate');

    // Slide 2 has drawsBgColor
    expect(sources[1]!.slideNumber).toBe(2);
    expect(sources[1]!.features).toContain('drawsBgColor');
    expect(sources[1]!.features).not.toContain('transparentPlate');

    // Slide 3 has transparentPlate
    expect(sources[2]!.slideNumber).toBe(3);
    expect(sources[2]!.features).toContain('transparentPlate');
    expect(sources[2]!.features).not.toContain('drawsBgColor');

    // Slide 4 has gradientFill and emptyRtfShape
    expect(sources[3]!.slideNumber).toBe(4);
    expect(sources[3]!.features).toContain('gradientFill');
    expect(sources[3]!.features).toContain('emptyRtfShape');
  });

  it('extracts slide sources from synthetic shapes deck', () => {
    const corpus = buildSyntheticCorpus();
    const shapesDeck = corpus[1]!;
    const proBytes = shapesDeck.files.get(shapesDeck.proFileName)!;

    const sources = extractDeckSlideSources(proBytes, { exportCompat: true });
    expect(sources).toHaveLength(3);

    // Slide 1: Yellow Ellipse
    expect(sources[0]!.slideNumber).toBe(1);
    expect(sources[0]!.cueName).toBe('Slide 1 - Yellow Ellipse');
    expect(sources[0]!.features).toContain('drawsBgColor');
    expect(sources[0]!.features).toContain('nonRectShape');
    expect(sources[0]!.features).not.toContain('customPath');

    // Slide 2: Green Rounded Rectangle
    expect(sources[1]!.slideNumber).toBe(2);
    expect(sources[1]!.cueName).toBe('Slide 2 - Green Rounded Rectangle');
    expect(sources[1]!.features).toContain('drawsBgColor');
    expect(sources[1]!.features).toContain('nonRectShape');
    expect(sources[1]!.features).not.toContain('customPath');

    // Slide 3: Purple Diamond
    expect(sources[2]!.slideNumber).toBe(3);
    expect(sources[2]!.cueName).toBe('Slide 3 - Purple Diamond');
    expect(sources[2]!.features).toContain('drawsBgColor');
    expect(sources[2]!.features).toContain('nonRectShape');
    expect(sources[2]!.features).toContain('customPath');
  });

  it('extracts slide sources from synthetic masks and crops deck', () => {
    const corpus = buildSyntheticCorpus();
    expect(corpus).toHaveLength(5);
    const masksDeck = corpus[2]!;
    const proBytes = masksDeck.files.get(masksDeck.proFileName)!;

    const sources = extractDeckSlideSources(proBytes, { exportCompat: true });
    expect(sources).toHaveLength(3);

    // Slide 1: Diagonal 315° Linear Gradient
    expect(sources[0]!.slideNumber).toBe(1);
    expect(sources[0]!.cueName).toBe('Slide 1 - Diagonal 315° Linear Gradient');
    expect(sources[0]!.features).toContain('transparentPlate');
    expect(sources[0]!.features).toContain('gradientFill');
    expect(sources[0]!.features).toContain('emptyRtfShape');
    expect(sources[0]!.features).not.toContain('drawsBgColor');

    // Slide 2: Cropped Quadrants
    expect(sources[1]!.slideNumber).toBe(2);
    expect(sources[1]!.cueName).toBe('Slide 2 - Cropped Quadrants');
    expect(sources[1]!.features).toContain('drawsBgColor');
    expect(sources[1]!.features).toContain('mediaFill');
    expect(sources[1]!.features).toContain('mediaCrop');
    expect(sources[1]!.features).not.toContain('transparentPlate');

    // Slide 3: Ellipse Masked Cyan
    expect(sources[2]!.slideNumber).toBe(3);
    expect(sources[2]!.cueName).toBe('Slide 3 - Ellipse Masked Cyan');
    expect(sources[2]!.features).toContain('drawsBgColor');
    expect(sources[2]!.features).toContain('mediaFill');
    expect(sources[2]!.features).toContain('nonRectShape');
    expect(sources[2]!.features).not.toContain('mediaCrop');
  });

  it('detects untitledDoc and docBackground', () => {
    const cue = makeCueWithElements({
      drawsBackgroundColor: false,
      elements: [makeRectElement({ x: 0, y: 0, w: 100, h: 100 })],
    });
    const bytes = encodePro7Presentation({
      uuid: { string: 'TEST-1' },
      name: 'Untitled',
      background: {
        isEnabled: true,
        color: { red: 1, green: 0, blue: 0, alpha: 1 },
      },
      cues: [cue],
    });

    const sources = extractDeckSlideSources(bytes);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.features).toContain('untitledDoc');
    expect(sources[0]!.features).toContain('docBackground');
  });

  it('detects shape, stroke, shadow, feather, and gradient tags', () => {
    const element = {
      bounds: { origin: { x: 10, y: 10 }, size: { width: 200, height: 100 } },
      path: {
        shape: { type: 'TYPE_ELLIPSE' },
      },
      fill: {
        enable: true,
        gradient: {
          type: 'TYPE_LINEAR',
          stops: [{ color: { red: 1, green: 0, blue: 0, alpha: 1 }, position: 0 }],
        },
      },
      stroke: {
        enable: true,
        width: 4,
        color: { red: 0, green: 1, blue: 0, alpha: 1 },
      },
      shadow: {
        enable: true,
        offset: 5,
      },
      feather: {
        enable: true,
        radius: 10,
      },
      textLineMask: {
        enabled: true,
      },
    };

    const cue = makeCueWithElements({
      elements: [{ element }],
    });
    const bytes = encodePro7Presentation({
      uuid: { string: 'TEST-SHAPES' },
      name: 'Shapes Deck',
      cues: [cue],
    });

    const sources = extractDeckSlideSources(bytes);
    expect(sources).toHaveLength(1);
    const f = sources[0]!.features;
    expect(f).toContain('nonRectShape');
    expect(f).toContain('gradientFill');
    expect(f).toContain('strokeBorder');
    expect(f).toContain('elShadow');
    expect(f).toContain('elFeather');
    expect(f).toContain('textLineMask');
  });

  it('detects mediaFill, mediaCrop, customImageBounds, and videoBg', () => {
    const cue = {
      uuid: { string: 'CUE-MEDIA' },
      isEnabled: true,
      actions: [
        {
          type: 'ACTION_TYPE_MEDIA',
          isEnabled: true,
          media: {
            video: {
              playbackBehavior: 'PLAYBACK_BEHAVIOR_LOOP',
            },
            element: {
              url: { absoluteString: 'file:///assets/video.mp4' },
            },
          },
        },
        {
          type: 'ACTION_TYPE_PRESENTATION_SLIDE',
          isEnabled: true,
          slide: {
            presentation: {
              baseSlide: {
                size: { width: 1920, height: 1080 },
                elements: [
                  {
                    element: {
                      bounds: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
                      fill: {
                        enable: true,
                        media: {
                          image: {
                            drawing: {
                              cropEnable: true,
                              cropInsets: { left: 10, right: 10, top: 0, bottom: 0 },
                              customImageBounds: {
                                origin: { x: 0, y: 0 },
                                size: { width: 100, height: 100 },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    const bytes = encodePro7Presentation({
      uuid: { string: 'TEST-MEDIA' },
      name: 'Media Deck',
      cues: [cue],
    });

    const sources = extractDeckSlideSources(bytes, { exportCompat: true });
    expect(sources).toHaveLength(1);
    const f = sources[0]!.features;
    expect(f).toContain('videoBg');
    expect(f).toContain('mediaFill');
    expect(f).toContain('mediaCrop');
    expect(f).toContain('customImageBounds');
  });

  it('detects text features: shadow, margins, scaleToFit, rtfOutline, rtfBullets, emptyRtfShape', () => {
    const emptyRtf = makeRtfBytes({ text: '   ' });
    const bulletRtf = new TextEncoder().encode('{\\rtf1\\ansi \\bullet Item 1\\par}');
    const outlineRtf = new TextEncoder().encode('{\\rtf1\\ansi\\outl Text\\par}');

    const cue = makeCueWithElements({
      elements: [
        // Empty RTF with fill -> emptyRtfShape
        {
          element: {
            bounds: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
            fill: { enable: true, color: { red: 1, green: 0, blue: 0, alpha: 1 } },
            text: {
              rtfData: emptyRtf,
              shadow: { enable: true },
              scaleBehavior: 'SCALE_BEHAVIOR_SCALE_FONT_DOWN',
              margins: { left: 15, right: 15, top: 10, bottom: 10 },
            },
          },
        },
        // Bullet RTF
        {
          element: {
            bounds: { origin: { x: 0, y: 150 }, size: { width: 200, height: 100 } },
            text: {
              rtfData: bulletRtf,
            },
          },
        },
        // Outline RTF
        {
          element: {
            bounds: { origin: { x: 0, y: 300 }, size: { width: 200, height: 100 } },
            text: {
              rtfData: outlineRtf,
            },
          },
        },
      ],
    });

    const bytes = encodePro7Presentation({
      uuid: { string: 'TEST-TEXT' },
      name: 'Text Deck',
      cues: [cue],
    });

    const sources = extractDeckSlideSources(bytes);
    expect(sources).toHaveLength(1);
    const f = sources[0]!.features;
    expect(f).toContain('emptyRtfShape');
    expect(f).toContain('textShadow');
    expect(f).toContain('textScaleToFit');
    expect(f).toContain('textMargins');
    expect(f).toContain('rtfBullets');
    expect(f).toContain('rtfOutline');
  });

  it('sanitizes Uint8Array properly for pro7SlideJson', () => {
    const raw = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // 'Hello'
    const sanitized = sanitizeForJson({
      name: 'Test',
      nested: {
        bytes: raw,
        arr: [raw],
      },
    }) as { name: string; nested: { bytes: { byteLength: number; utf8Preview: string }; arr: unknown[] } };

    expect(sanitized.name).toBe('Test');
    expect(sanitized.nested.bytes.byteLength).toBe(5);
    expect(sanitized.nested.bytes.utf8Preview).toBe('Hello');
    expect(sanitized.nested.arr[0]).toEqual({ byteLength: 5, utf8Preview: 'Hello' });
  });
});

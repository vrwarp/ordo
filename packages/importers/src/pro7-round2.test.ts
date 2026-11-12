import { describe, expect, it } from 'vitest';
import { importPro7 } from './index.ts';
import { pro7Type } from './proto.ts';

const enc = new TextEncoder();
const uuid = (s: string) => ({ string: s });

function rtf(text: string): Uint8Array {
  const body = text
    .split('\n')
    .map((l) =>
      l.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/[^ -~\n]/g, (c) => `\\uc0\\u${c.charCodeAt(0)} `),
    )
    .join('\\\n');
  return enc.encode(
    `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639\n{\\fonttbl\\f0\\fnil\\fcharset0 HelveticaNeue;}\n` +
      `{\\colortbl;\\red255\\green255\\blue255;}\n` +
      `\\pard\\pardeftab1680\\partightenfactor0\n\n\\f0\\fs72 \\cf1 ${body}}`,
  );
}

function encodePresentation(obj: Record<string, unknown>): Uint8Array {
  const T = pro7Type('rv.data.Presentation');
  const err = T.verify(T.fromObject(obj));
  if (err) throw new Error(err);
  return T.encode(T.fromObject(obj)).finish();
}

describe('ProPresenter 7 Round 2B Fidelity Improvements', () => {
  describe('AppKit lineFragmentPadding = 5pt horizontal text insets', () => {
    it('applies default +5pt lineFragmentPadding on left and right for RTF text', () => {
      const cue = {
        uuid: uuid('CUE-PAD1'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-P1'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-TEXT-DEF'),
                        bounds: { origin: { x: 100, y: 100 }, size: { width: 800, height: 200 } },
                        text: {
                          rtfData: rtf('Default Inset Text'),
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
      const doc = encodePresentation({ uuid: uuid('P-PAD1'), name: 'Padding1', cues: [cue] });
      const res = importPro7(new Map([['Library/Padding1.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.style.insets).toEqual({ l: 5, t: 0, r: 5, b: 0 });
        expect(textObj.style.padding).toBe(0);
      }
    });

    it('adds +5pt lineFragmentPadding to explicit margins', () => {
      const cue = {
        uuid: uuid('CUE-PAD2'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-P2'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-TEXT-MARG'),
                        bounds: { origin: { x: 100, y: 100 }, size: { width: 800, height: 200 } },
                        text: {
                          rtfData: rtf('Margin Text'),
                          margins: { left: 10, right: 15, top: 20, bottom: 5 },
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
      const doc = encodePresentation({ uuid: uuid('P-PAD2'), name: 'Padding2', cues: [cue] });
      const res = importPro7(new Map([['Library/Padding2.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.style.insets).toEqual({ l: 15, t: 20, r: 20, b: 5 });
      }
    });
  });

  describe('feather.radius 0.5x erosion calibration', () => {
    it('calibrates shape and image feather softEdge to 0.5x min(w, h)', () => {
      const cue = {
        uuid: uuid('CUE-FEAT'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-FEAT'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-FEAT-SHAPE'),
                        bounds: { origin: { x: 50, y: 50 }, size: { width: 400, height: 200 } },
                        path: { shape: { type: 'TYPE_RECTANGLE' } },
                        fill: { enable: true, color: { red: 1, green: 0, blue: 0, alpha: 1 } },
                        feather: { enable: true, radius: 0.2 },
                      },
                    },
                    {
                      element: {
                        uuid: uuid('EL-FEAT-IMG'),
                        bounds: { origin: { x: 500, y: 50 }, size: { width: 600, height: 400 } },
                        fill: {
                          enable: true,
                          media: {
                            url: { absoluteString: 'file:///Media/test.png' },
                            image: { drawing: { scaleBehavior: 'SCALE_BEHAVIOR_FIT' } },
                          },
                        },
                        feather: { enable: true, radius: 0.1 },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      };
      const doc = encodePresentation({ uuid: uuid('P-FEAT'), name: 'Feather', cues: [cue] });
      const res = importPro7(
        new Map([
          ['Library/Feather.pro', doc],
          ['Media/test.png', new Uint8Array([1, 2, 3])],
        ]),
      );
      const objs = res.presentations[0]!.sections[0]!.slides[0]!.objects;
      const shape = objs.find((o) => o.type === 'shape');
      const img = objs.find((o) => o.type === 'image');
      expect(shape?.type).toBe('shape');
      if (shape?.type === 'shape') {
        // 0.2 * min(400, 200) * 0.5 = 20
        expect(shape.softEdge).toBe(20);
      }
      expect(img?.type).toBe('image');
      if (img?.type === 'image') {
        // 0.1 * min(600, 400) * 0.5 = 20
        expect(img.softEdge).toBe(20);
      }
    });
  });

  describe('Non-rect presets and bezier paths in shapeObjectFrom', () => {
    it('maps TYPE_ROUNDED_RECTANGLE to rect with calibrated radius', () => {
      const cue = {
        uuid: uuid('CUE-RR'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-RR'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-RR'),
                        bounds: { origin: { x: 0, y: 0 }, size: { width: 400, height: 200 } },
                        path: {
                          shape: {
                            type: 'TYPE_ROUNDED_RECTANGLE',
                            roundedRectangle: { roundness: 0.3 },
                          },
                        },
                        fill: { enable: true, color: { red: 0, green: 1, blue: 0, alpha: 1 } },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      };
      const doc = encodePresentation({ uuid: uuid('P-RR'), name: 'RoundedRect', cues: [cue] });
      const res = importPro7(new Map([['Library/RoundedRect.pro', doc]]));
      const shape = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(shape.type).toBe('shape');
      if (shape.type === 'shape') {
        expect(shape.shape).toBe('rect');
        // roundness 0.3 * min(400, 200) * 0.5 = 30
        expect(shape.radius).toBe(30);
      }
    });

    it('maps geometric presets: triangles, diamond, arrows, star, polygon', () => {
      const cue = {
        uuid: uuid('CUE-PRESETS'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-PRE'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-TRI'),
                        bounds: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
                        path: { shape: { type: 'TYPE_ISOSCELES_TRIANGLE' } },
                        fill: { enable: true, color: { red: 1, alpha: 1 } },
                      },
                    },
                    {
                      element: {
                        uuid: uuid('EL-RTRI'),
                        bounds: { origin: { x: 100, y: 0 }, size: { width: 100, height: 100 } },
                        path: { shape: { type: 'TYPE_RIGHT_TRIANGLE' } },
                        fill: { enable: true, color: { red: 1, alpha: 1 } },
                      },
                    },
                    {
                      element: {
                        uuid: uuid('EL-DIA'),
                        bounds: { origin: { x: 200, y: 0 }, size: { width: 100, height: 100 } },
                        path: { shape: { type: 'TYPE_RHOMBUS' } },
                        fill: { enable: true, color: { red: 1, alpha: 1 } },
                      },
                    },
                    {
                      element: {
                        uuid: uuid('EL-ARR'),
                        bounds: { origin: { x: 300, y: 0 }, size: { width: 100, height: 100 } },
                        path: { shape: { type: 'TYPE_RIGHT_ARROW' } },
                        fill: { enable: true, color: { red: 1, alpha: 1 } },
                      },
                    },
                    {
                      element: {
                        uuid: uuid('EL-DARR'),
                        bounds: { origin: { x: 400, y: 0 }, size: { width: 100, height: 100 } },
                        path: { shape: { type: 'TYPE_DOUBLE_ARROW' } },
                        fill: { enable: true, color: { red: 1, alpha: 1 } },
                      },
                    },
                    {
                      element: {
                        uuid: uuid('EL-STAR'),
                        bounds: { origin: { x: 500, y: 0 }, size: { width: 100, height: 100 } },
                        path: { shape: { type: 'TYPE_STAR', star: { numberPoints: 5 } } },
                        fill: { enable: true, color: { red: 1, alpha: 1 } },
                      },
                    },
                    {
                      element: {
                        uuid: uuid('EL-HEX'),
                        bounds: { origin: { x: 600, y: 0 }, size: { width: 100, height: 100 } },
                        path: { shape: { type: 'TYPE_POLYGON', polygon: { numberSides: 6 } } },
                        fill: { enable: true, color: { red: 1, alpha: 1 } },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      };
      const doc = encodePresentation({ uuid: uuid('P-PRE'), name: 'Presets', cues: [cue] });
      const res = importPro7(new Map([['Library/Presets.pro', doc]]));
      const objs = res.presentations[0]!.sections[0]!.slides[0]!.objects.slice().sort(
        (a, b) => a.box.x - b.box.x,
      );
      expect(objs).toHaveLength(7);
      expect((objs[0] as { geom: { preset: string } }).geom.preset).toBe('triangle');
      expect((objs[1] as { geom: { preset: string } }).geom.preset).toBe('rtTriangle');
      expect((objs[2] as { geom: { preset: string } }).geom.preset).toBe('diamond');
      expect((objs[3] as { geom: { preset: string } }).geom.preset).toBe('rightArrow');
      expect((objs[4] as { geom: { preset: string } }).geom.preset).toBe('leftRightArrow');
      expect((objs[5] as { geom: { preset: string } }).geom.preset).toBe('star5');
      expect((objs[6] as { geom: { preset: string } }).geom.preset).toBe('hexagon');
    });

    it('treats 4-corner unit square TYPE_CUSTOM as plain rect without geom', () => {
      const cue = {
        uuid: uuid('CUE-CUSTOM-SQUARE'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-CS'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-CS'),
                        bounds: { origin: { x: 0, y: 0 }, size: { width: 500, height: 300 } },
                        path: {
                          shape: { type: 'TYPE_CUSTOM' },
                          closed: true,
                          points: [
                            { point: { x: 0, y: 0 }, q0: { x: 0, y: 0 }, q1: { x: 0, y: 0 }, curved: false },
                            { point: { x: 1, y: 0 }, q0: { x: 1, y: 0 }, q1: { x: 1, y: 0 }, curved: false },
                            { point: { x: 1, y: 1 }, q0: { x: 1, y: 1 }, q1: { x: 1, y: 1 }, curved: false },
                            { point: { x: 0, y: 1 }, q0: { x: 0, y: 1 }, q1: { x: 0, y: 1 }, curved: false },
                          ],
                        },
                        fill: { enable: true, color: { red: 0.5, alpha: 1 } },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      };
      const doc = encodePresentation({ uuid: uuid('P-CS'), name: 'CustomSquare', cues: [cue] });
      const res = importPro7(new Map([['Library/CustomSquare.pro', doc]]));
      const shape = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(shape.type).toBe('shape');
      if (shape.type === 'shape') {
        expect(shape.shape).toBe('rect');
        expect(shape.geom).toBeUndefined();
      }
    });

    it('converts non-square bezier points in TYPE_CUSTOM to SVG-like path string in 1000x1000 space', () => {
      const cue = {
        uuid: uuid('CUE-BEZIER'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-BEZ'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-BEZ'),
                        bounds: { origin: { x: 0, y: 0 }, size: { width: 500, height: 500 } },
                        path: {
                          shape: { type: 'TYPE_CUSTOM' },
                          closed: true,
                          points: [
                            { point: { x: 0, y: 0 }, q0: { x: 0, y: 0 }, q1: { x: 0.2, y: 0 }, curved: true },
                            {
                              point: { x: 0.5, y: 1 },
                              q0: { x: 0.4, y: 0.9 },
                              q1: { x: 0.5, y: 1 },
                              curved: true,
                            },
                            { point: { x: 1, y: 0 }, q0: { x: 1, y: 0 }, q1: { x: 1, y: 0 }, curved: false },
                          ],
                        },
                        fill: { enable: true, color: { red: 0.2, alpha: 1 } },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      };
      const doc = encodePresentation({ uuid: uuid('P-BEZ'), name: 'Bezier', cues: [cue] });
      const res = importPro7(new Map([['Library/Bezier.pro', doc]]));
      const shape = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(shape.type).toBe('shape');
      if (shape.type === 'shape') {
        expect(shape.geom?.paths).toHaveLength(1);
        const p = shape.geom!.paths![0]!;
        expect(p.w).toBe(1000);
        expect(p.h).toBe(1000);
        expect(p.d).toMatch(/^M 0 0 C 200 0 400 900 500 1000 L 1000 0 L 0 0 Z$/);
      }
    });
  });

  describe('Image masks and cropping in imageObjectFrom', () => {
    it('applies ellipse mask and custom bezier mask to ImageObject', () => {
      const cue = {
        uuid: uuid('CUE-IMG-MASK'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-IM'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-IMG-ELLIPSE'),
                        bounds: { origin: { x: 0, y: 0 }, size: { width: 200, height: 200 } },
                        path: { shape: { type: 'TYPE_ELLIPSE' } },
                        fill: {
                          enable: true,
                          media: {
                            url: { absoluteString: 'file:///Media/pic1.png' },
                            image: { drawing: { scaleBehavior: 'SCALE_BEHAVIOR_FILL' } },
                          },
                        },
                      },
                    },
                    {
                      element: {
                        uuid: uuid('EL-IMG-TRI'),
                        bounds: { origin: { x: 300, y: 0 }, size: { width: 200, height: 200 } },
                        path: { shape: { type: 'TYPE_ISOSCELES_TRIANGLE' } },
                        fill: {
                          enable: true,
                          media: {
                            url: { absoluteString: 'file:///Media/pic2.png' },
                            image: { drawing: { scaleBehavior: 'SCALE_BEHAVIOR_FIT' } },
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
      const doc = encodePresentation({ uuid: uuid('P-IM'), name: 'ImgMasks', cues: [cue] });
      const res = importPro7(
        new Map([
          ['Library/ImgMasks.pro', doc],
          ['Media/pic1.png', new Uint8Array([1])],
          ['Media/pic2.png', new Uint8Array([2])],
        ]),
      );
      const objs = res.presentations[0]!.sections[0]!.slides[0]!.objects.slice().sort(
        (a, b) => a.box.x - b.box.x,
      );
      const [img1, img2] = objs;
      expect(img1?.type).toBe('image');
      if (img1?.type === 'image') {
        expect(img1.mask).toEqual({ preset: 'ellipse' });
      }
      expect(img2?.type).toBe('image');
      if (img2?.type === 'image') {
        expect(img2.mask).toEqual({ preset: 'triangle' });
      }
    });

    it('applies cropEnable + cropInsets with naturalSize normalization', () => {
      const cue = {
        uuid: uuid('CUE-CROP'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-CR'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-CROP'),
                        bounds: { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
                        fill: {
                          enable: true,
                          media: {
                            url: { absoluteString: 'file:///Media/crop.png' },
                            image: {
                              drawing: {
                                scaleBehavior: 'SCALE_BEHAVIOR_FIT',
                                cropEnable: true,
                                naturalSize: { width: 800, height: 600 },
                                cropInsets: { left: 80, top: 60, right: 160, bottom: 120 },
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
      const doc = encodePresentation({ uuid: uuid('P-CR'), name: 'Crop', cues: [cue] });
      const res = importPro7(
        new Map([
          ['Library/Crop.pro', doc],
          ['Media/crop.png', new Uint8Array([1])],
        ]),
      );
      const img = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(img.type).toBe('image');
      if (img.type === 'image') {
        // 80/800 = 0.1, 60/600 = 0.1, 160/800 = 0.2, 120/600 = 0.2
        expect(img.crop).toEqual({ l: 0.1, t: 0.1, r: 0.2, b: 0.2 });
      }
    });

    it('computes exact subpixel stretch crop on SCALE_BEHAVIOR_CUSTOM with customImageBounds', () => {
      const cue = {
        uuid: uuid('CUE-CUSTOM-BOUNDS'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-CB'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-CB'),
                        bounds: { origin: { x: 100, y: 100 }, size: { width: 400, height: 300 } },
                        fill: {
                          enable: true,
                          media: {
                            url: { absoluteString: 'file:///Media/custom.png' },
                            image: {
                              drawing: {
                                scaleBehavior: 'SCALE_BEHAVIOR_CUSTOM',
                                customImageBounds: {
                                  origin: { x: -40, y: -30 },
                                  size: { width: 500, height: 400 },
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
      const doc = encodePresentation({ uuid: uuid('P-CB'), name: 'CustomBounds', cues: [cue] });
      const res = importPro7(
        new Map([
          ['Library/CustomBounds.pro', doc],
          ['Media/custom.png', new Uint8Array([1])],
        ]),
      );
      const img = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(img.type).toBe('image');
      if (img.type === 'image') {
        expect(img.fit).toBe('stretch');
        // cw=500, ch=400, cx=-40, cy=-30, ew=400, eh=300
        // l = -(-40)/500 = 0.08
        // t = -(-30)/400 = 0.075
        // r = 1 - (400 - (-40))/500 = 1 - 440/500 = 0.12
        // b = 1 - (300 - (-30))/400 = 1 - 330/400 = 0.175
        expect(img.crop).toEqual({ l: 0.08, t: 0.075, r: 0.12, b: 0.175 });
      }
    });
  });

  describe('Rich text box-level and custom attributes', () => {
    it('sets style.underline = true on underlineStyle enable or non-STYLE_NONE', () => {
      const cue = {
        uuid: uuid('CUE-UNDERLINE'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-U'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-U'),
                        bounds: { origin: { x: 0, y: 0 }, size: { width: 600, height: 200 } },
                        text: {
                          rtfData: rtf('Underlined Text'),
                          attributes: {
                            underlineStyle: { style: 'STYLE_SINGLE' },
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
      const doc = encodePresentation({ uuid: uuid('P-U'), name: 'Underline', cues: [cue] });
      const res = importPro7(new Map([['Library/Underline.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.style.underline).toBe(true);
      }
    });

    it('applies customAttribute CAPITALIZATION_SMALL_CAPS as run with caps: "small"', () => {
      const cue = {
        uuid: uuid('CUE-SC'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-SC'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-SC'),
                        bounds: { origin: { x: 0, y: 0 }, size: { width: 600, height: 200 } },
                        text: {
                          rtfData: rtf('Hello Small Caps World'),
                          attributes: {
                            customAttributes: [
                              {
                                range: { start: 6, end: 16 },
                                capitalization: 'CAPITALIZATION_SMALL_CAPS',
                              },
                            ],
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
      const doc = encodePresentation({ uuid: uuid('P-SC'), name: 'SmallCaps', cues: [cue] });
      const res = importPro7(new Map([['Library/SmallCaps.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.runs).toBeDefined();
        expect(textObj.runs).toHaveLength(1);
        expect(textObj.runs![0]).toEqual({
          start: 6,
          end: 16,
          caps: 'small',
        });
      }
    });
  });
});

import { describe, expect, it } from 'vitest';
import { importPro7 } from './index.ts';
import { pro7Type } from './proto.ts';

const enc = new TextEncoder();
const uuid = (s: string) => ({ string: s });

function rtf(text: string, opts: { fs?: number } = {}): Uint8Array {
  const body = text
    .split('\n')
    .map((l) =>
      l.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/[^ -~\n]/g, (c) => `\\uc0\\u${c.charCodeAt(0)} `),
    )
    .join('\\\n');
  return enc.encode(
    `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639\n{\\fonttbl\\f0\\fnil\\fcharset0 HelveticaNeue;}\n` +
      `{\\colortbl;\\red255\\green255\\blue255;}\n` +
      `\\pard\\pardeftab1680\\partightenfactor0\n\n\\f0\\fs${opts.fs ?? 120} \\cf1 ${body}}`,
  );
}

function encodePresentation(obj: Record<string, unknown>): Uint8Array {
  const T = pro7Type('rv.data.Presentation');
  const err = T.verify(T.fromObject(obj));
  if (err) throw new Error(err);
  return T.encode(T.fromObject(obj)).finish();
}

describe('ProPresenter 7 Round 3A Cocoa Baseline Calibrations', () => {
  describe('textLineMask middle-aligned intra-strap baseline centering', () => {
    it('applies +2*(0.065*F) to insets.t and -(0.065*F) to vOffsetPx when verticalOffset is omitted', () => {
      // fs120 in RTF = 60pt = 60px at scale 1.
      // maskBaseShift = round(60 * 0.065 * 100) / 100 = 3.9
      // 2 * maskBaseShift = 7.8
      const cue = {
        uuid: uuid('CUE-MASK-1'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-M1'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-MASK-MID'),
                        bounds: { origin: { x: 100, y: 100 }, size: { width: 800, height: 300 } },
                        fill: { enable: true, color: { red: 1, green: 1, blue: 1, alpha: 1 } },
                        textLineMask: {
                          enabled: true,
                          maskStyle: 'LINE_MASK_STYLE_LINE_WIDTH',
                          heightOffset: 10,
                        },
                        text: {
                          rtfData: rtf('Masked Line Middle', { fs: 120 }),
                          verticalAlignment: 'VERTICAL_ALIGNMENT_MIDDLE',
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

      const doc = encodePresentation({ uuid: uuid('P-M1'), name: 'MaskMid1', cues: [cue] });
      const res = importPro7(new Map([['Library/MaskMid1.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.style.fontSizePx).toBe(60);
        expect(textObj.style.valign).toBe('middle');
        // Default RTF insets: l=5, r=5, t=0, b=0 -> t becomes 0 + 2 * 3.9 = 7.8
        expect(textObj.style.insets).toEqual({ l: 5, t: 7.8, r: 5, b: 0 });
        // vOffsetPx becomes 0 - 3.9 = -3.9
        expect(textObj.style.lineMask?.vOffsetPx).toBe(-3.9);
        expect(textObj.style.lineMask?.heightOffsetPx).toBe(10);
      }
    });

    it('preserves explicit verticalOffset and applies the shift to both insets.t and vOffsetPx', () => {
      // fs100 in RTF = 50pt = 50px at scale 1.
      // maskBaseShift = round(50 * 0.065 * 100) / 100 = 3.25
      // 2 * maskBaseShift = 6.5
      // explicit verticalOffset = 10 -> vOffsetPx = 10 - 3.25 = 6.75
      const cue = {
        uuid: uuid('CUE-MASK-2'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-M2'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-MASK-EXP'),
                        bounds: { origin: { x: 100, y: 100 }, size: { width: 800, height: 300 } },
                        fill: { enable: true, color: { red: 1, green: 1, blue: 1, alpha: 1 } },
                        textLineMask: {
                          enabled: true,
                          maskStyle: 'LINE_MASK_STYLE_MAX_LINE_WIDTH',
                          verticalOffset: 10,
                        },
                        text: {
                          rtfData: rtf('Explicit Offset Text', { fs: 100 }),
                          verticalAlignment: 'VERTICAL_ALIGNMENT_MIDDLE',
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

      const doc = encodePresentation({ uuid: uuid('P-M2'), name: 'MaskMid2', cues: [cue] });
      const res = importPro7(new Map([['Library/MaskMid2.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.style.fontSizePx).toBe(50);
        expect(textObj.style.insets?.t).toBe(6.5);
        expect(textObj.style.lineMask?.vOffsetPx).toBe(6.75);
      }
    });

    it('does not shift insets.t or vOffsetPx when valign is top', () => {
      const cue = {
        uuid: uuid('CUE-MASK-TOP'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-MT'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-MASK-TOP'),
                        bounds: { origin: { x: 100, y: 100 }, size: { width: 800, height: 300 } },
                        fill: { enable: true, color: { red: 1, green: 1, blue: 1, alpha: 1 } },
                        textLineMask: {
                          enabled: true,
                          maskStyle: 'LINE_MASK_STYLE_FULL_WIDTH',
                          verticalOffset: 5,
                        },
                        text: {
                          rtfData: rtf('Top Masked Text', { fs: 120 }),
                          verticalAlignment: 'VERTICAL_ALIGNMENT_TOP',
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

      const doc = encodePresentation({ uuid: uuid('P-MT'), name: 'MaskTop', cues: [cue] });
      const res = importPro7(new Map([['Library/MaskTop.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.style.valign).toBe('top');
        expect(textObj.style.insets?.t).toBe(0);
        expect(textObj.style.lineMask?.vOffsetPx).toBe(5);
      }
    });
  });

  describe('width-constrained single-line autofit shrink middle baseline centering', () => {
    it('applies +2*(0.065*effPx) to insets.t for single-line width-constrained boxes', () => {
      // box: h=200, fs160 -> fontSizePx=80.
      // fontSizePx * 1.2 = 96 <= box.h * 0.92 = 184 (width-constrained).
      // effPx = min(80, 200 * 0.65 = 130) = 80.
      // fitShift = round(80 * 0.065 * 100) / 100 = 5.2.
      // insets.t becomes 0 + 2 * 5.2 = 10.4.
      const cue = {
        uuid: uuid('CUE-FIT-1'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-F1'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-FIT-1'),
                        bounds: { origin: { x: 100, y: 100 }, size: { width: 1000, height: 200 } },
                        text: {
                          rtfData: rtf('Single Line Countdown', { fs: 160 }),
                          scaleBehavior: 'SCALE_BEHAVIOR_SCALE_FONT_DOWN',
                          verticalAlignment: 'VERTICAL_ALIGNMENT_MIDDLE',
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

      const doc = encodePresentation({ uuid: uuid('P-F1'), name: 'Fit1', cues: [cue] });
      const res = importPro7(new Map([['Library/Fit1.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.style.autofit).toBe('shrink');
        expect(textObj.style.valign).toBe('middle');
        expect(textObj.style.insets?.t).toBe(10.4);
      }
    });

    it('does not apply shift when text contains multiple lines', () => {
      const cue = {
        uuid: uuid('CUE-FIT-MULTI'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-FM'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-FIT-M'),
                        bounds: { origin: { x: 100, y: 100 }, size: { width: 1000, height: 200 } },
                        text: {
                          rtfData: rtf('Line One\nLine Two', { fs: 160 }),
                          scaleBehavior: 'SCALE_BEHAVIOR_SCALE_FONT_DOWN',
                          verticalAlignment: 'VERTICAL_ALIGNMENT_MIDDLE',
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

      const doc = encodePresentation({ uuid: uuid('P-FM'), name: 'FitMulti', cues: [cue] });
      const res = importPro7(new Map([['Library/FitMulti.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.style.insets?.t).toBe(0);
      }
    });

    it('does not apply shift when box is height-constrained (fontSizePx * 1.2 > box.h * 0.92)', () => {
      // box: h=100, fs180 -> fontSizePx=90.
      // fontSizePx * 1.2 = 108 > box.h * 0.92 = 92 -> height constrained!
      const cue = {
        uuid: uuid('CUE-FIT-H'),
        isEnabled: true,
        actions: [
          {
            uuid: uuid('ACT-FH'),
            type: 'ACTION_TYPE_PRESENTATION_SLIDE',
            isEnabled: true,
            slide: {
              presentation: {
                baseSlide: {
                  size: { width: 1920, height: 1080 },
                  elements: [
                    {
                      element: {
                        uuid: uuid('EL-FIT-H'),
                        bounds: { origin: { x: 100, y: 100 }, size: { width: 1000, height: 100 } },
                        text: {
                          rtfData: rtf('Height Constrained Single Line', { fs: 180 }),
                          scaleBehavior: 'SCALE_BEHAVIOR_SCALE_FONT_DOWN',
                          verticalAlignment: 'VERTICAL_ALIGNMENT_MIDDLE',
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

      const doc = encodePresentation({ uuid: uuid('P-FH'), name: 'FitHeight', cues: [cue] });
      const res = importPro7(new Map([['Library/FitHeight.pro', doc]]));
      const textObj = res.presentations[0]!.sections[0]!.slides[0]!.objects[0]!;
      expect(textObj.type).toBe('text');
      if (textObj.type === 'text') {
        expect(textObj.style.insets?.t ?? 0).toBe(0);
      }
    });
  });
});

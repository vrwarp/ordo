import { describe, expect, it } from 'vitest';
import { importPro7 } from './index.ts';
import { pro7Type } from './proto.ts';

const enc = new TextEncoder();

const uuid = (s: string) => ({ string: s });

function rtf(
  text: string,
  opts: { font?: string; fs?: number; align?: 'ql' | 'qc' | 'qr'; slleading?: number } = {},
): Uint8Array {
  const body = text
    .split('\n')
    .map((l) =>
      l.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/[^ -~\n]/g, (c) => `\\uc0\\u${c.charCodeAt(0)} `),
    )
    .join('\\\n');
  const alignCmd = opts.align ? `\\${opts.align}` : '';
  const leadingCmd = opts.slleading ? `\\slleading${opts.slleading}` : '';
  return enc.encode(
    `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639\n{\\fonttbl\\f0\\fnil\\fcharset0 ${opts.font ?? 'HelveticaNeue'};}\n` +
      `{\\colortbl;\\red255\\green255\\blue255;}\n` +
      `\\pard\\pardeftab1680${alignCmd}${leadingCmd}\\partightenfactor0\n\n\\f0\\fs${opts.fs ?? 108} \\cf1 ${body}}`,
  );
}

function encodePresentation(obj: Record<string, unknown>): Uint8Array {
  const T = pro7Type('rv.data.Presentation');
  const err = T.verify(T.fromObject(obj));
  if (err) throw new Error(err);
  return T.encode(T.fromObject(obj)).finish();
}

describe('ProPresenter 7 Round 1 Fidelity Upgrades', () => {
  it('falls back from "Untitled" document name to ccli.songTitle then file name', () => {
    // 1. "Untitled" doc name with file name "Sample Presentation.pro"
    const doc1 = encodePresentation({
      uuid: uuid('DOC-1'),
      name: 'Untitled',
      cues: [],
    });
    const res1 = importPro7(new Map([['Library/Sample Presentation.pro', doc1]]));
    expect(res1.presentations[0]!.title).toBe('Sample Presentation');

    // 2. "Untitled" doc name with ccli.songTitle "Way Maker"
    const doc2 = encodePresentation({
      uuid: uuid('DOC-2'),
      name: 'Untitled',
      ccli: { songTitle: 'Way Maker' },
      cues: [],
    });
    const res2 = importPro7(new Map([['Library/Sample Presentation.pro', doc2]]));
    expect(res2.presentations[0]!.title).toBe('Way Maker');

    // 3. Document actually named "Untitled.pro"
    const doc3 = encodePresentation({
      uuid: uuid('DOC-3'),
      name: 'Untitled',
      cues: [],
    });
    const res3 = importPro7(new Map([['Library/Untitled.pro', doc3]]));
    expect(res3.presentations[0]!.title).toBe('Untitled');

    // 4. Meaningful document name preserved
    const doc4 = encodePresentation({
      uuid: uuid('DOC-4'),
      name: 'Sunday Announcements',
      cues: [],
    });
    const res4 = importPro7(new Map([['Library/File.pro', doc4]]));
    expect(res4.presentations[0]!.title).toBe('Sunday Announcements');
  });

  it('routes empty-RTF elements with fill/gradient/shadow to ShapeObject without emitting empty TextObject', () => {
    const cue = {
      uuid: uuid('CUE-1'),
      isEnabled: true,
      actions: [
        {
          uuid: uuid('ACT-1'),
          type: 'ACTION_TYPE_PRESENTATION_SLIDE',
          isEnabled: true,
          slide: {
            presentation: {
              baseSlide: {
                size: { width: 1920, height: 1080 },
                elements: [
                  {
                    element: {
                      uuid: uuid('EL-GRAD'),
                      name: 'Gradient Box',
                      bounds: { origin: { x: 100, y: 100 }, size: { width: 500, height: 300 } },
                      path: { shape: { type: 'TYPE_RECTANGLE' } },
                      fill: {
                        enable: true,
                        gradient: {
                          type: 'TYPE_LINEAR',
                          angle: 300,
                          stops: [
                            { color: { red: 1, green: 0, blue: 0, alpha: 1 }, position: 0 },
                            { color: { red: 0, green: 0, blue: 1, alpha: 1 }, position: 1 },
                          ],
                        },
                      },
                      shadow: {
                        enable: true,
                        angle: 315,
                        offset: 5,
                        radius: 10,
                        color: { alpha: 1 },
                        opacity: 0.5,
                      },
                      feather: { enable: true, radius: 0.1 },
                      text: {
                        rtfData: rtf('   \n  '),
                      },
                    },
                  },
                  {
                    element: {
                      uuid: uuid('EL-EMPTY-NOFILL'),
                      name: 'Blank',
                      bounds: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
                      text: {
                        rtfData: rtf(''),
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

    const doc = encodePresentation({ uuid: uuid('P-GRAD'), name: 'Shapes', cues: [cue] });
    const res = importPro7(new Map([['Library/Shapes.pro', doc]]));
    const slide = res.presentations[0]!.sections[0]!.slides[0]!;

    // Exactly 1 object emitted: the ShapeObject (no empty TextObject!)
    expect(slide.objects).toHaveLength(1);
    const shape = slide.objects[0]!;
    expect(shape.type).toBe('shape');
    if (shape.type === 'shape') {
      expect(shape.shape).toBe('rect');
      expect(shape.box).toEqual({ x: 100, y: 100, w: 500, h: 300, rotation: 0 });
      expect(shape.gradient).toEqual({
        kind: 'linear',
        angle: 60,
        stops: [
          { at: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
          { at: 1, color: { r: 0, g: 0, b: 255, a: 1 } },
        ],
      });
      expect(shape.shadow).toMatchObject({
        dx: 3.54,
        dy: 3.54,
        blur: 10,
      });
      // 0.1 * min(500, 300) * 0.5 = 15
      expect(shape.softEdge).toBe(15);
    }

    // EL-EMPTY-NOFILL was skipped as empty text element
    const emptyLog = res.log.find((l) => l.message.includes('empty text elements'));
    expect(emptyLog).toBeDefined();
  });

  it('converts ProPresenter CCW angles to Ordo CW angles (315° -> 45°, 300° -> 60°)', () => {
    const cue = {
      uuid: uuid('CUE-ANGLES'),
      isEnabled: true,
      actions: [
        {
          uuid: uuid('ACT-A'),
          type: 'ACTION_TYPE_PRESENTATION_SLIDE',
          isEnabled: true,
          slide: {
            presentation: {
              baseSlide: {
                size: { width: 1920, height: 1080 },
                elements: [
                  {
                    element: {
                      uuid: uuid('EL-315'),
                      bounds: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
                      fill: {
                        enable: true,
                        gradient: {
                          angle: 315,
                          stops: [
                            { color: { red: 0, green: 0, blue: 0, alpha: 1 } },
                            { color: { red: 1, green: 1, blue: 1, alpha: 1 } },
                          ],
                        },
                      },
                    },
                  },
                  {
                    element: {
                      uuid: uuid('EL-300'),
                      bounds: { origin: { x: 100, y: 0 }, size: { width: 100, height: 100 } },
                      fill: {
                        enable: true,
                        gradient: {
                          angle: 300,
                          stops: [
                            { color: { red: 0, green: 0, blue: 0, alpha: 1 } },
                            { color: { red: 1, green: 1, blue: 1, alpha: 1 } },
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

    const doc = encodePresentation({ uuid: uuid('P-ANG'), name: 'Angles', cues: [cue] });
    const res = importPro7(new Map([['Library/Angles.pro', doc]]));
    const slide = res.presentations[0]!.sections[0]!.slides[0]!;

    expect(slide.objects).toHaveLength(2);
    const obj300 = slide.objects[0]! as { gradient: { angle: number } };
    const obj315 = slide.objects[1]! as { gradient: { angle: number } };

    expect(obj315.gradient.angle).toBe(45);
    expect(obj300.gradient.angle).toBe(60);
  });

  it('populates textLineMask and applies \\slleading line spacing and insets', () => {
    const cue = {
      uuid: uuid('CUE-MASK'),
      isEnabled: true,
      actions: [
        {
          uuid: uuid('ACT-M'),
          type: 'ACTION_TYPE_PRESENTATION_SLIDE',
          isEnabled: true,
          slide: {
            presentation: {
              baseSlide: {
                size: { width: 1920, height: 1080 },
                elements: [
                  {
                    element: {
                      uuid: uuid('EL-MASK'),
                      name: 'Masked Text',
                      bounds: { origin: { x: 200, y: 300 }, size: { width: 1520, height: 480 } },
                      fill: {
                        enable: true,
                        color: { red: 0.1, green: 0.2, blue: 0.3, alpha: 0.9 },
                      },
                      textLineMask: {
                        enabled: true,
                        maskStyle: 'LINE_MASK_STYLE_LINE_WIDTH',
                        heightOffset: 12,
                        verticalOffset: 6,
                        widthOffset: 24,
                        horizontalOffset: 8,
                      },
                      text: {
                        rtfData: rtf('Line One\nLine Two', { slleading: 400 }), // 400 twips = 20 pt
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

    const doc = encodePresentation({ uuid: uuid('P-MASK'), name: 'Masks', cues: [cue] });
    const res = importPro7(new Map([['Library/Masks.pro', doc]]));
    const slide = res.presentations[0]!.sections[0]!.slides[0]!;

    // Exactly 1 object emitted: the TextObject with lineMask (no full-box backing ShapeObject)
    expect(slide.objects).toHaveLength(1);
    const textObj = slide.objects[0]!;
    expect(textObj.type).toBe('text');
    if (textObj.type === 'text') {
      expect(textObj.style.lineMask).toMatchObject({
        style: 'lineWidth',
        heightOffsetPx: 12,
        vOffsetPx: 2.49,
        widthOffsetPx: 24,
        hOffsetPx: 8,
        fill: { r: 26, g: 51, b: 77 },
      });
      expect(textObj.style.lineMask?.fill?.a).toBeCloseTo(0.9);
      // Extra leading added to spaceAfterPx on each paragraph
      expect(textObj.paras).toHaveLength(2);
      expect(textObj.paras![0]!.spaceAfterPx).toBe(20);
      expect(textObj.paras![1]!.spaceAfterPx).toBe(20);
      // Bottom inset adjusted for Cocoa vertical centering
      expect(textObj.style.insets?.b).toBe(20);
    }
  });

  it('defaults alignment to "left" when ALIGNMENT_LEFT is omitted in proto3 and RTF is non-plain', () => {
    const cue = {
      uuid: uuid('CUE-ALIGN'),
      isEnabled: true,
      actions: [
        {
          uuid: uuid('ACT-AL'),
          type: 'ACTION_TYPE_PRESENTATION_SLIDE',
          isEnabled: true,
          slide: {
            presentation: {
              baseSlide: {
                size: { width: 1920, height: 1080 },
                elements: [
                  {
                    element: {
                      uuid: uuid('EL-ALIGN'),
                      bounds: { origin: { x: 0, y: 0 }, size: { width: 500, height: 200 } },
                      text: {
                        rtfData: rtf('Left Aligned Text'),
                        attributes: {
                          paragraphStyle: {
                            // alignment: ALIGNMENT_LEFT (0) is omitted by proto3 serialization
                            lineHeightMultiple: 1.2,
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

    const doc = encodePresentation({ uuid: uuid('P-AL'), name: 'Align', cues: [cue] });
    const res = importPro7(new Map([['Library/Align.pro', doc]]));
    const slide = res.presentations[0]!.sections[0]!.slides[0]!;

    const textObj = slide.objects[0]! as { type: string; style: { align: string } };
    expect(textObj.style.align).toBe('left');
  });

  it('sets autofit to "shrink" on SCALE_BEHAVIOR_SCALE_FONT_DOWN', () => {
    const cue = {
      uuid: uuid('CUE-FIT'),
      isEnabled: true,
      actions: [
        {
          uuid: uuid('ACT-FIT'),
          type: 'ACTION_TYPE_PRESENTATION_SLIDE',
          isEnabled: true,
          slide: {
            presentation: {
              baseSlide: {
                size: { width: 1920, height: 1080 },
                elements: [
                  {
                    element: {
                      uuid: uuid('EL-FIT'),
                      bounds: { origin: { x: 0, y: 0 }, size: { width: 400, height: 100 } },
                      text: {
                        rtfData: rtf('754:56'),
                        scaleBehavior: 'SCALE_BEHAVIOR_SCALE_FONT_DOWN',
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

    const doc = encodePresentation({ uuid: uuid('P-FIT'), name: 'Fit', cues: [cue] });
    const res = importPro7(new Map([['Library/Fit.pro', doc]]));
    const slide = res.presentations[0]!.sections[0]!.slides[0]!;

    const textObj = slide.objects[0]! as { type: string; style: { autofit?: string } };
    expect(textObj.style.autofit).toBe('shrink');
  });

  it('skips empty-RTF text boxes with textLineMask enabled instead of drawing an unmasked shape', () => {
    const cue = {
      uuid: uuid('CUE-EMPTY-MASK'),
      isEnabled: true,
      actions: [
        {
          uuid: uuid('ACT-EMPTY-MASK'),
          type: 'ACTION_TYPE_PRESENTATION_SLIDE',
          isEnabled: true,
          slide: {
            presentation: {
              baseSlide: {
                size: { width: 1920, height: 1080 },
                drawsBackgroundColor: true,
                backgroundColor: { red: 0, green: 0, blue: 0, alpha: 1 },
                elements: [
                  {
                    element: {
                      uuid: uuid('EL-EMPTY-MASK'),
                      bounds: { origin: { x: 210, y: 390 }, size: { width: 1500, height: 300 } },
                      fill: {
                        enable: true,
                        color: { red: 1, green: 1, blue: 1, alpha: 1 },
                      },
                      text: { rtfData: rtf('') },
                      textLineMask: { enabled: true },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    const doc = encodePresentation({ uuid: uuid('P-EMPTY-MASK'), name: 'Blank Intro', cues: [cue] });
    const res = importPro7(new Map([['Library/BlankIntro.pro', doc]]));
    const slide = res.presentations[0]!.sections[0]!.slides[0]!;
    expect(slide.objects).toHaveLength(1);
    expect(slide.objects[0]).toMatchObject({
      type: 'shape',
      box: { x: 0, y: 0, w: 1920, h: 1080 },
    });
  });
});

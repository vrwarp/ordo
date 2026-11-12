import { pro7Type } from '@ordo/importers/proto.ts';
import { encodePng, makePng } from './png.ts';
import type { RgbaImage } from './types.ts';

export type SyntheticDeck = {
  name: string;
  proFileName: string;
  files: Map<string, Uint8Array>;
  referenceSlides: RgbaImage[];
};

export function encodePro7Presentation(obj: Record<string, unknown>): Uint8Array {
  const t = pro7Type('rv.data.Presentation');
  return t.encode(t.fromObject(obj)).finish();
}

export function makeCueWithElements(opts: {
  name?: string;
  uuid?: string;
  drawsBackgroundColor?: boolean;
  backgroundColor?: { red: number; green: number; blue: number; alpha?: number };
  size?: { width: number; height: number };
  elements?: Record<string, unknown>[];
  actions?: Record<string, unknown>[];
}): Record<string, unknown> {
  const cueActions: Record<string, unknown>[] = opts.actions ? [...opts.actions] : [];
  if (
    opts.elements !== undefined ||
    opts.drawsBackgroundColor !== undefined ||
    opts.backgroundColor !== undefined
  ) {
    cueActions.push({
      type: 'ACTION_TYPE_PRESENTATION_SLIDE',
      isEnabled: true,
      slide: {
        presentation: {
          baseSlide: {
            drawsBackgroundColor: opts.drawsBackgroundColor ?? false,
            backgroundColor: opts.backgroundColor,
            size: opts.size ?? { width: 1920, height: 1080 },
            elements: opts.elements ?? [],
          },
        },
      },
    });
  }
  return {
    uuid: { string: opts.uuid ?? 'CUE-1' },
    name: opts.name ?? 'Cue',
    isEnabled: true,
    actions: cueActions,
  };
}

export function makeRectElement(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: { r: number; g: number; b: number; a?: number };
  stroke?: { r: number; g: number; b: number; a?: number; width: number };
  opacity?: number;
  name?: string;
  uuid?: string;
}): Record<string, unknown> {
  const el: Record<string, unknown> = {
    uuid: { string: opts.uuid ?? 'RECT-EL' },
    name: opts.name ?? 'Rectangle',
    bounds: {
      origin: { x: opts.x, y: opts.y },
      size: { width: opts.w, height: opts.h },
    },
    path: {
      shape: {
        type: 'TYPE_RECTANGLE',
      },
    },
    opacity: opts.opacity ?? 1,
  };
  if (opts.fill) {
    el.fill = {
      enable: true,
      color: {
        red: opts.fill.r / 255,
        green: opts.fill.g / 255,
        blue: opts.fill.b / 255,
        alpha: opts.fill.a ?? 1,
      },
    };
  }
  if (opts.stroke) {
    el.stroke = {
      enable: true,
      width: opts.stroke.width,
      color: {
        red: opts.stroke.r / 255,
        green: opts.stroke.g / 255,
        blue: opts.stroke.b / 255,
        alpha: opts.stroke.a ?? 1,
      },
    };
  }
  return { element: el };
}

export function makeRtfBytes(opts: {
  text: string;
  fontName?: string;
  fontSizePt?: number;
  color?: { r: number; g: number; b: number };
}): Uint8Array {
  const font = opts.fontName ?? 'Helvetica';
  const sizeHalfPt = (opts.fontSizePt ?? 24) * 2;
  const col = opts.color ?? { r: 255, g: 255, b: 255 };
  const rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 ${font};}}{\\colortbl;\\red${col.r}\\green${col.g}\\blue${col.b};}\\f0\\fs${sizeHalfPt}\\cf1 ${opts.text}}`;
  return new TextEncoder().encode(rtf);
}

export function makeGradientRectElement(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  gradient: {
    type?: 'TYPE_LINEAR' | 'TYPE_RADIAL' | number;
    angle?: number;
    stops: {
      color: { r: number; g: number; b: number; a?: number };
      position?: number;
      blendPoint?: number;
    }[];
  };
  emptyRtf?: boolean;
  opacity?: number;
  name?: string;
  uuid?: string;
}): Record<string, unknown> {
  const el: Record<string, unknown> = {
    uuid: { string: opts.uuid ?? 'GRAD-RECT-EL' },
    name: opts.name ?? 'Gradient Rectangle',
    bounds: {
      origin: { x: opts.x, y: opts.y },
      size: { width: opts.w, height: opts.h },
    },
    path: {
      shape: {
        type: 'TYPE_RECTANGLE',
      },
    },
    fill: {
      enable: true,
      gradient: {
        type: opts.gradient.type ?? 'TYPE_LINEAR',
        angle: opts.gradient.angle ?? 0,
        stops: opts.gradient.stops.map((s) => ({
          color: {
            red: s.color.r / 255,
            green: s.color.g / 255,
            blue: s.color.b / 255,
            alpha: s.color.a ?? 1,
          },
          ...(s.position !== undefined ? { position: s.position } : {}),
          ...(s.blendPoint !== undefined ? { blendPoint: s.blendPoint } : {}),
        })),
      },
    },
    opacity: opts.opacity ?? 1,
  };
  if (opts.emptyRtf) {
    el.text = {
      rtfData: makeRtfBytes({ text: '' }),
    };
  }
  return { element: el };
}

export function makeEllipseElement(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: { r: number; g: number; b: number; a?: number };
  stroke?: { r: number; g: number; b: number; a?: number; width: number };
  opacity?: number;
  name?: string;
  uuid?: string;
}): Record<string, unknown> {
  const el: Record<string, unknown> = {
    uuid: { string: opts.uuid ?? 'ELLIPSE-EL' },
    name: opts.name ?? 'Ellipse',
    bounds: {
      origin: { x: opts.x, y: opts.y },
      size: { width: opts.w, height: opts.h },
    },
    path: {
      closed: true,
      shape: {
        type: 'TYPE_ELLIPSE',
      },
    },
    opacity: opts.opacity ?? 1,
  };
  if (opts.fill) {
    el.fill = {
      enable: true,
      color: {
        red: opts.fill.r / 255,
        green: opts.fill.g / 255,
        blue: opts.fill.b / 255,
        alpha: opts.fill.a ?? 1,
      },
    };
  }
  if (opts.stroke) {
    el.stroke = {
      enable: true,
      width: opts.stroke.width,
      color: {
        red: opts.stroke.r / 255,
        green: opts.stroke.g / 255,
        blue: opts.stroke.b / 255,
        alpha: opts.stroke.a ?? 1,
      },
    };
  }
  return { element: el };
}

export function makeRoundedRectElement(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  roundness?: number;
  fill?: { r: number; g: number; b: number; a?: number };
  stroke?: { r: number; g: number; b: number; a?: number; width: number };
  opacity?: number;
  name?: string;
  uuid?: string;
}): Record<string, unknown> {
  const el: Record<string, unknown> = {
    uuid: { string: opts.uuid ?? 'ROUNDED-RECT-EL' },
    name: opts.name ?? 'Rounded Rectangle',
    bounds: {
      origin: { x: opts.x, y: opts.y },
      size: { width: opts.w, height: opts.h },
    },
    path: {
      closed: true,
      shape: {
        type: 'TYPE_ROUNDED_RECTANGLE',
        roundedRectangle: {
          roundness: opts.roundness ?? 0.2,
        },
      },
    },
    opacity: opts.opacity ?? 1,
  };
  if (opts.fill) {
    el.fill = {
      enable: true,
      color: {
        red: opts.fill.r / 255,
        green: opts.fill.g / 255,
        blue: opts.fill.b / 255,
        alpha: opts.fill.a ?? 1,
      },
    };
  }
  if (opts.stroke) {
    el.stroke = {
      enable: true,
      width: opts.stroke.width,
      color: {
        red: opts.stroke.r / 255,
        green: opts.stroke.g / 255,
        blue: opts.stroke.b / 255,
        alpha: opts.stroke.a ?? 1,
      },
    };
  }
  return { element: el };
}

export function makeCustomPathElement(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  points: {
    point: { x: number; y: number };
    q0?: { x: number; y: number };
    q1?: { x: number; y: number };
  }[];
  closed?: boolean;
  fill?: { r: number; g: number; b: number; a?: number };
  stroke?: { r: number; g: number; b: number; a?: number; width: number };
  opacity?: number;
  name?: string;
  uuid?: string;
}): Record<string, unknown> {
  const el: Record<string, unknown> = {
    uuid: { string: opts.uuid ?? 'CUSTOM-PATH-EL' },
    name: opts.name ?? 'Custom Path',
    bounds: {
      origin: { x: opts.x, y: opts.y },
      size: { width: opts.w, height: opts.h },
    },
    path: {
      closed: opts.closed ?? true,
      shape: {
        type: 'TYPE_CUSTOM',
      },
      points: opts.points.map((pt) => ({
        point: pt.point,
        q0: pt.q0 ?? pt.point,
        q1: pt.q1 ?? pt.point,
      })),
    },
    opacity: opts.opacity ?? 1,
  };
  if (opts.fill) {
    el.fill = {
      enable: true,
      color: {
        red: opts.fill.r / 255,
        green: opts.fill.g / 255,
        blue: opts.fill.b / 255,
        alpha: opts.fill.a ?? 1,
      },
    };
  }
  if (opts.stroke) {
    el.stroke = {
      enable: true,
      width: opts.stroke.width,
      color: {
        red: opts.stroke.r / 255,
        green: opts.stroke.g / 255,
        blue: opts.stroke.b / 255,
        alpha: opts.stroke.a ?? 1,
      },
    };
  }
  return { element: el };
}

export function makeMediaElement(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  mediaPath: string;
  shapeType?: 'TYPE_RECTANGLE' | 'TYPE_ELLIPSE' | string;
  crop?: { left?: number; top?: number; right?: number; bottom?: number };
  scaleBehavior?: 'SCALE_BEHAVIOR_FIT' | 'SCALE_BEHAVIOR_FILL' | 'SCALE_BEHAVIOR_STRETCH' | string;
  opacity?: number;
  name?: string;
  uuid?: string;
}): Record<string, unknown> {
  const shape = opts.shapeType ?? 'TYPE_RECTANGLE';
  const el: Record<string, unknown> = {
    uuid: { string: opts.uuid ?? 'MEDIA-EL' },
    name: opts.name ?? 'Media Element',
    bounds: {
      origin: { x: opts.x, y: opts.y },
      size: { width: opts.w, height: opts.h },
    },
    path: {
      closed: true,
      shape: {
        type: shape,
      },
    },
    fill: {
      enable: true,
      media: {
        url: {
          absoluteString: `file:///${opts.mediaPath.replace(/^\/+/, '')}`,
          relativePath: opts.mediaPath.replace(/^\/+/, ''),
        },
        image: {
          drawing: {
            cropEnable: !!opts.crop,
            ...(opts.crop
              ? {
                  cropInsets: {
                    left: opts.crop.left ?? 0,
                    top: opts.crop.top ?? 0,
                    right: opts.crop.right ?? 0,
                    bottom: opts.crop.bottom ?? 0,
                  },
                }
              : {}),
            scaleBehavior: opts.scaleBehavior ?? 'SCALE_BEHAVIOR_STRETCH',
          },
        },
      },
    },
    opacity: opts.opacity ?? 1,
  };
  return { element: el };
}

export function buildSyntheticCorpus(): SyntheticDeck[] {
  const cue1 = makeCueWithElements({
    name: 'Slide 1 - Opaque Blue BG',
    uuid: 'CUE-CORE-1',
    drawsBackgroundColor: true,
    backgroundColor: { red: 20 / 255, green: 40 / 255, blue: 80 / 255, alpha: 1 },
    elements: [],
  });

  const coralRect = makeRectElement({
    x: 480,
    y: 270,
    w: 960,
    h: 540,
    fill: { r: 255, g: 127, b: 80, a: 1 },
    name: 'Coral Rectangle',
    uuid: 'EL-CORAL-RECT',
  });
  const cue2 = makeCueWithElements({
    name: 'Slide 2 - Coral on Black',
    uuid: 'CUE-CORE-2',
    drawsBackgroundColor: true,
    backgroundColor: { red: 0, green: 0, blue: 0, alpha: 1 },
    elements: [coralRect],
  });

  const tealBar = makeRectElement({
    x: 160,
    y: 820,
    w: 1600,
    h: 160,
    fill: { r: 0, g: 128, b: 128, a: 1 },
    name: 'Teal Lower-Third Bar',
    uuid: 'EL-TEAL-BAR',
  });
  const cue3 = makeCueWithElements({
    name: 'Slide 3 - Teal Lower-Third on Transparent',
    uuid: 'CUE-CORE-3',
    drawsBackgroundColor: false,
    elements: [tealBar],
  });

  const gradRect = makeGradientRectElement({
    x: 0,
    y: 0,
    w: 1920,
    h: 1080,
    gradient: {
      type: 'TYPE_LINEAR',
      angle: 0,
      stops: [
        { color: { r: 220, g: 40, b: 40, a: 1 }, position: 0 },
        { color: { r: 40, g: 80, b: 220, a: 1 }, position: 1 },
      ],
    },
    emptyRtf: true,
    name: 'Horizontal Gradient Rectangle',
    uuid: 'EL-GRAD-RECT',
  });
  const cue4 = makeCueWithElements({
    name: 'Slide 4 - Horizontal Linear Gradient on Transparent',
    uuid: 'CUE-CORE-4',
    drawsBackgroundColor: false,
    elements: [gradRect],
  });

  const presentationObj = {
    uuid: { string: 'SYNTH-CORE-UUID' },
    name: 'pro7-synth-core',
    cues: [cue1, cue2, cue3, cue4],
  };

  const proBytes = encodePro7Presentation(presentationObj);

  const ref1 = makePng(1920, 1080, () => [20, 40, 80, 255]);

  const ref2 = makePng(1920, 1080, (x, y) => {
    if (x >= 480 && x < 480 + 960 && y >= 270 && y < 270 + 540) {
      return [255, 127, 80, 255];
    }
    return [0, 0, 0, 255];
  });

  const ref3 = makePng(1920, 1080, (x, y) => {
    if (x >= 160 && x < 160 + 1600 && y >= 820 && y < 820 + 160) {
      return [0, 128, 128, 255];
    }
    return [0, 0, 0, 0];
  });

  const ref4 = makePng(1920, 1080, (x) => {
    const t = x / 1919;
    const r = Math.round(220 + (40 - 220) * t);
    const g = Math.round(40 + (80 - 40) * t);
    const b = Math.round(40 + (220 - 40) * t);
    return [r, g, b, 255];
  });

  const proFileName = 'pro7-synth-core.pro';
  const files = new Map<string, Uint8Array>([[proFileName, proBytes]]);

  const coreDeck: SyntheticDeck = {
    name: 'pro7-synth-core',
    proFileName,
    files,
    referenceSlides: [ref1, ref2, ref3, ref4],
  };

  // -------------------------------------------------------------
  // Deck 1: pro7-synth-shapes (3 slides)
  // -------------------------------------------------------------
  const darkBg = { red: 15 / 255, green: 20 / 255, blue: 30 / 255, alpha: 1 };

  const ellipseEl = makeEllipseElement({
    x: 660,
    y: 240,
    w: 600,
    h: 600,
    fill: { r: 240, g: 180, b: 40, a: 1 },
    name: 'Yellow Ellipse',
    uuid: 'EL-SHAPES-ELLIPSE',
  });
  const shapesCue1 = makeCueWithElements({
    name: 'Slide 1 - Yellow Ellipse',
    uuid: 'CUE-SHAPES-1',
    drawsBackgroundColor: true,
    backgroundColor: darkBg,
    elements: [ellipseEl],
  });

  const roundedRectEl = makeRoundedRectElement({
    x: 460,
    y: 290,
    w: 1000,
    h: 500,
    roundness: 0.4,
    fill: { r: 60, g: 190, b: 130, a: 1 },
    name: 'Green Rounded Rectangle',
    uuid: 'EL-SHAPES-ROUNDED-RECT',
  });
  const shapesCue2 = makeCueWithElements({
    name: 'Slide 2 - Green Rounded Rectangle',
    uuid: 'CUE-SHAPES-2',
    drawsBackgroundColor: true,
    backgroundColor: darkBg,
    elements: [roundedRectEl],
  });

  const diamondEl = makeCustomPathElement({
    x: 560,
    y: 140,
    w: 800,
    h: 800,
    points: [
      { point: { x: 0.5, y: 0 }, q0: { x: 0.5, y: 0 }, q1: { x: 0.5, y: 0 } },
      { point: { x: 1, y: 0.5 }, q0: { x: 1, y: 0.5 }, q1: { x: 1, y: 0.5 } },
      { point: { x: 0.5, y: 1 }, q0: { x: 0.5, y: 1 }, q1: { x: 0.5, y: 1 } },
      { point: { x: 0, y: 0.5 }, q0: { x: 0, y: 0.5 }, q1: { x: 0, y: 0.5 } },
    ],
    closed: true,
    fill: { r: 180, g: 90, b: 230, a: 1 },
    name: 'Purple Diamond',
    uuid: 'EL-SHAPES-DIAMOND',
  });
  const shapesCue3 = makeCueWithElements({
    name: 'Slide 3 - Purple Diamond',
    uuid: 'CUE-SHAPES-3',
    drawsBackgroundColor: true,
    backgroundColor: darkBg,
    elements: [diamondEl],
  });

  const shapesPresObj = {
    uuid: { string: 'SYNTH-SHAPES-UUID' },
    name: 'pro7-synth-shapes',
    cues: [shapesCue1, shapesCue2, shapesCue3],
  };

  const shapesProBytes = encodePro7Presentation(shapesPresObj);
  const shapesProFileName = 'pro7-synth-shapes.pro';
  const shapesFiles = new Map<string, Uint8Array>([[shapesProFileName, shapesProBytes]]);

  const shapesRef1 = makePng(1920, 1080, (x, y) => {
    const cx = 960;
    const cy = 540;
    const R = 300;
    const cov = Math.max(0, Math.min(1, R + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
    const r = Math.round(15 + (240 - 15) * cov);
    const g = Math.round(20 + (180 - 20) * cov);
    const b = Math.round(30 + (40 - 30) * cov);
    return [r, g, b, 255];
  });

  const shapesRef2 = makePng(1920, 1080, (x, y) => {
    const qx = Math.max(0, Math.abs(x + 0.5 - 960) - (500 - 100));
    const qy = Math.max(0, Math.abs(y + 0.5 - 540) - (250 - 100));
    const dist = Math.hypot(qx, qy) - 100;
    const cov = Math.max(0, Math.min(1, 0.5 - dist));
    const r = Math.round(15 + (60 - 15) * cov);
    const g = Math.round(20 + (190 - 20) * cov);
    const b = Math.round(30 + (130 - 30) * cov);
    return [r, g, b, 255];
  });

  const shapesRef3 = makePng(1920, 1080, (x, y) => {
    const d = (Math.abs(x + 0.5 - 960) + Math.abs(y + 0.5 - 540) - 400) / Math.SQRT2;
    const cov = Math.max(0, Math.min(1, 0.5 - d));
    const r = Math.round(15 + (180 - 15) * cov);
    const g = Math.round(20 + (90 - 20) * cov);
    const b = Math.round(30 + (230 - 30) * cov);
    return [r, g, b, 255];
  });

  const shapesDeck: SyntheticDeck = {
    name: 'pro7-synth-shapes',
    proFileName: shapesProFileName,
    files: shapesFiles,
    referenceSlides: [shapesRef1, shapesRef2, shapesRef3],
  };

  // -------------------------------------------------------------
  // Deck 3: pro7-synth-masks-and-crops (3 slides)
  // -------------------------------------------------------------
  const gradRect315 = makeGradientRectElement({
    x: 0,
    y: 0,
    w: 1920,
    h: 1080,
    gradient: {
      type: 'TYPE_LINEAR',
      angle: 315,
      stops: [
        { color: { r: 30, g: 180, b: 140, a: 1 }, position: 0 },
        { color: { r: 220, g: 120, b: 40, a: 1 }, position: 1 },
      ],
    },
    emptyRtf: true,
    name: 'Diagonal 315° Linear Gradient Rectangle',
    uuid: 'EL-MASKS-GRAD-RECT',
  });
  const masksCue1 = makeCueWithElements({
    name: 'Slide 1 - Diagonal 315° Linear Gradient',
    uuid: 'CUE-MASKS-1',
    drawsBackgroundColor: false,
    elements: [gradRect315],
  });

  const quadrantsPng = encodePng(
    makePng(200, 200, (x, y) => {
      if (x < 100 && y < 100) return [220, 50, 50, 255]; // Red
      if (x >= 100 && y < 100) return [50, 200, 80, 255]; // Green
      if (x < 100 && y >= 100) return [50, 90, 220, 255]; // Blue
      return [230, 200, 40, 255]; // Yellow
    }),
  );

  const croppedMediaEl = makeMediaElement({
    x: 480,
    y: 270,
    w: 960,
    h: 540,
    mediaPath: 'Media/quadrants.png',
    shapeType: 'TYPE_RECTANGLE',
    crop: { left: 0, top: 0, right: 0.5, bottom: 0.5 },
    scaleBehavior: 'SCALE_BEHAVIOR_STRETCH',
    name: 'Cropped Quadrants Media',
    uuid: 'EL-MASKS-CROPPED-MEDIA',
  });
  const masksCue2 = makeCueWithElements({
    name: 'Slide 2 - Cropped Quadrants',
    uuid: 'CUE-MASKS-2',
    drawsBackgroundColor: true,
    backgroundColor: { red: 0, green: 0, blue: 0, alpha: 1 },
    elements: [croppedMediaEl],
  });

  const cyanPng = encodePng(makePng(128, 128, () => [40, 210, 220, 255]));

  const maskedMediaEl = makeMediaElement({
    x: 660,
    y: 240,
    w: 600,
    h: 600,
    mediaPath: 'Media/cyan.png',
    shapeType: 'TYPE_ELLIPSE',
    scaleBehavior: 'SCALE_BEHAVIOR_FILL',
    name: 'Ellipse Masked Cyan Media',
    uuid: 'EL-MASKS-ELLIPSE-MEDIA',
  });
  const masksCue3 = makeCueWithElements({
    name: 'Slide 3 - Ellipse Masked Cyan',
    uuid: 'CUE-MASKS-3',
    drawsBackgroundColor: true,
    backgroundColor: darkBg,
    elements: [maskedMediaEl],
  });

  const masksPresObj = {
    uuid: { string: 'SYNTH-MASKS-UUID' },
    name: 'pro7-synth-masks-and-crops',
    cues: [masksCue1, masksCue2, masksCue3],
  };

  const masksProBytes = encodePro7Presentation(masksPresObj);
  const masksProFileName = 'pro7-synth-masks-and-crops.pro';
  const masksFiles = new Map<string, Uint8Array>([
    [masksProFileName, masksProBytes],
    ['Media/quadrants.png', quadrantsPng],
    ['Media/cyan.png', cyanPng],
  ]);

  const masksRef1 = makePng(1920, 1080, (x, y) => {
    // 45° linear gradient projection formula from paint.ts
    // Canvas pixel center at (x + 0.5, y + 0.5):
    // projection on vector (1500, 1500) from (210, -210) to (1710, 1290)
    // t = ((px - 210) * 1500 + (py + 210) * 1500) / (2 * 1500^2) = (px + py) / 3000
    const t = Math.max(0, Math.min(1, (x + y + 1) / 3000));
    const r = Math.round(30 + (220 - 30) * t);
    const g = Math.round(180 + (120 - 180) * t);
    const b = Math.round(140 + (40 - 140) * t);
    return [r, g, b, 255];
  });

  const masksRef2 = makePng(1920, 1080, (x, y) => {
    if (x >= 480 && x < 480 + 960 && y >= 270 && y < 270 + 540) {
      return [220, 50, 50, 255];
    }
    return [0, 0, 0, 255];
  });

  const masksRef3 = makePng(1920, 1080, (x, y) => {
    const cx = 960;
    const cy = 540;
    const R = 300;
    const cov = Math.max(0, Math.min(1, R + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
    const r = Math.round(15 + (40 - 15) * cov);
    const g = Math.round(20 + (210 - 20) * cov);
    const b = Math.round(30 + (220 - 30) * cov);
    return [r, g, b, 255];
  });

  const masksDeck: SyntheticDeck = {
    name: 'pro7-synth-masks-and-crops',
    proFileName: masksProFileName,
    files: masksFiles,
    referenceSlides: [masksRef1, masksRef2, masksRef3],
  };

  return [coreDeck, shapesDeck, masksDeck];
}

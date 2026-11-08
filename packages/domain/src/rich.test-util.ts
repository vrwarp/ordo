import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import type { Slide, TextObject } from './schemas.ts';

/*
 * A slide that uses every design/27 M2 field (rich text, origin, locked), for the schema compatibility
 * tests here and in @ordo/renderer.
 */

const white = { r: 255, g: 255, b: 255, a: 1 };

/** A PowerPoint-like body box: verse numbers as superscript runs, a numbered paragraph, office metrics. */
export function richText(): TextObject {
  return {
    id: 'body',
    type: 'text',
    box: { x: 120, y: 200, w: 1680, h: 700, rotation: 0 },
    text: '17 For God so loved the world\nthat he gave his only Son\nשָׁלוֹם',
    style: {
      ...DEFAULT_LYRIC_STYLE,
      fontFamily: 'Calibri',
      lineModel: 'office',
      insets: { l: 14, t: 7, r: 14, b: 7 },
      wrap: true,
      autofit: 'shrink',
      fitScale: { font: 0.925, spacing: 0.9 },
      justify: false,
      direction: 'auto',
      lang: 'en-GB',
      fallbackFonts: ['Carlito', 'Noto Sans Hebrew'],
      underline: false,
      glow: { radius: 6, color: { r: 255, g: 220, b: 0, a: 0.6 } },
    },
    opacity: 1,
    runs: [
      { start: 0, end: 3, baseline: 0.3, sizeScale: 0.8, color: { r: 200, g: 30, b: 30, a: 1 } },
      { start: 7, end: 10, fontWeight: 700, fontStyle: 'italic', underline: true },
      { start: 30, end: 34, caps: 'small', letterSpacing: 2, outline: null, shadow: null, lang: 'en' },
      { start: 56, end: 62, fontFamily: 'Noto Sans Hebrew', lang: 'he', highlight: white, strike: false },
    ],
    paras: [
      { align: 'left', level: 0, bullet: { auto: 'arabicParenBoth', startAt: 17, sizePct: 0.8 } },
      { soft: true, indentPx: 40, firstLinePx: -40, spaceBeforePx: 12, spaceAfterPx: 6, lineSpacing: 0.9 },
      { rtl: true, align: 'right', bullet: null, lineSpacingPx: 80, hidden: false },
    ],
    origin: { src: 'pptx', shapeId: 3, ph: 'body', role: 'body', group: 1 },
    locked: false,
  };
}

export function richSlide(): Slide {
  return {
    id: 'rich',
    objects: [
      {
        id: 'bg',
        type: 'shape',
        box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
        shape: 'rect',
        fill: { r: 10, g: 20, b: 60, a: 1 },
        opacity: 1,
        radius: 0,
        origin: { src: 'pptx', role: 'bg' },
      },
      {
        id: 'logo',
        type: 'image',
        box: { x: 1700, y: 40, w: 160, h: 90, rotation: 0 },
        mediaId: 'logo-media',
        fit: 'contain',
        opacity: 1,
        radius: 0,
        origin: { src: 'pptx', shapeId: 9, role: 'deco' },
        locked: true,
      },
      richText(),
    ],
    lyricObjectId: 'body',
  };
}

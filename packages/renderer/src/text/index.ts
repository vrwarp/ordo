/** ordo's text engine (design/27 §6): the public surface. README.md describes the pipeline. */
export type { FaceRequest, FontEnv, LaidLine, Measurer, RichLayout, Seg } from './types.ts';
export { RICH_STYLE_KEYS, clampTextObject, drawRichText, isRichText, layoutRich } from './rich.ts';
export { paintRich } from './paint.ts';
export { FontResolver, LEGACY_FONT_ENV, currentFontEnv, installFontEnv } from './fonts.ts';
export { WidthCache, canvasMeasurer, measurerFor } from './measure.ts';
export { firstStrong, hasStrongRtl } from './bidi.ts';

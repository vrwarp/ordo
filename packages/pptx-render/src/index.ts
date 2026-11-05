export { type Annotation, annotatePptx, type RunStyle, type TextShadow } from './annotate.ts';
export {
  type PreviewOptions,
  type PreviewResult,
  pptxPreviewBundle,
  renderWithPptxPreview,
} from './chromium.ts';
export { fontFallbacks } from './fonts.ts';
export { decodeMarker, encodeMarker, MARK_ALPHABET, MARK_START, MAX_MARKED_RUNS } from './markers.ts';

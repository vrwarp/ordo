import type { Slide } from '@ordo/domain';

export type RgbaImage = {
  width: number;
  height: number;
  /** Straight RGBA, length = width * height * 4. */
  data: Uint8Array;
};

export type Pro7FeatureTag =
  | 'gradientFill'
  | 'docBackground'
  | 'drawsBgColor'
  | 'textLineMask'
  | 'emptyRtfShape'
  | 'elShadow'
  | 'textShadow'
  | 'elFeather'
  | 'strokeBorder'
  | 'customPath'
  | 'nonRectShape'
  | 'mediaFill'
  | 'mediaCrop'
  | 'customImageBounds'
  | 'videoBg'
  | 'transparentPlate'
  | 'rtfMixedRuns'
  | 'rtfBullets'
  | 'rtfOutline'
  | 'textMargins'
  | 'textScaleToFit'
  | 'untitledDoc';

export type SlideDiagnosticSource = {
  slideNumber: number; // 1-based
  cueUuid?: string;
  cueName?: string;
  features: Pro7FeatureTag[];
  /** Sanitized raw protobuf cue/slide structure for subagent inspection. */
  pro7SlideJson: Record<string, unknown>;
};

export type BoxMae = {
  objectId: string;
  type: string;
  box: { x: number; y: number; w: number; h: number };
  mae: number;
};

export type SlideScore = {
  n: number; // 1-based slide index
  ssim: number;
  ssimBlack?: number;
  ssimWhite?: number;
  transparentRef: boolean;
  overallMae: number;
  backgroundMae: number;
  alphaMae: number;
  boxMaes: BoxMae[];
  features: Pro7FeatureTag[];
  refPngPath: string;
  ordoPngPath: string;
  ms1920?: number;
};

export type DeckScore = {
  name: string;
  kind: 'sample' | 'synthetic';
  title: string;
  slideCount: number;
  ssim: number;
  minSlideSsim: number;
  perSlide: SlideScore[];
  importNotes: string[];
};

export type FeatureCluster = {
  feature: Pro7FeatureTag;
  slideCount: number;
  meanSsim: number;
  recoverableGain: number;
  worstSlide: { deck: string; n: number; ssim: number };
};

export type SummaryReport = {
  createdAt: string;
  exportCompat: boolean;
  meanSsim: number;
  sampleMeanSsim?: number;
  syntheticMeanSsim?: number;
  totalSlides: number;
  decks: DeckScore[];
  clusters: FeatureCluster[];
};

export type SlideRenderInput = {
  n: number;
  slide: Slide;
  presentationBackgroundMediaId?: string;
  source?: SlideDiagnosticSource;
  refPngPath: string;
};

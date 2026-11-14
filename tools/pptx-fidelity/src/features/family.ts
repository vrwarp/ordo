/**
 * One family of the feature registry (`index.ts`): features read from a deck's own XML for the report's
 * per-feature means (design/27 §14.1). Each family lives in a file of its own, so an M9 track adds its family
 * (`3d:*`, `textWarp:<mode>`, `centerBlock`, `vertText:<value>`, `chart:*`, …) as a file plus one line in
 * `index.ts`.
 */

/** What a family reads: one part's XML, and the parts that part names. */
export type FeatureSource = {
  /** The part's name (`ppt/slides/slide3.xml`, or `ppt/presentation.xml` for the deck's own features). */
  part: string;
  /** Its XML ('' when the part is missing or was too large to keep in memory). */
  xml: string;
  /**
   * The XML of the parts this one names through a relationship whose type ends with `typeSuffix`
   * (`/chart`, `/diagramData`): internal targets only, at most `MAX_RELATED` of them, '' for one not read.
   */
  related(typeSuffix: string): string[];
};

/** Related parts one `FeatureSource.related` call returns at most. */
export const MAX_RELATED = 16;

export type FeatureFamily<F extends string = string> = {
  /** The family's name; `text` is kept as `textFeatures` in `summary.json`, every other as `xmlFeatures`. */
  readonly key: string;
  /**
   * Its features in report order. A family whose names are open-ended (`textWarp:<mode>`) lists the ones it
   * knows; others it finds follow them in the report, sorted.
   */
  readonly features: readonly F[];
  /** A report target per feature (the text family's: pptx-preview's means, the M2 exit). */
  readonly targets?: Readonly<Partial<Record<F, number>>>;
  /** The features of one part, in any order. Linear in the XML and bounded; never throws on hostile XML. */
  detect(src: FeatureSource): string[];
};

/** A family, typed by its features. */
export const featureFamily = <const F extends string>(f: FeatureFamily<F>): FeatureFamily<F> => f;

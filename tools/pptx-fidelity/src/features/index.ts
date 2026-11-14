/**
 * The feature registry (design/27 §14.1): every family of features the harness reads from a deck's own XML,
 * in report order. Each family is a file of its own (`family.ts` `featureFamily`), listed once in
 * `FEATURE_FAMILIES` below: an M9 track adds its family with that file and one line here (plan §4).
 *
 * A slide's features are read from its own part (and the parts it names, `FeatureSource.related`), never from
 * its layout and master, which every stock template fills with features a deck may never show; a deck's are
 * the union of its slides' and those of the presentation part (`deckFeatures`), as the validation suite's
 * inventory read a deck. In `summary.json` the text family's are `textFeatures` (per slide and per deck, as
 * since M2) and every other family's `xmlFeatures`.
 */
import { type FeatureFamily, type FeatureSource, MAX_RELATED } from './family.ts';
import { text } from './text.ts';
import { relatedTargets, relsPartOf } from './xml.ts';

export type { FeatureFamily, FeatureSource } from './family.ts';
export { featureFamily, MAX_RELATED } from './family.ts';
export { M2_FEATURE_TARGETS, TEXT_FEATURES, type TextFeature, textFeatures } from './text.ts';

/** Every family, in report order. */
export const FEATURE_FAMILIES: readonly FeatureFamily[] = [text];

/** The features of a slide (or of the deck's presentation part), split as `summary.json` keeps them. */
export type Features = { textFeatures: string[]; xmlFeatures: string[] };

/**
 * Features in report order: those the families list, family by family, then any others found, sorted (an
 * open-ended family's `textWarp:<mode>` for a mode it does not list).
 */
function inOrder(families: readonly FeatureFamily[], found: Iterable<string>): string[] {
  const all = new Set(found);
  const out: string[] = [];
  for (const f of families) for (const k of f.features) if (all.has(k) && !out.includes(k)) out.push(k);
  for (const k of [...all].sort()) if (!out.includes(k)) out.push(k);
  return out;
}

const isText = (f: FeatureFamily) => f.key === 'text';

/** Every family's features of one part; a family that throws (it must not) adds nothing. */
export function partFeatures(src: FeatureSource, families = FEATURE_FAMILIES): Features {
  const text: string[] = [];
  const xml: string[] = [];
  for (const f of families) {
    let got: string[] = [];
    try {
      got = f.detect(src);
    } catch {
      /* a family must never throw on deck XML; if one does, it reports nothing for this part */
    }
    (isText(f) ? text : xml).push(...got);
  }
  return {
    textFeatures: inOrder(families.filter(isText), text),
    xmlFeatures: inOrder(
      families.filter((f) => !isText(f)),
      xml,
    ),
  };
}

/** A deck's features: the union of its slides' and of its presentation part's, in report order. */
export function deckFeatures(
  slides: Iterable<Features>,
  presentation: Features,
  families = FEATURE_FAMILIES,
): Features {
  const text = new Set(presentation.textFeatures);
  const xml = new Set(presentation.xmlFeatures);
  for (const s of slides) {
    for (const k of s.textFeatures) text.add(k);
    for (const k of s.xmlFeatures) xml.add(k);
  }
  return {
    textFeatures: inOrder(families.filter(isText), text),
    xmlFeatures: inOrder(
      families.filter((f) => !isText(f)),
      xml,
    ),
  };
}

/** The order the report lists `xmlFeatures` in (every family but the text one's). */
export const xmlFeatureOrder = (found: Iterable<string>, families = FEATURE_FAMILIES): string[] =>
  inOrder(
    families.filter((f) => !isText(f)),
    found,
  );

/**
 * A `FeatureSource` for `part` of a deck read into memory: `xml` reads a part's text ('' when it is missing),
 * and relationships come from the part's `.rels`.
 */
export function featureSource(part: string, xml: (name: string) => string): FeatureSource {
  return {
    part,
    xml: xml(part),
    related(typeSuffix) {
      return relatedTargets(part, xml(relsPartOf(part)), typeSuffix)
        .slice(0, MAX_RELATED)
        .map((t) => xml(t));
    },
  };
}

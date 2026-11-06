/**
 * Text features of a slide, read from its own XML (design/27 §15 M2 exit): the rules of the validation
 * suite's inventory (`superSub`, `lnSpcPct`, `normAutofitScaled`, `rtl`, `rtlScriptText`, `bulletsAuto`),
 * which gave pptx-preview's per-feature means the M2 exit compares with, and the census's `mixedRuns` (the
 * classifier's rule, `packages/pptx-scene/src/classify.ts`: runs of one text body whose explicit
 * properties differ beyond the neutral attributes).
 *
 * The inventory counted a deck's slide parts (and `ppt/presentation.xml`), never its layouts and masters,
 * which every stock template fills with features a deck may never show. A slide here is its own part only;
 * a deck is the union of its slides' features and the presentation part's (`deckTextFeatures`), as the
 * inventory read it.
 *
 * Linear scans of one part (at most 8 MB, `MAX_XML_PART_BYTES`); deck strings are only tested, never kept.
 */

/** The text features, in report order. */
export const TEXT_FEATURES = [
  'superSub',
  'lnSpcPct',
  'normAutofitScaled',
  'rtl',
  'rtlScriptText',
  'bulletsAuto',
  'mixedRuns',
] as const;
export type TextFeature = (typeof TEXT_FEATURES)[number];

/**
 * pptx-preview's mean SSIM (with ordo's corrections) on the worship decks of the validation suite, per
 * feature: what native has to reach for the M2 exit (design/27 §15 M2).
 */
export const M2_FEATURE_TARGETS: Readonly<Partial<Record<TextFeature, number>>> = {
  superSub: 0.61,
  lnSpcPct: 0.75,
  normAutofitScaled: 0.77,
  rtl: 0.71,
  rtlScriptText: 0.66,
};

/** The inventory's patterns (`pptx-suite/tools/inventory.py`), over the raw XML. */
const PATTERNS: readonly [TextFeature, RegExp][] = [
  ['superSub', /\sbaseline="-?[1-9]/],
  ['lnSpcPct', /<a:lnSpc><a:spcPct/],
  ['normAutofitScaled', /<a:normAutofit[^>]*fontScale=/],
  ['rtl', /\srtl="1"/],
  ['bulletsAuto', /<a:buAutoNum/],
];

/** Hebrew and Arabic letters in `a:t` text (the inventory's `rtlScriptText`). */
const RTL_SCRIPT = /[\u0590-\u06ff]/;
const TEXT_RUN = /<a:t>([^<]{1,2000})<\/a:t>/g;

/** Run attributes that do not change how a run looks (classify.ts `NEUTRAL_RUN_ATTRS`). */
const NEUTRAL_RUN_ATTRS: ReadonlySet<string> = new Set([
  'lang',
  'altLang',
  'dirty',
  'err',
  'noProof',
  'smtClean',
  'kern',
  'bmk',
]);

const RUN_PROPS = /<a:rPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:rPr>)/;
const RUN_TEXT = /<a:t>([^<]*)<\/a:t>/;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A run's look as the census keys it: its non-neutral attributes, sorted, and its children. */
function runKey(rPr: RegExpExecArray | null): string {
  if (!rPr) return '';
  const attrs: string[] = [];
  for (const m of (rPr[1] ?? '').matchAll(ATTR)) {
    const name = m[1]!;
    if (!NEUTRAL_RUN_ATTRS.has(name.slice(name.indexOf(':') + 1))) attrs.push(`${name}=${m[2] ?? m[3]}`);
  }
  return `${attrs.sort().join(' ')}|${(rPr[2] ?? '').replace(/>\s+</g, '><').trim()}`;
}

/**
 * The contents of each `open ... close` element in `xml`, in order (no nesting). Linear: once a closing
 * tag is missing, no later element can be complete, so the scan stops.
 */
function* elements(xml: string, open: string, close: string): Generator<string> {
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    const end = xml.indexOf(close, start + open.length);
    if (end < 0) return;
    yield xml.slice(start + open.length, end);
    at = end + close.length;
  }
}

/** Whether runs with text in one text body differ in their explicit properties. */
function hasMixedRuns(body: string): boolean {
  let first: string | undefined;
  for (const inner of elements(body, '<a:r>', '</a:r>')) {
    if (!RUN_TEXT.exec(inner)?.[1]) continue;
    const key = runKey(RUN_PROPS.exec(inner));
    if (first === undefined) first = key;
    else if (key !== first) return true;
  }
  return false;
}

/** The text features of one part's XML, in `TEXT_FEATURES` order. */
export function textFeatures(xml: string): TextFeature[] {
  const found = new Set<TextFeature>();
  for (const [f, re] of PATTERNS) if (re.test(xml)) found.add(f);
  for (const m of xml.matchAll(TEXT_RUN))
    if (RTL_SCRIPT.test(m[1]!)) {
      found.add('rtlScriptText');
      break;
    }
  for (const body of elements(xml, '<p:txBody>', '</p:txBody>'))
    if (hasMixedRuns(body)) {
      found.add('mixedRuns');
      break;
    }
  return TEXT_FEATURES.filter((f) => found.has(f));
}

/** A deck's text features: its slides' and those of its presentation part, in `TEXT_FEATURES` order. */
export function deckTextFeatures(
  slides: Iterable<readonly string[]>,
  presentation: readonly string[],
): string[] {
  const all = new Set<string>(presentation);
  for (const s of slides) for (const f of s) all.add(f);
  return TEXT_FEATURES.filter((f) => all.has(f));
}

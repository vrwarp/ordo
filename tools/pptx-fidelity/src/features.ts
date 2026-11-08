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
 * Tags are found with `indexOf` and read only up to their own '>' within `MAX_TAG_CHARS`: a regular
 * expression that scans from every `<a:normAutofit` or `<a:rPr` to the next '>' is quadratic on a part
 * full of unclosed tags (0.6 MB took 8 s).
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

/** The inventory's patterns (`pptx-suite/tools/inventory.py`), over the raw XML; each one linear. */
const PATTERNS: readonly [TextFeature, RegExp][] = [
  ['superSub', /\sbaseline="-?[1-9]/],
  ['lnSpcPct', /<a:lnSpc><a:spcPct/],
  ['rtl', /\srtl="1"/],
  ['bulletsAuto', /<a:buAutoNum/],
];

/** The longest start tag read for its attributes; a longer one is not taken as a tag. */
const MAX_TAG_CHARS = 4_096;

/**
 * The attributes of each `<name ...>` start tag in `xml` (name followed by whitespace, '/' or '>'), up to
 * its own '>', and whether it closes itself. Linear: each tag is read once, at most `MAX_TAG_CHARS` long.
 */
function* startTags(
  xml: string,
  name: string,
): Generator<{ attrs: string; at: number; end: number; empty: boolean }> {
  const open = `<${name}`;
  let at = 0;
  // The next '>' found so far: starts before it share it, so each part of `xml` is searched once.
  let gt = -1;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    at = start + open.length;
    const next = xml.charCodeAt(at);
    // The name must end here (`<a:rPr` is not `<a:rPrX`).
    if (!(next === 0x3e || next === 0x2f || next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d))
      continue;
    if (gt < at) gt = xml.indexOf('>', at);
    if (gt < 0) return;
    if (gt - at > MAX_TAG_CHARS) continue;
    const empty = xml.charCodeAt(gt - 1) === 0x2f;
    yield { attrs: xml.slice(at, empty ? gt - 1 : gt), at: start, end: gt + 1, empty };
    at = gt + 1;
  }
}

/** The inventory's `<a:normAutofit[^>]*fontScale=`, read tag by tag. */
function hasScaledAutofit(xml: string): boolean {
  for (const t of startTags(xml, 'a:normAutofit')) if (t.attrs.includes('fontScale=')) return true;
  return false;
}

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

const RUN_TEXT = /<a:t>([^<]*)<\/a:t>/;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A run's first `a:rPr`: its attributes and its children (empty for `<a:rPr .../>`), else undefined. */
function runProps(run: string): { attrs: string; children: string } | undefined {
  for (const t of startTags(run, 'a:rPr')) {
    if (t.empty) return { attrs: t.attrs, children: '' };
    const close = run.indexOf('</a:rPr>', t.end);
    if (close < 0) return undefined;
    return { attrs: t.attrs, children: run.slice(t.end, close) };
  }
  return undefined;
}

/** A run's look as the census keys it: its non-neutral attributes, sorted, and its children. */
function runKey(rPr: { attrs: string; children: string } | undefined): string {
  if (!rPr) return '';
  const attrs: string[] = [];
  for (const m of rPr.attrs.matchAll(ATTR)) {
    const name = m[1]!;
    if (!NEUTRAL_RUN_ATTRS.has(name.slice(name.indexOf(':') + 1))) attrs.push(`${name}=${m[2] ?? m[3]}`);
  }
  return `${attrs.sort().join(' ')}|${rPr.children.replace(/>\s+</g, '><').trim()}`;
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
    const key = runKey(runProps(inner));
    if (first === undefined) first = key;
    else if (key !== first) return true;
  }
  return false;
}

/** The text features of one part's XML, in `TEXT_FEATURES` order. */
export function textFeatures(xml: string): TextFeature[] {
  const found = new Set<TextFeature>();
  for (const [f, re] of PATTERNS) if (re.test(xml)) found.add(f);
  if (hasScaledAutofit(xml)) found.add('normAutofitScaled');
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

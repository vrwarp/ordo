/**
 * The slide's JSON budget (design/27 §3.4; M6 round 2; split out of `emit.ts` in M9, `conv-seams`; the
 * converter's steps of M9's budget ladder, `ladder`): what a slide is as the hub stores it
 * (`storedSlideBytes`), its large geometries moved into geometry files (`fitBytes`), the text formatting it
 * may hold (`chargeText`: every rich text object made lossless-compact first, `compactRuns`, then counted
 * against `TEXT_BUDGET_BYTES`, past which the slide's further text is written plain), and whether the slide
 * is over `MAX_SLIDE_BYTES` all the same (`slideBudget`: `EmittedSlide.overBudget`).
 *
 * Since M9 no budget makes a slide picture class (plan decision 3): the importer fits a slide that is still
 * over (`@ordo/domain` `fitSlideBudget`: grid, plain, minimal), and the class stays what its elements make it.
 *
 * Pure: slides in, sizes out; `fitBytes` changes the slide's geometries in place, `compactRuns` a text object's
 * runs.
 */
import type { GeomFile, ShapeGeom, Slide, SlideObject, TextObject, TextRun, TextStyle } from '@ordo/domain';
import { type EmitCtx, utf8Bytes } from './emit-ctx.ts';

/**
 * A geometry whose paths take more than this many characters of a slide's JSON (its own times the times the
 * slide draws it) is written in a geometry file (`ShapeGeom.ref`, M6 round 2). Smaller ones stay inline
 * unless the slide comes within 4 KB of `MAX_SLIDE_BYTES` with them: then the largest go to files too.
 */
export const GEOM_FILE_CHARS = 2_048;

/**
 * A slide's JSON budget (design/27 §3.4: 64 KB). A slide over it as stored (`storedSlideBytes`, with its
 * large geometries in files) is flagged (`EmittedSlide.overBudget`) for the importer's budget ladder, which
 * re-grids, simplifies or thins it until it fits (M9; before M9 it became a picture slide).
 */
export const MAX_SLIDE_BYTES = 64 * 1024;

/**
 * The text a slide's text objects may hold with their formatting (their JSON, text included): twice
 * `MAX_SLIDE_BYTES`, so the importer's ladder chooses which formatting a slide over its budget keeps (the
 * largest goes first, `fitSlideBudget`), while a deck whose layouts repeat thousands of formatted runs on
 * every slide still never builds megabytes per slide: past it, the slide's further text is written plain.
 */
export const TEXT_BUDGET_BYTES = 2 * MAX_SLIDE_BYTES;

/** The note a slide gets when it passes `TEXT_BUDGET_BYTES` (an importer that logs the budget itself drops it). */
export const SLIDE_BUDGET_NOTE = `the slide has more than ${TEXT_BUDGET_BYTES / 1024} KB of text formatting: its further text is written without it`;

/**
 * The note a slide gets when it is over `MAX_SLIDE_BYTES` as the hub stores it (`storedSlideBytes`) with
 * its large geometries in files (an importer that logs the budget itself drops it, as `SLIDE_BUDGET_NOTE`).
 */
export const SLIDE_BYTES_NOTE = `the slide is more than ${MAX_SLIDE_BYTES / 1024} KB as stored, with its shape outlines in files: it is simplified to fit`;

/** What `storedSlideBytes` adds for a slide's provenance (`Slide.pptx` without notes) and as a margin. */
const PROVENANCE_BYTES = 400;

/** Characters of an id as the hub writes it (a ULID) and of a geometry file's name (a SHA-256 in hex). */
const STORED_ID_CHARS = 26;
const STORED_REF_CHARS = 64;

/**
 * Geometries go to files until the slide is this far within `MAX_SLIDE_BYTES`: room for what the hub adds
 * that the converter does not know (speaker notes, timing, a transition).
 */
const SLIDE_BYTES_ROOM = 4 * 1024;

/** `"ref":"<64>"` and the two braces of a file's JSON (`{"paths":…}`) it no longer has around its paths. */
const REF_JSON_BYTES = 7 + STORED_REF_CHARS + 2;

/** The provenance notes the hub keeps per slide (`Slide.pptx.notes`), each cut to 200 characters. */
const STORED_NOTES = 16;
const STORED_NOTE_CHARS = 200;

/** A geometry in a slide's objects: its owner's field (`ShapeObject.geom`, `ImageObject.mask`) and its JSON. */
type GeomSite = { o: SlideObject; key: 'geom' | 'mask'; g: ShapeGeom; json: string };

/**
 * What a slide's JSON is as the hub stores it (`planImportSizes`'s size): its objects with ids of a ULID's
 * length and geometry files named by SHA-256, an origin on every object, and its provenance (`Slide.pptx`
 * with up to 16 of `notes`). An estimate a few hundred bytes over the hub's own, never under it.
 */
export function storedSlideBytes(slide: Slide, notes: readonly string[]): number {
  let n = utf8Bytes(JSON.stringify(slide)) + PROVENANCE_BYTES;
  const id = (v: unknown) => (typeof v === 'string' ? Math.max(0, STORED_ID_CHARS - v.length) : 0);
  n += id(slide.id) + id(slide.lyricObjectId);
  for (const o of slide.objects) {
    n += id(o.id);
    if (!o.origin) n += 24; // ,"origin":{"src":"pptx"}
    const g = o.type === 'shape' ? o.geom : o.type === 'image' ? o.mask : undefined;
    if (typeof g?.ref === 'string') n += Math.max(0, STORED_REF_CHARS - g.ref.length);
    // M9 (`decor-conv`): a decoration file is named by its SHA-256 too.
    const decor = o.type === 'shape' ? o.decor?.ref : undefined;
    if (typeof decor === 'string') n += Math.max(0, STORED_REF_CHARS - decor.length);
  }
  if (notes.length)
    n +=
      10 + utf8Bytes(JSON.stringify(notes.slice(0, STORED_NOTES).map((t) => t.slice(0, STORED_NOTE_CHARS))));
  return n;
}

/**
 * Moves a slide's large geometries into geometry files (`ref`, through `geomRef`; none without it): first
 * every geometry whose paths take more than `GEOM_FILE_CHARS` of the slide (its JSON times the times the
 * slide draws it), then, while the slide as stored (`storedSlideBytes`) passes `MAX_SLIDE_BYTES` less
 * `SLIDE_BYTES_ROOM`, the largest of the others whose paths are longer than a ref. Returns the slide's
 * stored size after it.
 */
export function fitBytes(
  slide: Slide,
  notes: readonly string[],
  geomRef: ((json: string, file: GeomFile) => string) | undefined,
): number {
  if (!geomRef) return storedSlideBytes(slide, notes);
  const sites: GeomSite[] = [];
  const times = new Map<string, number>();
  for (const o of slide.objects) {
    const key = o.type === 'shape' ? 'geom' : o.type === 'image' ? 'mask' : undefined;
    const g = key ? (o as { geom?: ShapeGeom; mask?: ShapeGeom })[key] : undefined;
    if (!key || !g?.paths?.length || g.ref !== undefined) continue;
    const json = JSON.stringify({ paths: g.paths });
    sites.push({ o, key, g, json });
    times.set(json, (times.get(json) ?? 0) + 1);
  }
  const toFile = (site: GeomSite) => {
    const { paths, ...rest } = site.g;
    const ref = geomRef(site.json, { paths: paths! });
    (site.o as { geom?: ShapeGeom; mask?: ShapeGeom })[site.key] = { ...rest, ref };
  };
  const rest: GeomSite[] = [];
  for (const site of sites)
    if (site.json.length * times.get(site.json)! > GEOM_FILE_CHARS) toFile(site);
    else rest.push(site);
  let bytes = storedSlideBytes(slide, notes);
  const target = MAX_SLIDE_BYTES - SLIDE_BYTES_ROOM;
  if (bytes <= target) return bytes;
  // `"ref":"<64>"` takes the place of `"paths":[…]` (the file's JSON less its braces): only longer paths
  // are worth a file. Counted as it goes, then measured once more.
  rest.sort((a, b) => b.json.length - a.json.length);
  let moved = false;
  for (const site of rest) {
    if (bytes <= target || site.json.length <= REF_JSON_BYTES + 16) break;
    toFile(site);
    bytes -= site.json.length - REF_JSON_BYTES;
    moved = true;
  }
  return moved ? storedSlideBytes(slide, notes) : bytes;
}

/**
 * The slide's budget once it is emitted (design/27 §3.4; `emit.ts`): its large geometries moved into files
 * (`fitBytes`, whatever its text holds) and whether it is over the budget all the same, its text formatting
 * past `TEXT_BUDGET_BYTES` or its JSON as stored past `MAX_SLIDE_BYTES` (noted, `SLIDE_BYTES_NOTE`). The
 * slide's class is not changed: the importer fits such a slide (`EmittedSlide.overBudget`).
 */
export function slideBudget(
  ctx: Pick<EmitCtx, 'textBytes' | 'log'>,
  slide: Slide,
  notes: readonly string[],
  geomRef: ((json: string, file: GeomFile) => string) | undefined,
): { over: boolean } {
  const stored = fitBytes(slide, notes, geomRef);
  const overBytes = stored > MAX_SLIDE_BYTES;
  if (overBytes) ctx.log(SLIDE_BYTES_NOTE);
  return { over: overText(ctx) || overBytes };
}

/** Whether the slide's text formatting has passed `TEXT_BUDGET_BYTES`: its further text is written plain. */
export function overText(ctx: Pick<EmitCtx, 'textBytes'>): boolean {
  return ctx.textBytes > TEXT_BUDGET_BYTES;
}

/**
 * Count a rich text object's JSON against the slide's text budget (`TEXT_BUDGET_BYTES`), made compact first
 * (`compactRuns`, lossless), noting the slide (`SLIDE_BUDGET_NOTE`) the moment it passes it. A slide already
 * past it counts nothing more.
 */
export function chargeText(ctx: Pick<EmitCtx, 'textBytes' | 'log'>, o: TextObject): void {
  compactRuns(o);
  if (overText(ctx)) return;
  ctx.textBytes += utf8Bytes(JSON.stringify(o));
  if (overText(ctx)) ctx.log(SLIDE_BUDGET_NOTE);
}

// ── compactRuns (M9 `ladder`, plan decision 14) ───────────────────────────────────────────────────────────

/** Font weights both the box style's and a run's clamps keep as they are (`@ordo/renderer` `clamp.ts`). */
const PLAIN_WEIGHTS: ReadonlySet<number> = new Set([100, 200, 300, 400, 500, 600, 700, 800, 900]);
/** Letter spacing within both clamps' bounds. */
const SPACING_BOUND = 100;

const sameRgba = (a: unknown, b: unknown) => {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return x.r === y.r && x.g === y.g && x.b === y.b && x.a === y.a;
};

const sameOutline = (a: TextRun['outline'], b: TextStyle['outline']) =>
  a === null ? b === undefined : !!a && !!b && a.width === b.width && sameRgba(a.color, b.color);

/**
 * Only "no shadow" where the box has none: a run's own shadow equal to the box's still keeps the decorations
 * of its run apart (`paint.ts` joins an underline across runs only for the very same shadow), so dropping it
 * would join them.
 */
const sameShadow = (a: TextRun['shadow'], b: TextStyle['shadow']) => a === null && b === undefined;

/**
 * A text object's runs without the fields that say what the box style says already (plan decision 14: the
 * lossless step before `plain`), in place; returns `o`. A run field is dropped only when the run resolves to
 * the same value without it (`@ordo/renderer` `resolveRunStyle`): a family, weight, slant, letter spacing or
 * language equal to the box's (a language equal to the deck's, which the box carries), a scale of 1, the
 * box's colour (unless the box is painted with a gradient, which paints only runs without their own colour),
 * the box's underline, caps and outline (null where the box has none), no shadow where the box has none, no
 * strike, a zero baseline.
 *
 * Runs are never merged or removed, even when one is left with nothing but its range: the text engine cuts
 * its pieces at every run's ends (`segments.ts`), so a merge could move kerned glyphs and cluster cuts. The
 * layout of `o` is therefore exactly the same (`layoutRich`, tested). The converter writes each run as what
 * differs from its box already (`richtext.ts` `runDiff`), so on its own output this finds little; it keeps a
 * slide's budget honest wherever runs carry the box's values (an older converter's, a hand-made deck's).
 */
export function compactRuns(o: TextObject): TextObject {
  const runs = o.runs;
  if (!Array.isArray(runs) || !runs.length) return o;
  const st = o.style;
  const caps = st.transform === 'uppercase' ? 'all' : 'none';
  for (const r of runs) {
    if (!r || typeof r !== 'object') continue;
    if (r.fontFamily !== undefined && r.fontFamily === st.fontFamily) delete r.fontFamily;
    if (r.fontWeight !== undefined && r.fontWeight === st.fontWeight && PLAIN_WEIGHTS.has(r.fontWeight))
      delete r.fontWeight;
    if (r.fontStyle !== undefined && r.fontStyle === st.fontStyle) delete r.fontStyle;
    if (r.sizeScale === 1) delete r.sizeScale;
    if (r.color !== undefined && !st.paint && sameRgba(r.color, st.color)) delete r.color;
    if (r.underline !== undefined && r.underline === (st.underline ?? false)) delete r.underline;
    if (r.strike === false) delete r.strike;
    if (r.baseline === 0) delete r.baseline;
    if (
      r.letterSpacing !== undefined &&
      r.letterSpacing === st.letterSpacing &&
      Math.abs(r.letterSpacing) <= SPACING_BOUND
    )
      delete r.letterSpacing;
    if (r.caps !== undefined && r.caps === caps) delete r.caps;
    if (r.outline !== undefined && sameOutline(r.outline, st.outline)) delete r.outline;
    if (r.shadow !== undefined && sameShadow(r.shadow, st.shadow)) delete r.shadow;
    if (r.lang !== undefined && r.lang === (st.lang ?? '')) delete r.lang;
  }
  return o;
}

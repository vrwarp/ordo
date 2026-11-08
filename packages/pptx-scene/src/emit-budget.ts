/**
 * The slide's JSON budget (design/27 §3.4; M6 round 2; split out of `emit.ts` in M9, `conv-seams`): what a
 * slide is as the hub stores it (`storedSlideBytes`), its large geometries moved into geometry files
 * (`fitBytes`), the text formatting it may hold (`MAX_SLIDE_BYTES`, `chargeText`) and the picture class a
 * slide past it takes (`overBudget`). M9's budget ladder (`ladder`: the lossless `compactRuns` before the
 * `plain` level) grows here.
 *
 * Pure: slides in, sizes out; `fitBytes` changes the slide's geometries in place.
 */
import type { GeomFile, ShapeGeom, Slide, SlideObject, TextObject } from '@ordo/domain';
import { type EmitCtx, utf8Bytes } from './emit-ctx.ts';
import type { Classification } from './ir.ts';

/**
 * A geometry whose paths take more than this many characters of a slide's JSON (its own times the times the
 * slide draws it) is written in a geometry file (`ShapeGeom.ref`, M6 round 2). Smaller ones stay inline
 * unless the slide comes within 4 KB of `MAX_SLIDE_BYTES` with them: then the largest go to files too.
 */
export const GEOM_FILE_CHARS = 2_048;

/**
 * A slide's JSON budget (design/27 §3.4: hard 64 KB, else picture class). Rich text formatting (runs and
 * paragraph styles) is written while the slide's text objects stay within it; past it, the slide's further
 * text is written without its formatting and the slide is classed picture, so a deck whose layouts repeat
 * thousands of formatted runs on every slide never builds megabytes the hub would discard.
 */
export const MAX_SLIDE_BYTES = 64 * 1024;

/** The note a slide gets when it passes `MAX_SLIDE_BYTES` (an importer that logs the budget itself drops it). */
export const SLIDE_BUDGET_NOTE = `the slide has more than ${MAX_SLIDE_BYTES / 1024} KB of text formatting: its further text is written without it (picture class)`;

/**
 * The note a slide gets when it is over `MAX_SLIDE_BYTES` as the hub stores it (`storedSlideBytes`) with
 * its large geometries in files (an importer that logs the budget itself drops it, as `SLIDE_BUDGET_NOTE`).
 */
export const SLIDE_BYTES_NOTE = `the slide is more than ${MAX_SLIDE_BYTES / 1024} KB as stored, with its shape outlines in files (picture class)`;

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

/** A slide over `MAX_SLIDE_BYTES` (its text formatting, else its JSON as stored): picture class (design/27 §3.4), with why. */
export function overBudget(c: Classification, text = true): Classification {
  const reason = text
    ? `more than ${MAX_SLIDE_BYTES / 1024} KB of text formatting`
    : `more than ${MAX_SLIDE_BYTES / 1024} KB as stored`;
  return { ...c, class: 'picture', reasons: [...c.reasons.filter((r) => r !== reason), reason] };
}

/** Whether the slide's text formatting has passed `MAX_SLIDE_BYTES`: its further text is written plain. */
export function overText(ctx: Pick<EmitCtx, 'textBytes'>): boolean {
  return ctx.textBytes > MAX_SLIDE_BYTES;
}

/**
 * Count a rich text object's JSON against the slide's text budget (`MAX_SLIDE_BYTES`), noting the slide
 * (`SLIDE_BUDGET_NOTE`) the moment it passes it. A slide already past it counts nothing more.
 */
export function chargeText(ctx: Pick<EmitCtx, 'textBytes' | 'log'>, o: TextObject): void {
  if (overText(ctx)) return;
  ctx.textBytes += utf8Bytes(JSON.stringify(o));
  if (overText(ctx)) ctx.log(SLIDE_BUDGET_NOTE);
}

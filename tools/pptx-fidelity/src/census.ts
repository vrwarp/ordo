/**
 * Census (design/27 §15 M9): the tier, class and reasons of every shown slide of every deck, as the
 * converter of this checkout writes them and as the hub stores them, one JSON line per deck.
 *
 *   npx tsx tools/pptx-fidelity/src/census.ts --out census.jsonl <deck | folder>...
 *
 * Folders are searched with their subfolders for every PresentationML file (`DECK_RE`: .pptx, .pptm,
 * .ppsx, .ppsm, .potx, .potm). Each deck is converted in the harness's worker (`convertDeckIsolated`: the
 * pool's heap limit and timeout). A line holds:
 *
 * - `folder` (the path given), `deck` (its number in the run), `name` (below the folder), `ext`, `ms`;
 * - `slides`: per shown slide `n` (its shown number, as the harness's `--slides` numbers it), `i` (its
 *   index in the deck), `tier`, `class`, `reasons`, `objects`, `geom` (objects with a geometry), `refs`
 *   (geometries stored in files), `bytes` (the slide's JSON, in characters), `metafiles` (pictures waiting for
 *   LibreOffice), the slide budgets' work (M9, `decor-conv`; each only when not 0): `decors` (decoration
 *   objects, `ShapeObject.decor`), `sheets` (pictures drawn from a composite or an atlas sheet, `SHEET_PREFIX`),
 *   `culled` (elements not imported because they draw nothing on the slide: off it, or showing nothing; read
 *   from the converter's notes) and `plate` (objects past the slide's drawing budgets, drawn whole from
 *   geometry units on outputs and as their legacy shapes elsewhere, or without their effects: the converter's
 *   notes); what its legacy shapes draw (M9 leaf-legacy, `legacyColumns`; each only when not 0):
 *   `budgetLegacy` (objects the renderer's slide budget draws as their legacy shapes, every drawer without a
 *   geometry unit) and `legacyFills` (a filled legacy rect or ellipse over a built custom geometry that fills
 *   under half its box or whose share is unknown: what the census ratchet fails); and the hub's view of it (`hubClasses`, M9's budget ladder):
 *   `stored` (the slide as the hub stores it; 0 for a picture slide), `hub` (its class once the hub's §3.4
 *   budgets ran: hybrid when the ladder left something out, never a picture for its size), `hubWhy` (why the
 *   ladder changed it: `slide` over 64 KB, `presentation` for the tail, `geoms` for its outline files; null
 *   otherwise), `level` (the ladder's level when not `full`) and `missing` (what nothing draws: the ladder's
 *   kinds, and with `--no-libreoffice` the converter's);
 * - `geomFiles`, `geomBytes`: the deck's geometry files; `maxObjects`: the most objects one shown slide has;
 * - `error` when the converter could not read the deck;
 * - `unreadable: 'missing target'` (and no slides) for a link whose deck is gone: listed, never an error.
 *
 * Decks are untrusted: nothing of them is printed but this file. A deck's name is in its line; tables made
 * from a census of private decks print counts only (`exit_tally.py`).
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BudgetLevel, Slide } from '@ordo/domain';
import { MIN_RECT_COVERAGE } from '@ordo/pptx-scene/emit.ts';
import { inkOf } from '@ordo/pptx-scene/geom.ts';
import { SHEET_PREFIX } from '@ordo/pptx-scene';
import { boxSide, storedPath } from '@ordo/renderer/geom/built.ts';
import { GEOM_LIMITS } from '@ordo/renderer/geom/ops.ts';
import type { GeomPath } from '@ordo/renderer/geom/path.ts';
import { clearGeomFiles, putGeomFile, resolvedGeom } from '@ordo/renderer/geom/stored.ts';
import { drawableContent } from '@ordo/renderer/content.ts';
import { slideBudget } from '@ordo/renderer/geombudget.ts';
import { slideUnitsLeft } from '@ordo/renderer/units.ts';
import { PPTX_LIMITS } from '../../../apps/hub/src/pptx/shared.ts';
import { listDecks } from './decks.ts';
import { convertDeckIsolated, type HubWhy, hubLadder, type NativeDeck } from './native.ts';

export type { HubWhy } from './native.ts';

export type HubSlide = {
  /** The slide's bytes as the hub stores it (its provenance included); 0 for a slide the converter classed picture. */
  stored: number;
  /** Its class in the hub: picture only when the converter said so; hybrid when the ladder left something out. */
  hub: 'native' | 'hybrid' | 'picture';
  /** Why the budget ladder changed it (`native.ts` `HubWhy`); null when stored as emitted (or only re-gridded). */
  hubWhy: HubWhy | null;
  /** The ladder's level (`fitSlideBudget`). */
  level: BudgetLevel;
  /** What the ladder left out (`Slide.pptx.missing` kinds). */
  missing: string[];
  /** The slide as stored. */
  slide: Slide;
};

type HubInput = Pick<NativeDeck['slides'][number], 'class' | 'slide' | 'notes'> & { index?: number };

/**
 * Each slide as the hub's import stores it (`nativeJob.ts` `budget`, design/27 §3.4, M9's budget ladder,
 * `native.ts` `hubLadder`): the objects naming outline files past `PPTX_LIMITS.geomFileBytes` left out
 * (`geoms`), each slide fitted to 64 KB (`slide`) and the presentation's tail stored minimal (`presentation`);
 * no slide becomes a picture for its size (as a hub without LibreOffice stores them; one with LibreOffice keeps
 * its page for a slide over 64 KB stored plain or minimal, `ImportCore.pageForBudget`, which `--before hub`
 * measures). Slides in deck order, hidden ones included, as the hub plans them.
 */
export function hubClasses(
  slides: readonly HubInput[],
  geoms: readonly { id: string; file: unknown }[] = [],
  geomBudget: number = PPTX_LIMITS.geomFileBytes,
): HubSlide[] {
  return hubLadder(slides, geoms, geomBudget).map((h) => ({
    stored: h.stored,
    hub: h.hub,
    hubWhy: h.why,
    level: h.level,
    missing: h.missing,
    slide: h.slide,
  }));
}

/** The count a converter note starts with when it matches `re` (summed over the notes), else 0. */
function noted(notes: readonly string[], re: RegExp): number {
  let n = 0;
  for (const note of notes) {
    const m = re.exec(note);
    if (m) n += Number(m[1]);
  }
  return n;
}

/**
 * What the slide budgets did to a slide (M9, `decor-conv`): its decorations, the pictures drawn from sheets,
 * the elements culled and the objects past its drawing budgets (`emit.ts` `fitDrawing`'s notes). Zeros left
 * out.
 */
export function budgetColumns(
  slide: Pick<Slide, 'objects'>,
  notes: readonly string[],
): Record<string, number> {
  const objects: Slide['objects'] = slide.objects ?? [];
  const out: Record<string, number> = {
    decors: objects.filter((o) => o.type === 'shape' && o.decor !== undefined).length,
    sheets: objects.filter((o) => o.type === 'image' && o.mediaId.startsWith(SHEET_PREFIX)).length,
    culled:
      noted(notes, /^(\d+) element\(s\) outside the slide are not imported$/) +
      noted(notes, /^(\d+) shape\(s\) that show nothing are not imported$/),
    // Both notes of `emit.ts` `fitDrawing`: drawn whole from geometry units, and drawn without their effects.
    plate: noted(notes, /^(\d+) object\(s\) past the slide's drawing budget are drawn /),
  };
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

/**
 * A stored geometry's paths at its box (`geombudget`'s drawers build them so: a `cont` piece appended to the
 * path before it), without the drawing budget's cut (`pathsGeometry` builds nothing past `GEOM_COST.geometry`),
 * so the census rates what a too-costly geometry would fill as well. Undefined for none (a preset, a file not
 * read).
 */
function storedPaths(o: { geom?: unknown; box: { w: number; h: number } }) {
  const g = resolvedGeom(o.geom as Parameters<typeof resolvedGeom>[0]);
  if (!g || typeof g.preset === 'string' || !Array.isArray(g.paths) || !g.paths.length) return undefined;
  const w = boxSide(o.box.w);
  const h = boxSide(o.box.h);
  const paths: GeomPath[] = [];
  for (const p of g.paths.slice(0, GEOM_LIMITS.paths)) {
    const path = storedPath(p, w, h);
    const prev = paths[paths.length - 1];
    if (p?.cont === true && prev)
      paths[paths.length - 1] = {
        ...prev,
        cmds: prev.cmds.concat(path.cmds),
        pts: prev.pts.concat(path.pts),
      };
    else paths.push(path);
  }
  return { w, h, paths };
}

/**
 * What a slide's legacy shapes draw (M9 leaf-legacy; design/27 §3.2 legacy values, §12 drawing cost), on the
 * slide as the converter emits it, with the deck's geometry files read (`putGeomFile`):
 * - `budgetLegacy`: the objects the renderer's slide budget (`geombudget.ts` `slideBudget`, as every drawer
 *   applies it) draws as their legacy shapes, without their geometry or mask: on outputs from geometry units,
 *   elsewhere as those shapes;
 * - `legacyFills`: the shapes whose legacy shape is a filled rect or ellipse over a built custom geometry
 *   (stored paths, its file's or its own; not a table's grid) whose even-odd ink (`geom.ts` `inkOf`, the converter's own measure)
 *   is under MIN_RECT_COVERAGE or cannot be worked out: the box of its fill an older build or a drawer past the
 *   budget draws over line art, which the converter must never write (`emit.ts`: a line). The ratchet fails it;
 * - `unitsLeft`: the objects the budget sends to legacy copies that get no geometry unit at 3840 on outputs
 *   (`units.ts` `slideUnitsLeft`: a plain shape past it for its paint, a masked picture, past the slide's unit
 *   area), drawn there as their legacy shapes until effect units; `unitsAlone` those of them past
 *   `GEOM_COST.slide` alone (no task could draw one; for thin line art its legacy line draws nothing). The
 *   ratchet fails `unitsAlone` wherever it is (never drop) and reports `unitsLeft`.
 * Zeros left out.
 */
export function legacyColumns(slide: Pick<Slide, 'objects'>): Record<string, number> {
  const objects: Slide['objects'] = slide.objects ?? [];
  let budgetLegacy = 0;
  for (const [o, c] of slideBudget(objects)) {
    const lost =
      (o.type === 'shape' && o.geom !== undefined && !('geom' in c)) ||
      (o.type === 'image' && o.mask !== undefined && !('mask' in c));
    if (lost) budgetLegacy++;
  }
  let legacyFills = 0;
  for (const o of objects) {
    if (o.type !== 'shape' || (o.shape !== 'rect' && o.shape !== 'ellipse') || !(o.fill || o.gradient))
      continue;
    // A table's grid (`tables.ts`, origin role 'grid') stores its fills' cells as paths beside their bounding
    // box, which is its legacy shape by design (design/27 §3.2): no custom geometry.
    if (o.origin?.role === 'grid') continue;
    const g = storedPaths(o);
    if (!g) continue;
    const ink = inkOf(g);
    if (!(ink !== undefined && ink >= MIN_RECT_COVERAGE)) legacyFills++;
  }
  const left = budgetLegacy ? slideUnitsLeft(drawableContent(slide).objects, 2) : [];
  const unitsLeft = left.length;
  const unitsAlone = left.filter((w) => w === 'alone').length;
  const out: Record<string, number> = { budgetLegacy, legacyFills, unitsLeft, unitsAlone };
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

/** One deck's line of the census. */
export function censusRow(
  deck: NativeDeck,
  head: { folder: string; deck: number; name: string; ms: number },
  opts: { noLibreOffice?: boolean } = {},
): Record<string, unknown> {
  // `--no-libreoffice`: each slide as a hub without LibreOffice emits it (`EmitOptions.libreoffice: false`).
  const noLo = opts.noLibreOffice === true;
  const input = deck.slides.map((s) => ({
    class: (noLo ? s.noLoClass : undefined) ?? s.class,
    slide: (noLo ? s.noLoSlide : undefined) ?? s.slide,
    notes: s.notes,
    index: s.index,
  }));
  const hub = hubClasses(input, deck.geoms ?? []);
  // The deck's geometry files, read as a drawer reads them, for its legacy columns.
  clearGeomFiles();
  for (const g of deck.geoms ?? []) putGeomFile(g.id, g.file);
  const slides = deck.slides
    .map((s, k) => ({ s, h: hub[k]!, x: input[k]! }))
    .filter(({ s }) => s.shown !== undefined)
    .map(({ s, h, x }) => {
      const objects: Slide['objects'] = x.slide.objects ?? [];
      const missing = [...(noLo ? (s.missing ?? []) : [])];
      for (const m of h.missing) if (!missing.includes(m)) missing.push(m);
      return {
        n: s.shown! + 1,
        i: s.index,
        tier: s.tier,
        class: x.class,
        reasons: (noLo ? s.noLoReasons : undefined) ?? s.reasons,
        objects: objects.length,
        geom: objects.filter((o) => o.type === 'shape' && o.geom).length,
        refs: objects.filter(
          (o) => (o.type === 'shape' && o.geom?.ref) || (o.type === 'image' && o.mask?.ref),
        ).length,
        bytes: JSON.stringify(x.slide).length,
        ...(s.metafiles?.length && !noLo ? { metafiles: s.metafiles.length } : {}),
        ...budgetColumns(x.slide, s.notes),
        ...legacyColumns(x.slide),
        stored: h.stored,
        hub: h.hub,
        hubWhy: h.hubWhy,
        ...(h.level !== 'full' ? { level: h.level } : {}),
        ...(missing.length ? { missing } : {}),
      };
    });
  clearGeomFiles();
  const files = (deck.geoms ?? []).map((g) => JSON.stringify(g.file).length);
  return {
    ...head,
    ext: extname(head.name).slice(1).toLowerCase(),
    slides,
    geomFiles: files.length,
    geomBytes: files.reduce((a, b) => a + b, 0),
    maxObjects: slides.reduce((m, s) => Math.max(m, s.objects), 0),
    ...(deck.error ? { error: deck.error } : {}),
  };
}

/**
 * `--hub-budget` (M9): the hub columns model the hub's budget ladder (always so since M9; accepted so the
 * census takes the harness's flags); `--no-libreoffice`: the slides as a hub without LibreOffice emits and
 * stores them, with its parse's reasons where they differ (`NativeSlide.noLoReasons`: the guard's left-outs,
 * LibreOffice's art with it, are `missing:<kind>` without it).
 */
export type CensusArgs = { out: string; paths: string[]; hubBudget: boolean; noLibreOffice: boolean };

export function parseCensusArgs(argv: readonly string[]): CensusArgs {
  let out: string | undefined;
  const paths: string[] = [];
  let hubBudget = false;
  let noLibreOffice = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--hub-budget') hubBudget = true;
    else if (v === '--no-libreoffice') noLibreOffice = true;
    else if (v === '--out') {
      out = argv[++i];
      if (!out || out.startsWith('--')) throw new Error('--out needs a file');
    } else if (v === '--') continue;
    else if (v.startsWith('--')) throw new Error(`unknown option ${v}`);
    else paths.push(v);
  }
  if (!out)
    throw new Error(
      'usage: census.ts [--hub-budget] [--no-libreoffice] --out census.jsonl <deck | folder>...',
    );
  if (!paths.length) throw new Error('no decks: pass decks or folders');
  return { out, paths, hubBudget, noLibreOffice };
}

/**
 * Write the census of `paths` to `out` (JSON lines, one per deck, appended as each deck is read so a stopped
 * run keeps what it read). Returns the counts.
 */
export async function runCensus(
  paths: readonly string[],
  out: string,
  log: (line: string) => void = () => {},
  opts: { noLibreOffice?: boolean } = {},
): Promise<{ decks: number; unreadable: number; errors: number; slides: number }> {
  const decks = await listDecks(paths);
  await writeFile(out, '');
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'ordo-census-'));
  const counts = { decks: 0, unreadable: 0, errors: 0, slides: 0 };
  try {
    for (const [k, d] of decks.entries()) {
      const head = { folder: d.root, deck: k + 1, name: d.name };
      counts.decks++;
      if (!d.exists) {
        counts.unreadable++;
        const ext = extname(d.name).slice(1).toLowerCase();
        await appendFile(out, `${JSON.stringify({ ...head, ext, unreadable: 'missing target' })}\n`);
        continue;
      }
      const dir = join(scratch, String(k + 1));
      await mkdir(dir, { recursive: true });
      const t0 = performance.now();
      const deck = await convertDeckIsolated(d.file, dir, opts.noLibreOffice ? { noLibreOffice: true } : {});
      const row = censusRow(deck, { ...head, ms: Math.round(performance.now() - t0) }, opts);
      if (deck.error) counts.errors++;
      counts.slides += (row.slides as unknown[]).length;
      await appendFile(out, `${JSON.stringify(row)}\n`);
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      log(`${String(k + 1).padStart(4)} / ${decks.length}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return counts;
}

async function main(): Promise<void> {
  const a = parseCensusArgs(process.argv.slice(2));
  const c = await runCensus(a.paths, resolve(a.out), () => {}, { noLibreOffice: a.noLibreOffice });
  console.log(
    `census: ${c.decks} deck(s), ${c.slides} shown slide(s), ${c.unreadable} unreadable (missing target), ${c.errors} the converter could not read; ${resolve(a.out)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });

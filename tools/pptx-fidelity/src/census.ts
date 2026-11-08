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
 *   from the converter's notes) and `plate` (objects past the slide's drawing budgets, drawn from its
 *   decoration plate: the converter's note), and the hub's view of it (`hubClasses`): `stored` (the slide as the hub stores it,
 *   `storedSlideBytes`; 0 for a picture slide), `hub` (its class once the hub's §3.4 budgets ran) and
 *   `hubWhy` (why the hub made it a picture: `slide`, `presentation` or `geoms`; null otherwise);
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
import {
  compactSlideBytes,
  drawnGeomRefs,
  type ImportCompactReason,
  planImportSizes,
  type Slide,
  utf8Bytes,
} from '@ordo/domain';
import { SHEET_PREFIX, storedSlideBytes } from '@ordo/pptx-scene';
import { PPTX_LIMITS } from '../../../apps/hub/src/pptx/shared.ts';
import { listDecks } from './decks.ts';
import { convertDeckIsolated, type NativeDeck } from './native.ts';

/** Why the hub stores a slide as a picture once its budgets ran (`nativeJob.ts` `budget`). */
export type HubWhy = ImportCompactReason | 'geoms';

export type HubSlide = {
  /** The slide as the hub stores it (`storedSlideBytes`); 0 for a slide the converter classed picture. */
  stored: number;
  /** Its class in the hub: picture when the converter said so or a §3.4 budget made it compact. */
  hub: 'native' | 'hybrid' | 'picture';
  hubWhy: HubWhy | null;
};

type HubInput = Pick<NativeDeck['slides'][number], 'class' | 'slide' | 'notes'>;

/**
 * Each slide's class as the hub's import stores it (`nativeJob.ts` `budget`, design/27 §3.4): a slide whose
 * new geometry files would take the import past `PPTX_LIMITS.geomFileBytes` is a picture (`geoms`), then
 * `planImportSizes` over the slides as stored (`storedSlideBytes`) with their compact sizes
 * (`compactSlideBytes`) makes the slides over 64 KB (`slide`) and the presentation's tail (`presentation`)
 * pictures. Slides in deck order, hidden ones included, as the hub plans them.
 */
export function hubClasses(
  slides: readonly HubInput[],
  geoms: readonly { id: string; file: unknown }[] = [],
  geomBudget: number = PPTX_LIMITS.geomFileBytes,
): HubSlide[] {
  const fileBytes = new Map(geoms.map((g) => [g.id, utf8Bytes(JSON.stringify(g.file))]));
  const files = new Set<string>();
  let spent = 0;
  const overGeoms = slides.map((s) => {
    if (s.class === 'picture') return false;
    const fresh = drawnGeomRefs(s.slide).filter((r) => !files.has(r) && fileBytes.has(r));
    const bytes = fresh.reduce((n, r) => n + fileBytes.get(r)!, 0);
    if (spent + bytes > geomBudget) return true;
    for (const r of fresh) files.add(r);
    spent += bytes;
    return false;
  });
  const sizes = slides.map((s) => (s.class === 'picture' ? 0 : storedSlideBytes(s.slide, s.notes)));
  const plan = planImportSizes(
    sizes,
    slides.map((s) => compactSlideBytes(s.slide)),
  );
  return slides.map((s, i) => {
    const why: HubWhy | null = s.class === 'picture' ? null : overGeoms[i] ? 'geoms' : plan.reasons[i]!;
    return { stored: sizes[i]!, hub: s.class === 'picture' || why ? 'picture' : s.class, hubWhy: why };
  });
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
 * the elements culled and the objects past its drawing budgets (named for its decoration plate). Zeros left
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
    plate: noted(
      notes,
      /^(\d+) object\(s\) past the slide's drawing budget are drawn from its decoration plate/,
    ),
  };
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

/** One deck's line of the census. */
export function censusRow(
  deck: NativeDeck,
  head: { folder: string; deck: number; name: string; ms: number },
): Record<string, unknown> {
  const hub = hubClasses(deck.slides, deck.geoms ?? []);
  const slides = deck.slides
    .map((s, k) => ({ s, h: hub[k]! }))
    .filter(({ s }) => s.shown !== undefined)
    .map(({ s, h }) => {
      const objects: Slide['objects'] = s.slide.objects ?? [];
      return {
        n: s.shown! + 1,
        i: s.index,
        tier: s.tier,
        class: s.class,
        reasons: s.reasons,
        objects: objects.length,
        geom: objects.filter((o) => o.type === 'shape' && o.geom).length,
        refs: objects.filter(
          (o) => (o.type === 'shape' && o.geom?.ref) || (o.type === 'image' && o.mask?.ref),
        ).length,
        bytes: JSON.stringify(s.slide).length,
        ...(s.metafiles?.length ? { metafiles: s.metafiles.length } : {}),
        ...budgetColumns(s.slide, s.notes),
        stored: h.stored,
        hub: h.hub,
        hubWhy: h.hubWhy,
      };
    });
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

export type CensusArgs = { out: string; paths: string[] };

export function parseCensusArgs(argv: readonly string[]): CensusArgs {
  let out: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--out') {
      out = argv[++i];
      if (!out || out.startsWith('--')) throw new Error('--out needs a file');
    } else if (v === '--') continue;
    else if (v.startsWith('--')) throw new Error(`unknown option ${v}`);
    else paths.push(v);
  }
  if (!out) throw new Error('usage: census.ts --out census.jsonl <deck | folder>...');
  if (!paths.length) throw new Error('no decks: pass decks or folders');
  return { out, paths };
}

/**
 * Write the census of `paths` to `out` (JSON lines, one per deck, appended as each deck is read so a stopped
 * run keeps what it read). Returns the counts.
 */
export async function runCensus(
  paths: readonly string[],
  out: string,
  log: (line: string) => void = () => {},
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
      const deck = await convertDeckIsolated(d.file, dir);
      const row = censusRow(deck, { ...head, ms: Math.round(performance.now() - t0) });
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
  const c = await runCensus(a.paths, resolve(a.out));
  console.log(
    `census: ${c.decks} deck(s), ${c.slides} shown slide(s), ${c.unreadable} unreadable (missing target), ${c.errors} the converter could not read; ${resolve(a.out)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });

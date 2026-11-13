/**
 * The check of a scene parsed in the uploading browser (design/27 §2, §12; the regroup's import core): an
 * edit-role client controls every byte of `clientScene`, so the hub uses it only after this module accepted
 * it, and builds version 1 from it with the import core's steps (`nativeJob.ts`, `pptx-core.ts`) as for its
 * own parse. Any doubt means the hub parses the deck itself: a refusal is never an error of the import.
 *
 * - **Where**: the stored scene file is read, parsed and checked in the CPU pool (`pptx-client-scene`,
 *   `clientSceneTask`), never on the library's event loop, within `CLIENT_SCENE_LIMITS.bytes` (the route drops a
 *   larger `clientScene` part before it is stored, `routes.ts`) and the pool's heap and timeout.
 * - **What**: a zod schema with a bound on every list and string (`PptxClientSceneSchema`): the converter's
 *   version and stored M9 fields must be the hub's (`CONVERTER_VERSION`, `M9_WRITES`), and its LibreOffice
 *   state what the hub has; part names are at most `PPTX_LIMITS.partName` characters before any reaches the
 *   `pptx-lo` payload (`art`, `metafiles`, `listed`, the scan); each slide passes the domain's `Slide` schema
 *   and the hub builds from what that parse returns, never the raw object (it is sanitised and parsed again
 *   when version 1 is assembled); bake recipes, clips and art plans are
 *   checked field by field. Fields the hub does not use are dropped (`sheets`, `plate`).
 * - **Shape files**: every one is checked again as the pool's own are named (`geomFileOf`: re-tokenised,
 *   `GeomFile`, `GEOM_FILE_MAX_BYTES`) and re-hashed; a file whose name is not the hash of what it holds, or
 *   that is not storable, is dropped and the slides' refs to it removed (their shapes draw their geometry
 *   beside it, else their legacy form, as a batch's unusable file). At most `PPTX_LIMITS.geomFileBytes` of
 *   them in all.
 */
import { readFileSync, statSync } from 'node:fs';
import { GEOM_FILE_MAX_BYTES, ImageObject, MISSING_LIMITS, Slide } from '@ordo/domain';
import type { PptxClientScene } from '@ordo/importers';
import { geomFileOf, type NamedGeomFile } from '@ordo/importers/pptx-geoms.ts';
import { z } from 'zod';
import { CONVERTER_VERSION, M9_WRITES, PPTX_LIMITS } from './shared.ts';

const MiB = 1024 * 1024;

/**
 * The largest `clientScene` the hub takes (`bytes`): a larger part is dropped by the route, and the hub
 * parses the deck itself. An object so tests can lower it; read at each use.
 *
 * 32 MiB: the largest scene of 370 real decks (E, the 30 table decks and the suite's decks over 3 MB) is
 * 2.4 MB, 3.8 KB a slide at the median, so a 2,000-slide sermon series needs about 8 MB. The checked scene
 * comes back from the pool in one structured-clone message, deserialized on the library's event loop: about
 * 7 ms a MB (a 124 MB scene stalled the receiving thread 912 ms, the 2026-11-13 review), so at most about a
 * quarter of a second here, off-service only (imports are refused while a playlist is live, and GO runs in the
 * live process).
 */
export const CLIENT_SCENE_LIMITS = { bytes: 32 * MiB };

/** A checked scene: its shape files re-validated and re-hashed (their JSON as the store keeps it). */
export type CheckedScene = Omit<PptxClientScene, 'geomFiles'> & { geomFiles: NamedGeomFile[] };

export type ClientSceneTaskInput = {
  /** The stored scene file (absolute path). */
  file: string;
  /** Whether the hub has LibreOffice for this import (`nativeJob.ts` decides it first). */
  libreoffice: boolean;
  /** Tests set less. */
  maxBytes?: number;
};
export type ClientSceneTaskOutput = { scene: CheckedScene } | { refused: string };

const L = PPTX_LIMITS;
const MAX_SLIDES = L.slides;
const int = (max: number) => z.number().int().min(0).max(max);
const num = z.number().finite();
const str = (max: number) => z.string().max(max);
const part = z.string().min(1).max(L.partName);
const id = z.string().min(1).max(100);
const box = z.object({ x: num, y: num, w: num, h: num });
const rgba = z.object({ r: num, g: num, b: num, a: num });

const SlideRefS = z.object({
  index: int(MAX_SLIDES - 1),
  part,
  hidden: z.boolean(),
  shown: int(MAX_SLIDES).optional(),
});

const ScanS = z.object({
  pictures: z.array(part).max(L.pictures),
  picturesOver: int(1e9),
  metafiles: z.array(z.tuple([int(MAX_SLIDES), z.array(part).max(50)])).max(MAX_SLIDES),
  notes: z.array(z.tuple([int(MAX_SLIDES), z.string().max(1_000_000)])).max(MAX_SLIDES),
  loop: z.boolean(),
  clips: z.array(part).max(L.clips).optional(),
  clipsOver: int(1e9).optional(),
});

const ArtS = z.object({
  elements: z
    .array(z.object({ from: z.enum(['slide', 'layout', 'master']), shapeId: int(1e9), nth: int(1e6) }))
    .max(10_000),
  box,
  at: int(100_000),
  replaces: z.array(id).max(10_000),
  text: str(20_000),
  before: id.optional(),
});

const ClipS = z.object({
  role: z.enum(['play', 'sound', 'background', 'linked', 'missing']),
  kind: z.enum(['video', 'audio']),
  id: id.optional(),
  part: part.optional(),
  external: str(2_048).optional(),
  trim: z.object({ startMs: num.min(0), endCutMs: num.min(0) }).optional(),
  objectId: id.optional(),
  poster: ImageObject.optional(),
});

const EmittedSlideS = z.object({
  index: int(MAX_SLIDES - 1),
  shown: int(MAX_SLIDES).optional(),
  hidden: z.boolean(),
  slide: z.unknown(),
  classification: z
    .object({
      tier: str(16),
      class: z.enum(['native', 'hybrid', 'picture']),
      reasons: z.array(str(400)).max(500),
    })
    .passthrough(),
  digest: str(128),
  notes: z.array(str(1_000)).max(64),
  ms: num,
  art: ArtS.optional(),
  metafiles: z
    .array(z.object({ part, object: ImageObject, before: id.optional() }))
    .max(50)
    .optional(),
  overBudget: z.literal(true).optional(),
  clips: z
    .array(ClipS)
    .max(L.clips * 4)
    .optional(),
  missing: z
    .array(str(MISSING_LIMITS.chars + 20))
    .max(MISSING_LIMITS.entries * 4)
    .optional(),
  artText: str(20_000).optional(),
});

const RecolorS = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('grayscale') }),
  z.object({ kind: z.literal('biLevel'), threshold: num }),
  z.object({ kind: z.literal('duotone'), dark: rgba, light: rgba }),
  z.object({ kind: z.literal('clrChange'), from: rgba, to: rgba }),
  z.object({ kind: z.literal('lum'), bright: num, contrast: num }),
]);
const BakeS = z.object({
  recolor: z.array(RecolorS).max(16).optional(),
  tile: z
    .object({
      aspect: num.positive().max(1e4),
      w: num.positive().max(1e4),
      h: num.positive().max(1e4),
      x: num,
      y: num,
      flip: z.enum(['none', 'x', 'y', 'xy']),
      crop: z.object({ l: num, t: num, r: num, b: num }).optional(),
    })
    .optional(),
});

/** The scene as the hub takes it (see the module comment). */
export const PptxClientSceneSchema = z.object({
  version: z.number(),
  m9Writes: z.array(str(64)).max(64),
  oversized: z.array(part).max(1_000),
  fonts: int(1e6),
  scan: ScanS,
  listed: z.array(SlideRefS).min(1).max(MAX_SLIDES),
  sections: z
    .array(z.object({ name: str(1_000), slides: z.array(int(MAX_SLIDES)).max(MAX_SLIDES) }))
    .max(MAX_SLIDES),
  slideRect: box,
  notes: z.array(str(1_000)).max(1_000),
  slides: z.array(EmittedSlideS).max(MAX_SLIDES),
  media: z.array(z.object({ id: id, part, bake: BakeS.optional() })).max(L.pictures * 4),
  extras: z
    .array(
      z.object({
        index: int(MAX_SLIDES - 1),
        transition: z
          .union([
            z.object({ kind: z.literal('cut') }),
            z.object({ kind: z.literal('crossfade'), ms: num.min(0).max(60_000) }),
          ])
          .optional(),
        advanceMs: num.min(0).max(1e9).optional(),
        note: str(1_000).optional(),
      }),
    )
    .max(MAX_SLIDES),
  geomFiles: z.array(z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), json: z.string() })).max(100_000),
  geomOver: z.array(int(MAX_SLIDES)).max(MAX_SLIDES).optional(),
  libreoffice: z.literal(false).optional(),
});

/** The first problem of a refused parse, in a few words for the job log (no deck string in it). */
function why(e: z.ZodError): string {
  const i = e.issues[0];
  return i ? `${i.path.slice(0, 6).join('.') || 'scene'}: ${i.code}` : 'malformed';
}

/**
 * A scene as the hub takes it, or why not (see the module comment). Pure: the pool task reads the file and
 * calls it; tests and the fuzz call it directly. Never throws.
 */
export function checkClientScene(raw: unknown, o: { libreoffice: boolean }): ClientSceneTaskOutput {
  try {
    return check(raw, o);
  } catch {
    return { refused: 'malformed' };
  }
}

function check(raw: unknown, o: { libreoffice: boolean }): ClientSceneTaskOutput {
  if (!raw || typeof raw !== 'object') return { refused: 'not a scene' };
  const head = raw as { version?: unknown; m9Writes?: unknown; libreoffice?: unknown };
  if (head.version !== CONVERTER_VERSION) return { refused: 'parsed by another converter version' };
  const fields = Array.isArray(head.m9Writes) ? new Set(head.m9Writes) : undefined;
  if (!fields || fields.size !== M9_WRITES.size || [...M9_WRITES].some((f) => !fields.has(f)))
    return { refused: 'parsed with other stored fields' };
  // M9: the converter's plan (art, metafile conversions, the notes, what is listed as missing) depends on
  // whether LibreOffice is there (`EmitOptions.libreoffice`), so a scene parsed for the other case is not used.
  const sceneLo = head.libreoffice !== false;
  if (sceneLo !== o.libreoffice)
    return { refused: `parsed for a hub ${sceneLo ? 'with' : 'without'} LibreOffice` };
  const parsed = PptxClientSceneSchema.safeParse(raw);
  if (!parsed.success) return { refused: why(parsed.error) };
  const s = parsed.data;
  const n = s.listed.length;
  // Places and parts agree with the listing (as the hub's batches must, `batch`).
  if (s.listed.some((r, i) => r.index !== i)) return { refused: 'listed: out of order' };
  const seen = new Set<number>();
  // Each slide as the domain's schema parsed it, not the raw object: the schema fills defaults (`objects`)
  // and replaces bad values (`.catch`), so a raw slide it accepts can still be malformed for the steps that
  // build from it (`nameGeoms`, the budgets), which would then fail the import instead of falling back.
  const parsedSlides = new Map<number, Slide>();
  for (const sl of s.slides) {
    if (sl.index >= n || seen.has(sl.index)) return { refused: 'slides: index' };
    seen.add(sl.index);
    const ps = Slide.safeParse(sl.slide);
    // The converter writes every slide's objects: a slide without them is not one it wrote.
    const objects = (sl.slide as { objects?: unknown } | null)?.objects;
    if (!ps.success || !Array.isArray(objects) || objects.length !== ps.data.objects.length)
      return { refused: `slides.${sl.index}: not a slide` };
    parsedSlides.set(sl.index, ps.data);
  }
  for (const x of [...s.extras.map((e) => e.index), ...(s.geomOver ?? [])])
    if (x >= n) return { refused: 'index past the listing' };
  // Shape files: re-checked and re-hashed; at most the import's budget of them.
  const files: NamedGeomFile[] = [];
  let bytes = 0;
  const kept = new Set<string>();
  for (const g of s.geomFiles) {
    if (kept.has(g.hash) || g.json.length > 2 * GEOM_FILE_MAX_BYTES) continue;
    let json: unknown;
    try {
      json = JSON.parse(g.json);
    } catch {
      continue;
    }
    const f = geomFileOf(json);
    if (!f || f.hash !== g.hash || bytes + f.bytes.length > L.geomFileBytes) continue;
    bytes += f.bytes.length;
    kept.add(f.hash);
    files.push(f);
  }
  const { slides, ...rest } = s;
  const scene: CheckedScene = {
    ...rest,
    // Only what the hub reads of each slide: `sheets` and `plate` (M9 fields this hub does not use) dropped.
    slides: slides.map((sl) => ({
      ...sl,
      slide: parsedSlides.get(sl.index) as Slide,
    })) as PptxClientScene['slides'],
    geomFiles: files,
  };
  return { scene };
}

/** The pool task (`pptx-client-scene`): the stored scene read, parsed and checked off the event loop. */
export function clientSceneTask(input: ClientSceneTaskInput): ClientSceneTaskOutput {
  const max = input.maxBytes ?? CLIENT_SCENE_LIMITS.bytes;
  let text: string;
  try {
    if (statSync(input.file).size > max) return { refused: 'larger than a scene may be' };
    text = readFileSync(input.file, 'utf8');
  } catch {
    return { refused: 'the scene file could not be read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { refused: 'not JSON' };
  }
  return checkClientScene(raw, { libreoffice: input.libreoffice });
}

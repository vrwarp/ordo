/**
 * Worker side of the `pptx-scene` pool task (design/27 §2 step 2; M3 item B): one batch of slides through
 * `convertDeck`, on the CPU pool's bounded heap and timeout. Imported by `cpu.worker.ts` only; it must not
 * import the library, the store or anything else of the main thread.
 *
 * Object and slide ids are ULIDs (batches never collide); picture ids are `pptxmedia:<n>` per batch, which
 * the job maps to parts through `result.media` before it remaps them to stored media.
 *
 * - **Scan** (`input.scan`, the import's first call, no slide converted): the deck facts of `convertDeck`
 *   (slide list, frame, sections) and what the job needs before the batches: the picture parts the listed
 *   slides, their layouts, masters and themes relate to (the job spills only those), the metafiles each slide
 *   may show (LibreOffice converts them), speaker notes (`notes.ts`, read once here so no batch needs the
 *   notes parts) and the show's loop flag.
 * - **Batch**: the slides of `range`, plus each one's transition and timing (`transition.ts`), which
 *   `convertDeck` does not read: only the part's tail after `p:cSld` is parsed for it.
 */
import { getHeapStatistics } from 'node:v8';
import { newId } from '@ordo/domain';
import { type ConvertResult, convertDeck, type SlideRef } from '@ordo/pptx-scene';
import { readNotes } from '@ordo/pptx-scene/notes.ts';
import { openPackage, type Package, relType } from '@ordo/pptx-scene/opc.ts';
import { extensionOf, METAFILE_EXTENSIONS } from '@ordo/pptx-scene/picture.ts';
import { readSlideTransition, showLoops } from '@ordo/pptx-scene/transition.ts';
import {
  PPTX_LIMITS,
  type SceneScan,
  type SceneSlideExtra,
  type SceneTaskInput,
  type SceneTaskOutput,
} from './shared.ts';

/** Metafiles listed per slide (they are converted by part; more on one slide is a hostile deck). */
const MAX_METAFILES_PER_SLIDE = 50;

export function sceneTask(input: SceneTaskInput): SceneTaskOutput {
  const t0 = performance.now();
  const sizes = new Map(input.pictureSizes);
  const result = convertDeck(input.parts, {
    range: input.range,
    pictureSize: (part) => sizes.get(part),
    extendBackgrounds: input.options.extendBackgrounds ?? true,
    newId,
  });
  const out: SceneTaskOutput = { result, ms: 0, heapMb: 0 };
  if (input.scan) out.scan = scanDeck(openPackage(input.parts), result.listed);
  else if (result.slides.length) out.extras = extrasOf(openPackage(input.parts), result);
  out.ms = performance.now() - t0;
  out.heapMb = getHeapStatistics().used_heap_size / (1024 * 1024);
  return out;
}

type Images = { pictures: string[]; metafiles: string[] };

/** What the job needs of the whole deck before its batches (see the module comment). */
export function scanDeck(pkg: Package, listed: readonly SlideRef[]): SceneScan {
  const images = new Map<string, Images>();
  /** The image relationships of one part, by kind (cached: layouts and masters are shared). */
  const imagesOf = (part: string): Images => {
    let v = images.get(part);
    if (v) return v;
    v = { pictures: [], metafiles: [] };
    for (const r of pkg.rels(part)) {
      if (r.external || relType(r.type) !== 'image' || !pkg.has(r.target)) continue;
      const stored = pkg.find(r.target) ?? r.target;
      const ext = extensionOf(stored);
      if (METAFILE_EXTENSIONS.has(ext)) v.metafiles.push(stored);
      // Raw SVG is never used: the blip's PNG fallback is its own relationship (design/27 §4).
      else if (ext !== 'svg') v.pictures.push(stored);
    }
    images.set(part, v);
    return v;
  };
  const pictures = new Set<string>();
  let picturesOver = 0;
  const over = new Set<string>();
  const metafiles: [number, string[]][] = [];
  const notes: [number, string][] = [];
  for (const ref of listed) {
    const layout = pkg.relOfType(ref.part, 'slideLayout')?.target;
    const master = layout === undefined ? undefined : pkg.relOfType(layout, 'slideMaster')?.target;
    const theme = master === undefined ? undefined : pkg.relOfType(master, 'theme')?.target;
    const shown = new Set<string>();
    for (const part of [ref.part, layout, master, theme]) {
      if (part === undefined) continue;
      const own = imagesOf(part);
      for (const p of own.pictures) {
        if (pictures.has(p) || over.has(p)) continue;
        if (pictures.size < PPTX_LIMITS.pictures) pictures.add(p);
        else if (over.size < PPTX_LIMITS.pictures) {
          over.add(p);
          picturesOver++;
        } else picturesOver++;
      }
      // Theme parts hold no drawn shape: their metafiles are fills the parser does not draw either.
      if (part !== theme)
        for (const m of own.metafiles) if (shown.size < MAX_METAFILES_PER_SLIDE) shown.add(m);
    }
    if (shown.size) metafiles.push([ref.index, [...shown]]);
    const text = readNotes(pkg, ref.part);
    if (text) notes.push([ref.index, text]);
  }
  return { pictures: [...pictures], picturesOver, metafiles, notes, loop: showLoops(pkg) };
}

/** Each converted slide's transition and timing, read from its part's tail (`readSlideTransition`). */
function extrasOf(pkg: Package, result: ConvertResult): SceneSlideExtra[] {
  const out: SceneSlideExtra[] = [];
  for (const s of result.slides) {
    const part = result.listed[s.index]?.part;
    if (part === undefined) continue;
    const t = readSlideTransition(pkg, part);
    if (t.transition || t.advanceMs !== undefined) out.push({ index: s.index, ...t });
  }
  return out;
}

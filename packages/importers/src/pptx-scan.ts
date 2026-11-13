/**
 * The deck scan of a native PowerPoint import (design/27 §2 step 2), the import core's one copy: the hub's
 * pool task (`apps/hub/src/pptx/sceneTask.ts`), the client parse (`pptx-client.ts`) and the fidelity harness
 * read a deck's facts with the same functions, so a scene parsed in a browser lists what the hub's own parse
 * lists. Pure TypeScript over `@ordo/pptx-scene`'s package reader: runs in Node, browsers and Web Workers.
 *
 * - **Limits** (`PPTX_IMPORT_LIMITS`, design/27 §12): what one import may read, spill and create, on either
 *   side. The hub adds its pool's (`PPTX_LIMITS`), the client its reader's (`PPTX_CLIENT_LIMITS`).
 * - **Scan** (`scanDeck`): the picture parts the listed slides, their layouts, masters and themes relate to
 *   (their SmartArt drawings' included), the metafiles each slide may show (LibreOffice converts them),
 *   speaker notes (read once here, so no batch needs the notes parts), the show's loop flag and the clip parts
 *   of the listed slides (`clipParts`, at most `PPTX_IMPORT_LIMITS.clips` of the first `CLIP_CANDIDATES`).
 * - **Extras** (`extrasOf`): each converted slide's transition and timing (`transition.ts`), which
 *   `convertDeck` does not read.
 */
import type { ConvertResult, SlideRef } from '@ordo/pptx-scene';
import { readNotes } from '@ordo/pptx-scene/notes.ts';
import { MAX_XML_PART_BYTES, type Package, relType } from '@ordo/pptx-scene/opc.ts';
import { extensionOf, METAFILE_EXTENSIONS } from '@ordo/pptx-scene/picture.ts';
import { readSlideTransition, showLoops } from '@ordo/pptx-scene/transition.ts';

const MiB = 1024 * 1024;

/** design/27 §2 and §12: what one import may read, spill and create, wherever the deck is parsed. */
export const PPTX_IMPORT_LIMITS = {
  /** Zip entries (central directory). */
  entries: 200_000,
  /** One XML or relationships part in memory. */
  xmlPartBytes: MAX_XML_PART_BYTES,
  /** Every XML part in memory together. */
  xmlTotalBytes: 64 * MiB,
  /** Media and font parts spilled (the hub) or read (the client) for one import. */
  spillBytes: 1024 * MiB,
  /** Picture and clip parts extracted per deck; the rest are logged and keep posters or fallbacks. */
  pictures: 2_000,
  clips: 50,
  /** Slides read per deck. */
  slides: 2_000,
  /** Longest part name in a payload pair or a client scene. */
  partName: 512,
  /**
   * Bytes of geometry files one import stores (`ShapeGeom.ref`, design/27 §15 M6 round 2; the largest of
   * the worship decks measured needs 0.6 MB); the objects naming a file past it are left out (M9 `ladder`).
   */
  geomFileBytes: 32 * MiB,
  /**
   * Bytes of geometry files one `pptx-scene` batch (or one client parse) may return; a slide whose new files
   * would pass it keeps none of them (the objects naming them are left out).
   */
  batchGeomBytes: 32 * MiB,
} as const;

/** Metafiles listed per slide (they are converted by part; more on one slide is a hostile deck). */
export const MAX_METAFILES_PER_SLIDE = 50;

/** What the first `pptx-scene` call (or the client parse) reads for the whole deck (`scanDeck`). */
export type SceneScan = {
  /**
   * Picture parts (image relationships, metafiles and SVG left out) of the listed slides, their layouts,
   * masters and themes: what the job spills and prepares. Stored part names, at most
   * `PPTX_IMPORT_LIMITS.pictures`.
   */
  pictures: string[];
  /** Picture parts referenced past `PPTX_IMPORT_LIMITS.pictures` (logged, not extracted). */
  picturesOver: number;
  /** Metafile pictures (EMF, WMF) each slide may show (its own, its layout's, its master's): [index, parts]. */
  metafiles: [number, string[]][];
  /** Speaker notes (`notes.ts`): [`SlideRef.index`, text]. */
  notes: [number, string][];
  /** `p:showPr loop`: the show loops until Esc. */
  loop: boolean;
  /**
   * Clip parts (video, sound and PowerPoint 2010 media relationships of the listed slides, those of
   * `p14:media` and the video elements first), at most `PPTX_IMPORT_LIMITS.clips`: what the job spills and
   * sniffs.
   */
  clips?: string[];
  /** Clip parts past `PPTX_IMPORT_LIMITS.clips` (logged; their posters stay). */
  clipsOver?: number;
};

/** A slide's transition and timing (`transition.ts`). */
export type SceneSlideExtra = {
  /** `SlideRef.index`. */
  index: number;
  transition?: { kind: 'cut' } | { kind: 'crossfade'; ms: number };
  /** `advTm`. */
  advanceMs?: number;
  /** What was approximated. */
  note?: string;
};

type Images = { pictures: string[]; metafiles: string[] };

/** Relationship types of clips: PowerPoint 2010's media (`p14:media`), video, then sound. */
const CLIP_TYPES: ReadonlyMap<string, number> = new Map([
  ['media', 0],
  ['video', 1],
  ['audio', 2],
]);

/** Distinct clip parts considered before the best `PPTX_IMPORT_LIMITS.clips` are chosen. */
export const CLIP_CANDIDATES = 4 * PPTX_IMPORT_LIMITS.clips + 1_000;

/**
 * The clip parts of the listed slides (their own relationships: layouts' and masters' clips are drawn as
 * posters), at most `PPTX_IMPORT_LIMITS.clips`: those a `p14:media` or video relationship names first, then
 * sounds (transition and animation sounds are sound relationships too, and are usually not imported).
 */
export function clipParts(pkg: Package, listed: readonly SlideRef[]): { clips: string[]; over: number } {
  const best = new Map<string, number>();
  for (const ref of listed)
    for (const r of pkg.rels(ref.part)) {
      const rank = CLIP_TYPES.get(relType(r.type));
      if (rank === undefined || r.external || !pkg.has(r.target)) continue;
      const stored = pkg.find(r.target) ?? r.target;
      if (/\.(xml|rels)$/i.test(stored)) continue;
      const was = best.get(stored);
      // A hostile list: enough candidates to choose from, each relationship looked at once.
      if (was === undefined && best.size >= CLIP_CANDIDATES) continue;
      if (was === undefined || rank < was) best.set(stored, rank);
    }
  const ranked = [...best].sort((a, b) => a[1] - b[1]).map(([part]) => part);
  const max = PPTX_IMPORT_LIMITS.clips;
  return { clips: ranked.slice(0, max), over: Math.max(0, ranked.length - max) };
}

/** What the import needs of the whole deck before its batches (see the module comment). */
export function scanDeck(pkg: Package, listed: readonly SlideRef[]): SceneScan {
  const images = new Map<string, Images>();
  /**
   * The image relationships of one part, by kind (cached: layouts and masters are shared), with those of the
   * SmartArt drawings it relates to (M6: their shapes are drawn natively, `smartart.ts`).
   */
  const imagesOf = (part: string, drawings = true): Images => {
    let v = images.get(part);
    if (v) return v;
    v = { pictures: [], metafiles: [] };
    for (const r of pkg.rels(part)) {
      if (drawings && !r.external && relType(r.type) === 'diagramDrawing' && pkg.has(r.target)) {
        const d = imagesOf(pkg.find(r.target) ?? r.target, false);
        v.pictures.push(...d.pictures);
        v.metafiles.push(...d.metafiles);
        continue;
      }
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
  const max = PPTX_IMPORT_LIMITS.pictures;
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
        if (pictures.size < max) pictures.add(p);
        else if (over.size < max) {
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
  const clips = clipParts(pkg, listed);
  return {
    pictures: [...pictures],
    picturesOver,
    metafiles,
    notes,
    loop: showLoops(pkg),
    ...(clips.clips.length ? { clips: clips.clips } : {}),
    ...(clips.over ? { clipsOver: clips.over } : {}),
  };
}

/** Each converted slide's transition and timing, read from its part's tail (`readSlideTransition`). */
export function extrasOf(pkg: Package, result: Pick<ConvertResult, 'slides' | 'listed'>): SceneSlideExtra[] {
  const out: SceneSlideExtra[] = [];
  for (const s of result.slides) {
    const part = result.listed[s.index]?.part;
    if (part === undefined) continue;
    const t = readSlideTransition(pkg, part);
    if (t.transition || t.advanceMs !== undefined) out.push({ index: s.index, ...t });
  }
  return out;
}

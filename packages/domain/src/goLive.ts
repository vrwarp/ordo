import { expandCues } from './cues.ts';
import { newId } from './ids.ts';
import { type ManifestFile, PRERENDERS_MAX, type PrerenderSize, type ResolvedPlaylist } from './live.ts';
import { drawnShapeFileRefs } from './m9-readers.ts';
import { type MissingKind, missingKinds, missingLabel } from './missing.ts';
import { PRERENDER_ON, resolveDraw } from './prerender.ts';
import {
  type SlidePlay,
  manifestFiles,
  referencedFontFamilies,
  referencedMediaIds,
  slideOnlyMedia,
} from './resolve.ts';
import {
  type FileRef,
  type Font,
  type GeneralSettings,
  isGeomFileRef,
  type Look,
  type Media,
  Playlist,
  PlaylistItem,
  Presentation,
  Section,
  Slide,
} from './schemas.ts';
import { resolvedBytes, resolvedSizeWarning } from './size.ts';

/**
 * Turning a playlist into the frozen copy a goLive carries (design/25 "quarantine"). Shared by the hub
 * (the normal authority) and the operator PC, which resolves a playlist itself when it goes live without
 * the hub (design/17 "Going live without the hub"). Pure: no I/O, no clock; the manifest digest is given.
 */

export class GoLiveRejection extends Error {}

/** What a goLive needs from the library (read lazily; may be unvalidated). */
export type GoLiveInputs = {
  /** The stored playlist, not yet validated. */
  playlist: unknown;
  /** A stored presentation, not yet validated; undefined when it does not exist. */
  presentation(id: string): unknown;
  media(id: string): Media | undefined;
  fonts(): Font[];
  looks: Look[];
  general: Pick<GeneralSettings, 'logoMediaId'>;
  /**
   * The content-store file of a hash: the geometry files slides draw (`ShapeGeom.ref`, M6 round 2) go into
   * the manifest with it. Absent (the operator PC resolving from its cache): they are left out, and outputs
   * draw what they cached.
   */
  file?(hash: string): FileRef | undefined;
  /**
   * design/29 §1.7: a pre-rendered slide's file head by its name (`Slide.prerender.file.ref`), so its pages are
   * listed (`SlideFileHead`, slidefile.ts): the hub reads it from its store, the operator PC from its file cache.
   * Absent: only the head is.
   */
  slideHead?(ref: string): { readonly pages: readonly string[] } | undefined;
  /**
   * design/29 §1.3, §1.7: the pictures the hub keeps of a presentation's pre-rendered slides (the newest per
   * slide, variant and size, a stand-by marked) and the keys of its current revision (`prerender_keys`).
   * Absent (no picture store, or the operator PC): none are listed.
   */
  prerenders?(presentationId: string): readonly PrerenderRow[];
  prerenderKeys?(presentationId: string): readonly string[];
  /** When the copy was taken (remote sources serve a cached copy while the library is down). */
  takenAt?: number;
  /**
   * Set when this is a cached copy because the library did not answer: the reason, naming the copy's time.
   * The goLive carries it as a `degraded` entry (cueIndex -1) so the operator sees it.
   */
  cachedCopy?: string;
};

export type Degraded = NonNullable<ResolvedPlaylist['degraded']>[number];

/** A picture the hub keeps of a pre-rendered slide (design/29 §1.3 `prerenders`), as goLive reads it. */
export type PrerenderRow = {
  slideId: string;
  key: string;
  size: PrerenderSize;
  file: FileRef;
  /** Found by its stand-by id: made by an older renderer or before a font upload (W39). */
  standby?: boolean;
};

/** A playlist entry whose content failed validation and was replaced (before cue indices are known). */
export type GoLiveProblem = { presentationId?: string; slideId?: string; reason: string };

/** At most this many degraded entries are carried in a resolved playlist. */
export const DEGRADED_MAX = 200;

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown, d: string) => (typeof x === 'string' && x ? x : d);
function issue(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || 'value'}: ${i.message}`.slice(0, 200) : 'invalid';
}

/**
 * Validate a stored presentation for goLive. A slide that fails the schema is replaced by an empty slide
 * with the same id; a presentation whose own fields are broken keeps its valid sections; one that cannot be
 * read at all becomes an empty presentation. Never throws.
 */
export function quarantinePresentation(
  raw: unknown,
  id: string,
): { presentation: Presentation; problems: GoLiveProblem[] } {
  const first = Presentation.safeParse(raw);
  if (first.success) return { presentation: first.data, problems: [] };
  const obj = isObj(raw) ? raw : {};
  const title = str(obj.title, 'Untitled');
  const problems: GoLiveProblem[] = [];
  const sections = (Array.isArray(obj.sections) ? obj.sections : []).map((sec, si) => {
    const s = isObj(sec) ? sec : {};
    const label = str(s.label, `Section ${si + 1}`);
    const slides = (Array.isArray(s.slides) ? s.slides : []).map((sl, k) => {
      const ok = Slide.safeParse(sl);
      if (ok.success) return ok.data;
      const slideId = isObj(sl) && typeof sl.id === 'string' && sl.id ? sl.id.slice(0, 200) : newId();
      problems.push({
        presentationId: id,
        slideId,
        reason: `"${title}" ${label} slide ${k + 1} is invalid (${issue(ok.error)}); shown empty`,
      });
      return { id: slideId, objects: [] };
    });
    return {
      ...s,
      id: typeof s.id === 'string' && s.id ? s.id : newId(),
      label,
      short: typeof s.short === 'string' ? s.short : '',
      slides,
    };
  });
  const second = Presentation.safeParse({ ...obj, id, sections });
  if (second.success) return { presentation: second.data, problems };
  // The presentation's own fields are broken: keep what is valid, reset the rest.
  const goodSections = sections.flatMap((s) => {
    const r = Section.safeParse(s);
    return r.success ? [r.data] : [];
  });
  const kind = obj.kind === 'song' || obj.kind === 'loop' || obj.kind === 'slides' ? obj.kind : 'slides';
  const minimal = {
    id,
    rev: typeof obj.rev === 'number' && Number.isInteger(obj.rev) ? obj.rev : 1,
    title: title.slice(0, 300),
    kind,
    meta: { tags: [] },
    sections: goodSections,
    arrangements: (Array.isArray(obj.arrangements) ? obj.arrangements : []).filter(
      (a) => isObj(a) && typeof a.id === 'string' && Array.isArray(a.sectionIds),
    ),
    ...(kind === 'loop' ? { loop: { defaultSlideMs: 8000 } } : {}),
    archived: false,
  };
  const third = Presentation.safeParse(minimal);
  if (third.success) {
    problems.push({
      presentationId: id,
      reason: `"${title}" is damaged (${issue(second.error)}); its settings were reset`,
    });
    return { presentation: third.data, problems };
  }
  problems.push({
    presentationId: id,
    reason: `"${title}" cannot be read (${issue(third.error)}); it shows no slides`,
  });
  return {
    presentation: {
      id,
      rev: 1,
      title: title.slice(0, 300),
      kind: 'slides',
      meta: { tags: [] },
      sections: [],
      arrangements: [],
      archived: false,
    },
    problems,
  };
}

/** Validate a stored playlist: invalid items are dropped (and reported); throws GoLiveRejection when hopeless. */
export function validatePlaylist(raw: unknown): { playlist: Playlist; problems: GoLiveProblem[] } {
  const first = Playlist.safeParse(raw);
  if (first.success) return { playlist: first.data, problems: [] };
  const obj = isObj(raw) ? raw : {};
  const problems: GoLiveProblem[] = [];
  const items = (Array.isArray(obj.items) ? obj.items : []).flatMap((it, i) => {
    const r = PlaylistItem.safeParse(it);
    if (r.success) return [r.data];
    problems.push({ reason: `playlist item ${i + 1} is invalid (${issue(r.error)}); skipped` });
    return [];
  });
  const second = Playlist.safeParse({ ...obj, items });
  if (second.success) return { playlist: second.data, problems };
  throw new GoLiveRejection(`Cannot go live: the playlist is damaged (${issue(second.error)})`);
}

/** Map problems to the cue indices they affect (every repeat of a slide); -1 when no cue shows them. */
export function degradedEntries(resolved: ResolvedPlaylist, problems: GoLiveProblem[]): Degraded[] {
  let cues: ReturnType<typeof expandCues> = [];
  try {
    cues = expandCues(resolved);
  } catch {
    /* cue indices unknown: report -1 */
  }
  const out: Degraded[] = [];
  for (const p of problems) {
    const hits = cues.filter((c) =>
      p.slideId
        ? c.presentationId === p.presentationId && c.slideId === p.slideId
        : p.presentationId !== undefined && c.presentationId === p.presentationId,
    );
    const base = {
      reason: p.reason,
      ...(p.presentationId ? { presentationId: p.presentationId } : {}),
      ...(p.slideId ? { slideId: p.slideId } : {}),
    };
    if (!hits.length) out.push({ cueIndex: -1, ...base });
    // A damaged presentation is reported once, at its first cue; a bad slide at every cue showing it.
    else for (const c of p.slideId ? hits : hits.slice(0, 1)) out.push({ cueIndex: c.index, ...base });
  }
  return out.slice(0, DEGRADED_MAX);
}

export type ResolveOptions = {
  /** Digest of the manifest identity parts (the hub uses SHA-256; the operator PC `localDigest`). */
  digest: (parts: string[]) => string;
  /** Told about a cached copy and about quarantined content (logging only). */
  warn?: (message: string, detail?: Record<string, unknown>) => void;
  /**
   * Whether the screens draw pre-rendered slides from their pictures (`PRERENDER_ON`, the default): only then
   * does a slide without its picture get a line (design/29 §1.7). Tests set it.
   */
  prerenderOn?: boolean;
};

/**
 * Resolve a playlist into the frozen copy a goLive carries. Every presentation is validated against the
 * schema; what fails is quarantined and listed in `degraded`, and the service still goes live. Missing
 * presentations and media that is not ready still refuse the goLive, except the clips and sounds slides play
 * in place and the PowerPoint pictures slides are set to show: those are left out with a `degraded` note
 * and the slide shows its poster (or, without its picture, the objects added in ordo). Throws
 * GoLiveRejection.
 */
export function resolvePlaylist(inputs: GoLiveInputs | undefined, playlistId: string, opts: ResolveOptions) {
  if (!inputs) throw new GoLiveRejection(`Playlist ${playlistId} not found`);
  const { playlist, problems } = validatePlaylist(inputs.playlist);
  if (inputs.cachedCopy) {
    problems.unshift({ reason: inputs.cachedCopy.slice(0, 500) });
    opts.warn?.('goLive from a cached copy of the playlist', { playlistId, takenAt: inputs.takenAt });
  }
  const presentations: Record<string, Presentation> = {};
  for (const item of playlist.items) {
    if (item.kind !== 'presentation' || presentations[item.presentationId]) continue;
    const raw = inputs.presentation(item.presentationId);
    if (raw === undefined || raw === null)
      throw new GoLiveRejection(`Presentation ${item.presentationId} in the playlist no longer exists`);
    const q = quarantinePresentation(raw, item.presentationId);
    presentations[item.presentationId] = q.presentation;
    problems.push(...q.problems);
  }
  const looks = inputs.looks;
  const logoId = inputs.general.logoMediaId;
  const optional = new Set<string>(
    [...looks.map((l) => l.holdingMediaId ?? ''), logoId ?? ''].filter(Boolean),
  );
  const slideOnly = slideOnlyMedia(playlist, presentations);
  const media: Record<string, Media> = {};
  const missing: string[] = [];
  for (const id of referencedMediaIds(playlist, presentations, looks, logoId)) {
    const m = inputs.media(id);
    const plays = slideOnly.get(id);
    if (m?.state !== 'ready') {
      // What a slide plays in place never refuses the service: the slide shows its poster (design/27 §8);
      // nor does a reference picture, optional like a look's holding slide (design/27 §5).
      if (plays) for (const play of plays) problems.push(unplayable(play, id, m, presentations));
      else if (optional.has(id)) continue;
      else if (!m) missing.push(`media ${id} is missing`);
      else missing.push(`"${m.name}" is ${m.state === 'failed' ? 'failed' : 'still processing'}`);
      continue;
    }
    media[id] = m;
  }
  if (missing.length) throw new GoLiveRejection(`Cannot go live: ${missing.slice(0, 5).join('; ')}`);
  // What pre-rendered slides' files draw (design/29 §1.7): their media optional, like a reference picture.
  problems.push(...usedMedia(presentations, inputs, media));
  // Family names match case-insensitively, as in CSS and the drawers' font resolver.
  const families = new Set(
    [...referencedFontFamilies(Object.values(presentations), looks), ...usedFonts(presentations)].map((f) =>
      f.trim().toLowerCase(),
    ),
  );
  const fonts: Font[] = inputs.fonts().filter((f) => families.has(f.family.trim().toLowerCase()));
  const files = manifestFiles(Object.values(media), fonts);
  const geoms = geomFiles({ playlist, presentations, media }, inputs, opts.prerenderOn ?? PRERENDER_ON);
  for (const f of geoms.files)
    files.push({ hash: f.hash, bytes: f.bytes, mime: f.mime } satisfies ManifestFile);
  files.push(...geoms.unindexed);
  problems.push(...geoms.problems);
  const parts = [`${playlist.id}:${playlist.rev}`];
  for (const p of Object.values(presentations)) parts.push(`${p.id}:${p.rev}`);
  for (const f of files) parts.push(f.hash);
  parts.push(JSON.stringify(looks));
  const resolved: ResolvedPlaylist = {
    playlist,
    presentations,
    media,
    fonts,
    looks,
    ...(geoms.prerenders.length ? { prerenders: geoms.prerenders } : {}),
    ...(geoms.keys.length ? { prerenderKeys: geoms.keys } : {}),
    logoMediaId: logoId && media[logoId] ? logoId : undefined,
    files,
    ...(geoms.files.length ? { geoms: geoms.files } : {}),
    manifestId: opts.digest(parts),
  };
  // Too large for an operator takeover's hand-back (design/27 §3.4): live with a warning.
  const sizeWarning = resolvedSizeWarning(resolvedBytes(resolved));
  if (sizeWarning) problems.push({ reason: sizeWarning });
  // Slides whose LibreOffice art or page picture is still being made go live as they are (design/27 §5).
  problems.push(...pendingSlides(resolved));
  if (problems.length) {
    resolved.degraded = degradedEntries(resolved, problems);
    for (const d of resolved.degraded)
      opts.warn?.('goLive: content quarantined', { cueIndex: d.cueIndex, reason: d.reason });
  }
  return resolved;
}

/**
 * The degraded note of a slide whose clip, sound or PowerPoint reference picture is not ready, so the slide
 * goes live without it; or of an item whose music is not ready (deleted, failed or still processing), so the
 * item plays without it: a whole-service warning, as an item's music belongs to no one slide.
 */
function unplayable(
  play: SlidePlay,
  id: string,
  m: Media | undefined,
  presentations: Record<string, Presentation>,
): GoLiveProblem {
  if (play.role === 'music') {
    const title = (presentations[play.presentationId]?.title ?? '').slice(0, 200);
    const of = title ? ` of "${title}"` : '';
    const name = m ? `"${m.name.slice(0, 200)}" (the music${of})` : `The music${of}`;
    const reason = !m
      ? `${name} is missing; ${MUSIC_SHOWN}`
      : m.state === 'failed'
        ? `${name} failed; ${MUSIC_SHOWN}`
        : `${name} is still processing; ${MUSIC_SHOWN}; Go live again once it is ready`;
    return { reason };
  }
  const what =
    play.role === 'sound'
      ? 'slide sound'
      : play.role === 'background'
        ? 'slide background'
        : play.role === 'picture'
          ? 'PowerPoint picture'
          : 'slide video';
  const name = m ? `"${m.name.slice(0, 200)}" (${what})` : `${what} ${id.slice(0, 200)}`;
  const shown =
    play.role === 'video'
      ? 'showing its poster'
      : play.role === 'picture'
        ? 'the slide shows only the objects added in ordo'
        : 'the slide shows without it';
  const reason = !m
    ? `${name} is missing; ${shown}`
    : m.state === 'failed'
      ? `${name} failed; ${shown}`
      : `${name} is still processing; ${shown}; Go live again once it is ready`;
  return { presentationId: play.presentationId, slideId: play.slideId, reason };
}

/** What an item does without its music (the end of its degraded reason). */
const MUSIC_SHOWN = 'the item plays without music';

/**
 * A synchronous 96-bit digest (three FNV-1a lanes) for manifest ids resolved on the operator PC, where
 * WebCrypto's async SHA-256 does not fit a synchronous command path. Identity only, not security.
 */
export function localDigest(parts: string[]): string {
  const seeds = [0x811c9dc5, 0x01000193 ^ 0x5bd1e995, 0x9747b28c];
  const lanes = seeds.map((s) => s >>> 0);
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i);
      for (let l = 0; l < lanes.length; l++) {
        lanes[l] = Math.imul((lanes[l]! ^ (c + l * 31)) >>> 0, 0x01000193) >>> 0;
      }
    }
    for (let l = 0; l < lanes.length; l++) lanes[l] = Math.imul(lanes[l]! ^ 0x1f, 0x01000193) >>> 0;
  }
  return `pc${lanes.map((x) => x.toString(16).padStart(8, '0')).join('')}`.slice(0, 26);
}

/**
 * What a `degraded` entry's slide shows, from its reason, for the operator's banner (design/25, design/27 §5,
 * §8): 'empty' a slide quarantined and replaced by an empty one; 'media' a slide that goes live without a
 * clip, sound, background or PowerPoint picture that is not ready (its poster shows); 'drawing' a PowerPoint
 * slide LibreOffice is still drawing or could not draw; 'picture' pre-rendered slides without their picture
 * yet (design/29 §1.7, W33); 'slideFile' pre-rendered slides whose full copy the hub lacks (W40); 'other'
 * anything else (a damaged presentation, a slide's cut lines, the file cap, W60). The reasons are written in
 * this file, so the kinds stay in step with them. (The operator's banner groups 'picture' and 'slideFile' from
 * golive-warnings on; nothing writes a pre-rendered slide before then, `PRERENDER_ON`.)
 */
export type DegradedKind = 'empty' | 'media' | 'drawing' | 'picture' | 'slideFile' | 'other';

const MEDIA_REASON =
  /; (?:showing its poster|the slide shows without it|the slide shows only the objects added in ordo|the item plays without music)(?:; Go live again once it is ready)?$/;

export function degradedKind(reason: string): DegradedKind {
  if (PICTURE_REASON.test(reason)) return 'picture';
  if (SLIDE_FILE_REASON.test(reason)) return 'slideFile';
  if (reason === PENDING_SLIDE_REASON || reason === FAILED_SLIDE_REASON) return 'drawing';
  if (reason.startsWith(MISSING_SLIDE_REASON)) return 'drawing';
  if (MEDIA_REASON.test(reason)) return 'media';
  if (/ slide \d+ is invalid \(.*\); shown empty$/s.test(reason)) return 'empty';
  return 'other';
}

/** The reason a slide waiting for the LibreOffice follow-up of a PowerPoint import is listed in `degraded`. */
export const PENDING_SLIDE_REASON =
  'PowerPoint slide still being drawn by LibreOffice: its chart, art or page picture is missing until then';

/** The reason a slide LibreOffice could not draw (`Slide.pptx.failed`) is listed in `degraded`. */
export const FAILED_SLIDE_REASON =
  'PowerPoint slide LibreOffice could not draw: its chart, art or page picture is missing';

/**
 * The start of the reason a slide with PowerPoint elements nothing draws (`Slide.pptx.missing`, M9) is listed
 * in `degraded`; `missingSlideReason` adds what is left out.
 */
export const MISSING_SLIDE_REASON = 'PowerPoint slide with something ordo cannot draw';

/**
 * The reason for a slide whose elements of `kinds` are left out: 'PowerPoint slide with something ordo
 * cannot draw (a chart, a SmartArt graphic): it is left out'.
 */
export function missingSlideReason(kinds: readonly MissingKind[]): string {
  const what = kinds.length ? ` (${kinds.map(missingLabel).join(', ')})` : '';
  return `${MISSING_SLIDE_REASON}${what}: it is left out`;
}

/**
 * At most this many content-store files a goLive lists besides media and fonts (geometry and decoration files,
 * pre-rendered slides' pictures, heads and pages; each is one file the outputs cache).
 */
export const GOLIVE_GEOM_FILES_MAX = 20_000;

/** The line a goLive carries when its listing reaches `GOLIVE_GEOM_FILES_MAX` (design/29 §3, W60; critical). */
export const FILES_CUT_REASON =
  'Some slides near the end of this service are shown without their full detail: it has more files than ordo sends at once. Split the playlist into two services.';

/** The degraded line of pre-rendered slides of one presentation whose full copy the hub lacks (W40; critical). */
function slideFileMissing(title: string, slides: number[]): string {
  return slides.length === 1
    ? `Slide ${slides[0]} of "${title}" is missing its full copy on the hub, so the screens show a simplified version (its text and pictures only).`
    : `${slides.length} slides of "${title}" are missing their full copy on the hub, so the screens show a simplified version (their text and pictures only).`;
}
const SLIDE_FILE_REASON =
  / (?:is|are) missing (?:its|their) full copy on the hub, so the screens show a simplified version/;

/** The degraded line of pre-rendered slides of one presentation without a picture yet (W33; critical). */
function pictureMissing(title: string, n: number): string {
  const which = n === 1 ? `1 slide of "${title}" has` : `${n} slides of "${title}" have`;
  return `${which} no picture yet. Until a picture is ready, the screens draw the slide themselves, so it may appear a moment late.`;
}
const PICTURE_REASON =
  / (?:has|have) no picture yet\. Until a picture is ready, the screens draw the slide themselves/;

/** What a goLive lists besides media and fonts: `geomFiles`' result. */
type Listed = {
  /** Files the library's index knows: into `files` and `geoms`. */
  files: FileRef[];
  /** Files listed without an index (the operator PC resolving offline): into `files` only. */
  unindexed: ManifestFile[];
  prerenders: NonNullable<ResolvedPlaylist['prerenders']>;
  keys: string[];
  problems: GoLiveProblem[];
};

/**
 * The content-store files the service's slides draw besides media and fonts, once each, in cue order from the
 * first cue (design/29 §1.7): geometry and decoration files (`drawnShapeFileRefs`), and for a pre-rendered slide
 * its pictures (the hub's rows of the key set, or stand-bys), its head, its pages (`slideHead`) and the shape
 * files it uses; then the slides no cue shows. Past `GOLIVE_GEOM_FILES_MAX` the rest are not listed, with W60
 * when a cue's slide lost files. With the library's file index: one line a slide whose shape files it lacks, one
 * a presentation whose slides' full copies it lacks (W40), and, while the screens draw pictures, one a
 * presentation whose slides have no picture yet (W33). Without one (the operator PC from its cache) they are
 * listed by name for the outputs to fetch over the direct link, and nothing is judged missing.
 */
function geomFiles(
  resolved: Pick<ResolvedPlaylist, 'playlist' | 'presentations' | 'media'>,
  inputs: GoLiveInputs,
  prerenderOn: boolean,
): Listed {
  const out: Listed = { files: [], unindexed: [], prerenders: [], keys: [], problems: [] };
  const presentations = resolved.presentations;
  const index = inputs.file;
  const seen = new Set<string>();
  const missingRefs = new Set<string>();
  let cut = false;
  // Lists one file; false once the cap is reached.
  const list = (hash: string, ref?: FileRef): boolean => {
    if (seen.has(hash)) return true;
    if (seen.size >= GOLIVE_GEOM_FILES_MAX) return false;
    seen.add(hash);
    if (ref) out.files.push(ref);
    else out.unindexed.push({ hash, bytes: 0, mime: 'application/json' });
    return true;
  };
  // Looks a file up in the index; without one, a name is all there is.
  const find = (hash: string): { ref?: FileRef; ok: boolean } => {
    if (!index) return { ok: true };
    if (missingRefs.has(hash)) return { ok: false };
    const f = index(hash);
    if (f?.hash === hash) return { ref: f, ok: true };
    missingRefs.add(hash);
    return { ok: false };
  };
  // The service's key set and each presentation's picture rows (the hub's; none offline).
  const keys = new Set<string>();
  const rows = new Map<string, Map<string, PrerenderRow[]>>();
  for (const p of Object.values(presentations)) {
    for (const k of inputs.prerenderKeys?.(p.id) ?? [])
      if (keys.size < PRERENDERS_MAX && typeof k === 'string' && isGeomFileRef(k)) keys.add(k);
    const bySlide = new Map<string, PrerenderRow[]>();
    for (const r of inputs.prerenders?.(p.id) ?? []) {
      const list = bySlide.get(r.slideId) ?? [];
      list.push(r);
      bySlide.set(r.slideId, list);
    }
    rows.set(p.id, bySlide);
  }
  out.keys = [...keys];
  type Missing = { slides: number[]; ids: string[] };
  const fileMissing = new Map<string, Missing>();
  const pictureLess = new Map<string, number>();
  const shown = new Set<string>();
  const slideFiles = (p: Presentation, s: Slide, at: number, inCue: boolean) => {
    let lost = 0;
    let complete = true;
    const add = (hash: string, ref?: FileRef) => {
      if (!list(hash, ref)) complete = false;
    };
    const pre = s.prerender;
    if (pre) {
      let pictured = false;
      for (const r of rows.get(p.id)?.get(s.id) ?? []) {
        if (!isGeomFileRef(r.key) || !isGeomFileRef(r.file?.hash)) continue;
        if (!keys.has(r.key) && !r.standby) continue;
        if (out.prerenders.length >= PRERENDERS_MAX) break;
        const before = seen.size;
        add(r.file.hash, r.file);
        if (seen.size === before && !seen.has(r.file.hash)) continue;
        pictured = true;
        out.prerenders.push({
          presentationId: p.id,
          slideId: s.id,
          key: r.key,
          size: r.size,
          file: r.file.hash,
          ...(r.standby ? { standby: true } : {}),
        });
      }
      if (pre.file) {
        const head = find(pre.file.ref);
        if (!head.ok) {
          const m = fileMissing.get(p.id) ?? { slides: [], ids: [] };
          m.slides.push(at);
          m.ids.push(s.id);
          fileMissing.set(p.id, m);
        } else {
          add(pre.file.ref, head.ref);
          for (const page of inputs.slideHead?.(pre.file.ref)?.pages ?? []) {
            const f = find(page);
            if (f.ok) add(page, f.ref);
            else if (!fileMissing.get(p.id)?.ids.includes(s.id)) {
              const m = fileMissing.get(p.id) ?? { slides: [], ids: [] };
              m.slides.push(at);
              m.ids.push(s.id);
              fileMissing.set(p.id, m);
            }
          }
        }
      }
      if (!pictured && inCue && resolveDraw(s, p.meta) === 'picture')
        pictureLess.set(p.id, (pictureLess.get(p.id) ?? 0) + 1);
    }
    for (const ref of new Set([...drawnShapeFileRefs(s), ...(pre?.uses?.files ?? [])])) {
      if (!index && !isGeomFileRef(ref)) continue;
      const f = find(ref);
      if (f.ok) add(ref, f.ref);
      else lost++;
    }
    if (!complete && inCue) cut = true;
    if (lost && out.problems.length < DEGRADED_MAX)
      out.problems.push({
        presentationId: p.id,
        slideId: s.id,
        reason: `${lost} shape outline(s) of this slide are missing from the library: drawn as plain shapes`,
      });
  };
  // Each slide's position in its presentation (1-based, every section in stored order), for the lines.
  const where = new Map<string, Map<string, { s: Slide; at: number }>>();
  for (const p of Object.values(presentations)) {
    const m = new Map<string, { s: Slide; at: number }>();
    let at = 0;
    for (const sec of p.sections) for (const s of sec.slides) if (!m.has(s.id)) m.set(s.id, { s, at: ++at });
    where.set(p.id, m);
  }
  let cues: ReturnType<typeof expandCues> = [];
  try {
    cues = expandCues(resolved);
  } catch {
    /* no cue order: the presentations' order below */
  }
  for (const c of cues) {
    if (c.kind !== 'slide' || !c.presentationId || !c.slideId) continue;
    const id = `${c.presentationId}\u0000${c.slideId}`;
    if (shown.has(id)) continue;
    shown.add(id);
    const p = presentations[c.presentationId];
    const hit = where.get(c.presentationId)?.get(c.slideId);
    if (p && hit) slideFiles(p, hit.s, hit.at, true);
  }
  for (const p of Object.values(presentations))
    for (const [slideId, hit] of where.get(p.id) ?? [])
      if (!shown.has(`${p.id}\u0000${slideId}`)) slideFiles(p, hit.s, hit.at, false);
  for (const [pid, m] of fileMissing) {
    const title = (presentations[pid]?.title ?? '').slice(0, 200);
    out.problems.push({
      presentationId: pid,
      ...(m.ids.length === 1 ? { slideId: m.ids[0] } : {}),
      reason: slideFileMissing(title, m.slides),
    });
  }
  if (prerenderOn)
    for (const [pid, n] of pictureLess)
      out.problems.push({
        presentationId: pid,
        reason: pictureMissing((presentations[pid]?.title ?? '').slice(0, 200), n),
      });
  // W60: a service-wide line, ahead of the per-slide ones, so the degraded list's cap never hides it.
  if (cut) out.problems.unshift({ reason: FILES_CUT_REASON });
  return out;
}

/**
 * The media pre-rendered slides' files draw (`Slide.prerender.uses.media`, design/29 §1.7), optional like a
 * reference picture: what is ready joins `media`, what is not is a line for its slide, never a refusal.
 */
function usedMedia(
  presentations: Record<string, Presentation>,
  inputs: GoLiveInputs,
  media: Record<string, Media>,
): GoLiveProblem[] {
  const problems: GoLiveProblem[] = [];
  for (const p of Object.values(presentations))
    for (const sec of p.sections)
      for (const s of sec.slides)
        for (const id of s.prerender?.uses?.media ?? []) {
          if (media[id]) continue;
          const m = inputs.media(id);
          if (m?.state === 'ready') {
            media[id] = m;
            continue;
          }
          if (problems.length >= DEGRADED_MAX) continue;
          const name = m
            ? `"${m.name.slice(0, 200)}" (a picture of the slide's full copy)`
            : `picture ${id.slice(0, 200)}`;
          const state = !m ? 'is missing' : m.state === 'failed' ? 'failed' : 'is still processing';
          problems.push({
            presentationId: p.id,
            slideId: s.id,
            reason: `${name} ${state}; the slide shows without it`,
          });
        }
  return problems;
}

/** The font families pre-rendered slides' files draw in (`Slide.prerender.uses.fonts`). */
function usedFonts(presentations: Record<string, Presentation>): string[] {
  const out: string[] = [];
  for (const p of Object.values(presentations))
    for (const sec of p.sections)
      for (const s of sec.slides) for (const f of s.prerender?.uses?.fonts ?? []) out.push(f);
  return out;
}

/**
 * Slides of a native PowerPoint import that still wait for LibreOffice (`Slide.pptx.pending`), that it could
 * not draw (`Slide.pptx.failed`), or with elements nothing draws (`Slide.pptx.missing`, M9, named by kind),
 * and slides not from PowerPoint that a kept bound cut (`Slide.cut`, design/29 §1.2). One entry a slide:
 * waiting or failed first, since LibreOffice's drawing would bring the missing elements.
 */
function pendingSlides(resolved: ResolvedPlaylist): GoLiveProblem[] {
  const out: GoLiveProblem[] = [];
  // A hidden slide is listed too: its cue is skipped by Next, but a click shows it (design/27 §9).
  const reason = (s: Slide): string | undefined => {
    if (s.pptx?.pending) return PENDING_SLIDE_REASON;
    if (s.pptx?.failed) return FAILED_SLIDE_REASON;
    if (s.pptx?.missing?.length) return missingSlideReason(missingKinds(s.pptx.missing));
    // What a kept bound left out of a slide not from PowerPoint (design/29 §1.2): the import's own lines.
    if (s.cut?.length) return s.cut.join(' ').slice(0, 500);
    return undefined;
  };
  for (const p of Object.values(resolved.presentations))
    for (const sec of p.sections)
      for (const s of sec.slides) {
        if (out.length >= DEGRADED_MAX) return out;
        const r = reason(s);
        if (r) out.push({ presentationId: p.id, slideId: s.id, reason: r });
      }
  return out;
}

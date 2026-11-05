import { expandCues } from './cues.ts';
import { newId } from './ids.ts';
import type { ResolvedPlaylist } from './live.ts';
import { manifestFiles, referencedFontFamilies, referencedMediaIds } from './resolve.ts';
import {
  type Font,
  type GeneralSettings,
  type Look,
  type Media,
  Playlist,
  PlaylistItem,
  Presentation,
  Section,
  Slide,
} from './schemas.ts';

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
  /** When the copy was taken (remote sources serve a cached copy while the library is down). */
  takenAt?: number;
  /**
   * Set when this is a cached copy because the library did not answer: the reason, naming the copy's time.
   * The goLive carries it as a `degraded` entry (cueIndex -1) so the operator sees it.
   */
  cachedCopy?: string;
};

export type Degraded = NonNullable<ResolvedPlaylist['degraded']>[number];

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
};

/**
 * Resolve a playlist into the frozen copy a goLive carries. Every presentation is validated against the
 * schema; what fails is quarantined and listed in `degraded`, and the service still goes live. Missing
 * presentations and media that is not ready still refuse the goLive. Throws GoLiveRejection.
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
  const media: Record<string, Media> = {};
  const missing: string[] = [];
  for (const id of referencedMediaIds(playlist, presentations, looks, logoId)) {
    const m = inputs.media(id);
    if (!m) {
      if (!optional.has(id)) missing.push(`media ${id} is missing`);
      continue;
    }
    if (m.state !== 'ready') {
      if (optional.has(id)) continue;
      missing.push(`"${m.name}" is ${m.state === 'failed' ? 'failed' : 'still processing'}`);
      continue;
    }
    media[id] = m;
  }
  if (missing.length) throw new GoLiveRejection(`Cannot go live: ${missing.slice(0, 5).join('; ')}`);
  const families = referencedFontFamilies(Object.values(presentations), looks);
  const fonts: Font[] = inputs.fonts().filter((f) => families.has(f.family));
  const files = manifestFiles(Object.values(media), fonts);
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
    logoMediaId: logoId && media[logoId] ? logoId : undefined,
    files,
    manifestId: opts.digest(parts),
  };
  if (problems.length) {
    resolved.degraded = degradedEntries(resolved, problems);
    for (const d of resolved.degraded)
      opts.warn?.('goLive: content quarantined', { cueIndex: d.cueIndex, reason: d.reason });
  }
  return resolved;
}

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

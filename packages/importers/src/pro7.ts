import {
  type Arrangement,
  type Box,
  DEFAULT_THEME,
  type ImageObject,
  type ShapeObject,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  newId,
  parseSectionLabel,
  type Playlist,
  type PlaylistItem,
  type Presentation,
  type Rgba,
  type Section,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextStyle,
} from '@ordo/domain';
import { decodeAs, type Msg, PRO7_PROTO_VERSION } from './proto.ts';
import { parseRtf, splitFontName } from './rtf.ts';
import { clipText, IMPORT_LIMITS, sanitizePresentation } from './sanitize.ts';

/** Playlist folders nest at most this deep (deeper nodes are logged and skipped). */
const PLAYLIST_MAX_DEPTH = 32;
/** Path suffixes tried when locating a media file (the longest real library paths are far shorter). */
const MEDIA_SUFFIX_SEGMENTS = 12;

export type ImportLogLevel = 'info' | 'warn' | 'error';
export type ImportLogEntry = { level: ImportLogLevel; item?: string; message: string };

export type Pro7ImportResult = {
  presentations: Presentation[];
  playlists: Playlist[];
  /** Media files referenced by the imported entities, keyed by the placeholder id used inside them. */
  media: { key: string; path: string; background?: boolean }[];
  log: ImportLogEntry[];
  protoVersion: string;
  /**
   * Every `.pro` document seen so far (`opts.refs` plus this call's): what a later batch needs to skip a
   * copy of a document already imported and what the playlist pass needs to resolve its items.
   */
  refs: Pro7PresRef[];
};

/**
 * A decoded document as later batches and the playlist pass see it: structured-cloneable (a worker
 * message), without the presentation itself.
 */
export type Pro7PresRef = {
  /** File path inside the import (playlists reference documents by path or name). */
  path: string;
  /** The ordo presentation id. */
  id: string;
  title: string;
  pro7Uuid?: string;
  /** Document name and cue count as stored, for telling a copy from a second reference to one document. */
  name: string;
  cueCount: number;
  /** ProPresenter arrangement name (lower case) to ordo arrangement id. */
  arrangementNames: Map<string, string>;
  /** ProPresenter arrangement UUID to ordo arrangement id. */
  arrangementIds: Map<string, string>;
};

/**
 * A large library is decoded in batches of `.pro` documents, each a separate call (the hub runs each on a
 * worker with a bounded heap): `phase: 'documents'` decodes the `.pro` files in `files` against the
 * documents of earlier batches (`refs`), `phase: 'playlists'` reads only the playlist documents against
 * every document decoded before. The media placeholders of all batches are keyed by path, so their union
 * is the library's media list. Without options one call does everything.
 */
export type Pro7ImportOptions = {
  refs?: Pro7PresRef[];
  phase?: 'all' | 'documents' | 'playlists';
};

/** Prefix of placeholder media ids inside imported entities; see `remapMediaIds`. */
export const PRO7_MEDIA_PREFIX = 'pro7media:';

const MEDIA_EXT =
  /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|jpe?g|png|gif|bmp|tiff?|heic|webp|wav|mp3|aac|m4a|flac|ogg|aiff?)$/i;

/** The directory part of an import path ('' at the root). */
function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function stripExt(p: string): string {
  return p.replace(/\.[^./]+$/, '');
}

function uuidOf(u: Msg | undefined): string | undefined {
  const s = u?.string;
  return typeof s === 'string' && s ? s.toUpperCase() : undefined;
}

function normalizeUrlPath(raw: string): string {
  let p = raw.replace(/^file:\/\/(localhost)?/i, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep as-is
  }
  // Windows: `C:\Users\...` and `file:///C:/Users/...` both become `/Users/...`.
  return p.replace(/\\/g, '/').replace(/^\/?[a-zA-Z]:\//, '/');
}

/**
 * Every path a ProPresenter URL may point at, best first: the absolute path of the exporting machine,
 * then `local.path` (relative to a well-known root: the bundle itself for ROOT_CURRENT_RESOURCE, the user's
 * home or Downloads otherwise; what ProPresenter itself resolves by), then a relative path. A bundle
 * exported on another Mac keeps an absolute path that no longer exists while `local.path` still does.
 */
export function pro7UrlPaths(url: Msg | undefined): string[] {
  if (!url) return [];
  const local = url.local as Msg | undefined;
  const out: string[] = [];
  for (const raw of [url.absoluteString, local?.path, url.relativePath]) {
    if (typeof raw !== 'string' || !raw) continue;
    const p = normalizeUrlPath(raw);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The file path a ProPresenter URL points at (the first of `pro7UrlPaths`). */
export function pro7UrlPath(url: Msg | undefined): string | undefined {
  return pro7UrlPaths(url)[0];
}

/** Locates media files in the import file map: exact relative path, then path suffix, then basename. */
class MediaResolver {
  private byLower = new Map<string, string>();
  private byBase = new Map<string, string[]>();
  readonly found = new Map<string, string>();
  constructor(files: Map<string, Uint8Array>) {
    for (const path of files.keys()) {
      this.byLower.set(path.toLowerCase(), path);
      const b = basename(path).toLowerCase();
      const list = this.byBase.get(b) ?? [];
      list.push(path);
      this.byBase.set(b, list);
    }
  }
  /**
   * Returns a placeholder id for the media, or undefined if the file is not in the import. `paths` are the
   * candidates from `pro7UrlPaths`, tried in order: exact entry, then the longest path suffix, then (for
   * every candidate) the bare file name. A file name that several entries share is taken only when one of
   * them sits next to the referencing document (`near`); otherwise it is left unresolved rather than
   * guessed, since every song folder of a library tends to have its own `background.jpg`.
   */
  resolve(paths: string | string[] | undefined, log: (m: string) => void, near?: string): string | undefined {
    const cands = (Array.isArray(paths) ? paths : paths ? [paths] : [])
      .map((p) => p.replace(/^\/+/, ''))
      .filter(Boolean);
    if (cands.length === 0) return undefined;
    for (const norm of cands) {
      const key = PRO7_MEDIA_PREFIX + norm;
      if (this.found.has(key)) return key;
    }
    let hit: string | undefined;
    let chosen = cands[0]!;
    for (const norm of cands) {
      const lower = norm.toLowerCase();
      hit = this.byLower.get(lower);
      if (!hit) {
        // Longest relative suffix that matches an entry ("Media/Assets/x.mp4" inside "Library/Media/Assets/x.mp4").
        const segs = lower.split('/');
        for (let i = Math.max(1, segs.length - MEDIA_SUFFIX_SEGMENTS); i < segs.length - 1 && !hit; i++) {
          const suffix = segs.slice(i).join('/');
          for (const [k, v] of this.byLower) {
            if (k === suffix || k.endsWith('/' + suffix)) {
              hit = v;
              break;
            }
          }
        }
      }
      if (hit) {
        chosen = norm;
        break;
      }
    }
    if (!hit) {
      const nearDir = near ? dirname(near).toLowerCase() : undefined;
      for (const norm of cands) {
        const list = this.byBase.get(basename(norm.toLowerCase()));
        if (!list || list.length === 0) continue;
        chosen = norm;
        if (list.length === 1) hit = list[0];
        else {
          const sameDir =
            nearDir !== undefined ? list.filter((c) => dirname(c).toLowerCase() === nearDir) : [];
          if (sameDir.length === 1) hit = sameDir[0];
          else {
            log(
              `media "${basename(norm)}" matches ${list.length} files by name and none next to the document; not linked`,
            );
            return undefined;
          }
        }
        break;
      }
    }
    if (!hit) {
      log(`media file not found in import: ${cands[0]}`);
      return undefined;
    }
    const key = PRO7_MEDIA_PREFIX + chosen;
    this.found.set(key, hit);
    return key;
  }
}

function colorOf(c: Msg | undefined): Rgba | undefined {
  if (!c) return undefined;
  const ch = (v: unknown) => Math.round(Math.max(0, Math.min(1, typeof v === 'number' ? v : 0)) * 255);
  return { r: ch(c.red), g: ch(c.green), b: ch(c.blue), a: typeof c.alpha === 'number' ? c.alpha : 1 };
}

/**
 * A short form for a group name ordo does not know: initials of a multi-word name, else the first two
 * letters (`COPYRIGHT` → `CO`, `BLANK` → `BL`), never the single letter a known label uses (`C`, `B`).
 */
function initials(label: string): string {
  const words = label.split(/[\s\-_/]+/).filter(Boolean);
  const num = /(\d+)$/.exec(label)?.[1] ?? '';
  const alpha = words.filter((w) => !/^\d+$/.test(w));
  let letters =
    alpha.length >= 2
      ? alpha
          .map((w) => w[0]!.toUpperCase())
          .join('')
          .slice(0, 3)
      : (alpha[0] ?? label)
          .replace(/[^\p{L}\p{N}]/gu, '')
          .slice(0, 2)
          .toUpperCase();
  if (!letters) letters = 'X';
  return letters + num;
}

/** Section label and short form for a ProPresenter group name; unknown labels are kept as typed. */
export function sectionLabelFor(name: string | undefined): { label: string; short: string; known: boolean } {
  const raw = (name ?? '').trim();
  if (!raw) return { label: 'Slides', short: 'S', known: false };
  const p = parseSectionLabel(raw);
  if (p) return { ...p, known: true };
  return { label: raw, short: initials(raw), known: false };
}

type SlideSize = { width: number; height: number };

/**
 * A slide of another size (4:3 documents are 1024x768) is scaled uniformly to fit the 1920x1080 canvas
 * and centred, so text keeps its proportions; 16:9 documents of any size scale exactly.
 */
function slideScale(size: SlideSize): { s: number; ox: number; oy: number } {
  const s = Math.min(LOGICAL_WIDTH / size.width, LOGICAL_HEIGHT / size.height);
  return { s, ox: (LOGICAL_WIDTH - size.width * s) / 2, oy: (LOGICAL_HEIGHT - size.height * s) / 2 };
}

function scaleBox(bounds: Msg | undefined, size: SlideSize, rotation: number): Box {
  const { s: k, ox, oy } = slideScale(size);
  const o = bounds?.origin ?? {};
  const s = bounds?.size ?? {};
  const r = (v: number) => Math.round(v * 100) / 100 || 0;
  return {
    x: r((o.x ?? 0) * k + ox),
    y: r((o.y ?? 0) * k + oy),
    w: r((s.width ?? size.width) * k),
    h: r((s.height ?? size.height) * k),
    rotation: rotation || 0,
  };
}

function shadowOf(sh: Msg | undefined, scale: number): TextStyle['shadow'] {
  if (!sh?.enable) return undefined;
  const angle = ((sh.angle ?? 315) * Math.PI) / 180;
  const off = (sh.offset ?? 5) * scale;
  const color = colorOf(sh.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  return {
    dx: Math.round(Math.cos(angle) * off * 100) / 100,
    // ProPresenter angles are counter-clockwise with y up; the canvas has y down.
    dy: Math.round(-Math.sin(angle) * off * 100) / 100,
    blur: (sh.radius ?? 5) * scale,
    color: { ...color, a: color.a * (typeof sh.opacity === 'number' ? sh.opacity : 1) },
  };
}

const VALIGN: Record<string, TextStyle['valign']> = {
  VERTICAL_ALIGNMENT_TOP: 'top',
  VERTICAL_ALIGNMENT_MIDDLE: 'middle',
  VERTICAL_ALIGNMENT_BOTTOM: 'bottom',
};
const PARA_ALIGN: Record<string, TextStyle['align']> = {
  ALIGNMENT_LEFT: 'left',
  ALIGNMENT_RIGHT: 'right',
  ALIGNMENT_CENTER: 'center',
  ALIGNMENT_JUSTIFIED: 'left',
  ALIGNMENT_NATURAL: 'left',
};

interface Ctx {
  item: string;
  log: ImportLogEntry[];
  media: MediaResolver;
  skipped: Map<string, number>;
  /** Things that were handled approximately (counted, logged once per document). */
  approximated: Map<string, number>;
  rtfMixed: number;
}

function note(ctx: Ctx, level: ImportLogLevel, message: string) {
  ctx.log.push({ level, item: ctx.item, message });
}

function skip(ctx: Ctx, what: string) {
  ctx.skipped.set(what, (ctx.skipped.get(what) ?? 0) + 1);
}

function approx(ctx: Ctx, what: string) {
  ctx.approximated.set(what, (ctx.approximated.get(what) ?? 0) + 1);
}

/** Text attributes ProPresenter applies at render time that the slide text cannot carry as styling. */
function noteTextTransforms(t: Msg, attrs: Msg, ctx: Ctx): { allCaps: boolean } {
  const cap = attrs.capitalization as string | undefined;
  let allCaps = false;
  if (cap && cap !== 'CAPITALIZATION_NONE') {
    if (cap === 'CAPITALIZATION_ALL_CAPS') {
      allCaps = true;
    } else skip(ctx, `${cap.replace('CAPITALIZATION_', '').toLowerCase().replace(/_/g, ' ')} capitalization`);
  }
  // ProPresenter also writes the box-level capitalization as a custom attribute over the whole text; only
  // a range that differs from the box is a partial transform ordo cannot carry.
  const custom = (attrs.customAttributes ?? []) as Msg[];
  if (
    custom.some(
      (c) => c.capitalization && c.capitalization !== 'CAPITALIZATION_NONE' && c.capitalization !== cap,
    )
  )
    skip(ctx, 'capitalization of part of a text');
  const tr = t.transform as string | undefined;
  if (tr && tr !== 'TRANSFORM_NONE')
    skip(ctx, `text transform ${tr.replace('TRANSFORM_', '').toLowerCase().replace(/_/g, ' ')}`);
  return { allCaps };
}

function textObjectFrom(el: Msg, size: SlideSize, ctx: Ctx): TextObject | null {
  const t = el.text as Msg;
  const rtf = t.rtfData as Uint8Array | undefined;
  if (!rtf || rtf.length === 0) return null;
  const parsed = parseRtf(rtf);
  const scale = slideScale(size).s;
  const attrs = (t.attributes ?? {}) as Msg;
  const font = (attrs.font ?? {}) as Msg;
  if (parsed.styleRuns > 1) ctx.rtfMixed++;
  if (parsed.plain) approx(ctx, 'plain-text (non-RTF) elements imported with the attribute style only');
  const { allCaps } = noteTextTransforms(t, attrs, ctx);
  const text = parsed.text;

  const base = DEFAULT_THEME.textBoxDefaults;
  const nameFromRtf = parsed.fontName ? splitFontName(parsed.fontName) : undefined;
  const nameFromAttrs = typeof font.name === 'string' && font.name ? splitFontName(font.name) : undefined;
  const family =
    (typeof font.family === 'string' && font.family) || nameFromRtf?.family || nameFromAttrs?.family;
  const weight = font.bold || parsed.bold ? 700 : (nameFromRtf?.weight ?? nameFromAttrs?.weight ?? 400);
  const italic = !!(font.italic || parsed.italic || nameFromRtf?.italic || nameFromAttrs?.italic);
  const sizePt = parsed.fontSizePt ?? (typeof font.size === 'number' ? font.size : undefined);
  const color = parsed.color ?? colorOf(attrs.textSolidFill) ?? base.color;
  const paraAlign = PARA_ALIGN[(attrs.paragraphStyle as Msg | undefined)?.alignment as string];
  const style: TextStyle = {
    ...base,
    fontFamily: family || base.fontFamily,
    fontWeight: weight,
    fontStyle: italic ? 'italic' : 'normal',
    fontSizePx: sizePt ? Math.round(sizePt * scale * 100) / 100 : base.fontSizePx,
    color,
    align: parsed.align ?? paraAlign ?? 'center',
    valign: VALIGN[t.verticalAlignment as string] ?? 'top',
    padding: 0,
    outline: undefined,
    shadow: undefined,
    transform: allCaps ? 'uppercase' : 'none',
  };
  const para = attrs.paragraphStyle as Msg | undefined;
  if (typeof para?.lineHeightMultiple === 'number' && para.lineHeightMultiple > 0)
    style.lineHeight = Math.round(para.lineHeightMultiple * 100) / 100;
  if (typeof attrs.kerning === 'number' && attrs.kerning !== 0)
    style.letterSpacing = Math.round(attrs.kerning * scale * 100) / 100;
  const margins = t.margins as Msg | undefined;
  if (margins) {
    const m = Math.max(margins.left ?? 0, margins.right ?? 0, margins.top ?? 0, margins.bottom ?? 0);
    if (m > 0) style.padding = Math.round(m * scale * 100) / 100;
  }
  // Outline: Cocoa's stroke width is a percentage of the font size, in the attributes as is (-3) and in the
  // RTF x20 (\strokewidth-60); negative means stroke and fill. Both give the same width.
  const strokeEl = el.stroke as Msg | undefined;
  if (typeof attrs.strokeWidth === 'number' && attrs.strokeWidth !== 0) {
    const pct = Math.abs(attrs.strokeWidth);
    style.outline = {
      width: Math.max(1, Math.round(((pct / 100) * style.fontSizePx + Number.EPSILON) * 10) / 10),
      color: colorOf(attrs.strokeColor) ?? { r: 0, g: 0, b: 0, a: 1 },
    };
  } else if (parsed.strokeWidth) {
    const pct = Math.abs(parsed.strokeWidth) / 20;
    style.outline = {
      width: Math.max(1, Math.round(((pct / 100) * style.fontSizePx + Number.EPSILON) * 10) / 10),
      color: parsed.strokeColor ?? { r: 0, g: 0, b: 0, a: 1 },
    };
  } else if (strokeEl?.enable && strokeEl.width > 0) {
    // Element (box) stroke, not a text outline: logged.
    skip(ctx, 'text box borders');
  }
  style.shadow = shadowOf(t.shadow, scale);
  if (!style.shadow && (el.shadow as Msg | undefined)?.enable) skip(ctx, 'text box shadows');
  const fill = el.fill as Msg | undefined;
  if (fill?.enable && fill.color) {
    const c = colorOf(fill.color);
    if (c && c.a > 0) style.fill = { color: c, radius: 0 };
  } else if (fill?.enable && fill.gradient) {
    // A gradient box fill becomes its first stop's colour (the editor has no gradients).
    const stops = ((fill.gradient as Msg).stops ?? []) as Msg[];
    const c = colorOf(stops[0]?.color);
    if (c && c.a > 0) {
      style.fill = { color: c, radius: 0 };
      approx(ctx, 'gradient box fills (first colour used)');
    }
  }
  return {
    id: newId(),
    type: 'text',
    box: scaleBox(el.bounds, size, el.rotation ?? 0),
    text,
    style,
    opacity: typeof el.opacity === 'number' ? el.opacity : 1,
  };
}

/** A rectangle or ellipse with a solid fill and/or a stroke; other shapes are skipped. */
function shapeObjectFrom(el: Msg, size: SlideSize, ctx: Ctx): ShapeObject | null {
  const type = ((el.path as Msg | undefined)?.shape as Msg | undefined)?.type as string | undefined;
  const shape = type === 'TYPE_RECTANGLE' ? 'rect' : type === 'TYPE_ELLIPSE' ? 'ellipse' : undefined;
  if (!shape) return null;
  const fillMsg = el.fill as Msg | undefined;
  const strokeMsg = el.stroke as Msg | undefined;
  const fill = fillMsg?.enable
    ? colorOf(
        fillMsg.color ?? ((fillMsg.gradient as Msg | undefined)?.stops as Msg[] | undefined)?.[0]?.color,
      )
    : undefined;
  if (fillMsg?.enable && fillMsg.gradient && !fillMsg.color)
    approx(ctx, 'gradient shape fills (first colour used)');
  const scale = slideScale(size).s;
  const stroke =
    strokeMsg?.enable && typeof strokeMsg.width === 'number' && strokeMsg.width > 0
      ? {
          width: Math.round(strokeMsg.width * scale * 100) / 100,
          color: colorOf(strokeMsg.color) ?? { r: 0, g: 0, b: 0, a: 1 },
        }
      : undefined;
  if (!fill && !stroke) return null;
  const obj: ShapeObject = {
    id: newId(),
    type: 'shape',
    box: scaleBox(el.bounds, size, el.rotation ?? 0),
    shape,
    opacity: typeof el.opacity === 'number' ? el.opacity : 1,
    radius: 0,
  };
  if (fill) obj.fill = fill;
  if (stroke) obj.stroke = stroke;
  return obj;
}

function imageObjectFrom(el: Msg, size: SlideSize, ctx: Ctx): ImageObject | null {
  const mediaMsg = (el.fill as Msg | undefined)?.media as Msg | undefined;
  const paths = pro7UrlPaths(mediaMsg?.url);
  const path = paths[0];
  if (!path) return null;
  if (mediaMsg && ['liveVideo', 'webContent', 'audio'].includes(mediaElementKind(mediaMsg))) {
    skip(ctx, 'live video, web and audio elements');
    return null;
  }
  const id = ctx.media.resolve(paths, (m) => note(ctx, 'warn', m), ctx.item);
  if (!id) return null;
  const drawing = ((mediaMsg?.image ?? mediaMsg?.video) as Msg | undefined)?.drawing as Msg | undefined;
  const sb = drawing?.scaleBehavior as string | undefined;
  return {
    id: newId(),
    type: 'image',
    box: scaleBox(el.bounds, size, el.rotation ?? 0),
    mediaId: id,
    fit: sb === 'SCALE_BEHAVIOR_FILL' ? 'cover' : sb === 'SCALE_BEHAVIOR_STRETCH' ? 'stretch' : 'contain',
    opacity: typeof el.opacity === 'number' ? el.opacity : 1,
    radius: 0,
  };
}

const SKIPPED_ACTIONS: Record<string, string> = {
  ACTION_TYPE_STAGE_LAYOUT: 'stage layouts',
  ACTION_TYPE_TIMER: 'timers',
  ACTION_TYPE_COMMUNICATION: 'communication actions',
  ACTION_TYPE_CLEAR: 'clear actions',
  ACTION_TYPE_PROP: 'props',
  ACTION_TYPE_MASK: 'masks',
  ACTION_TYPE_MESSAGE: 'messages',
  ACTION_TYPE_SOCIAL_MEDIA: 'social media actions',
  ACTION_TYPE_MULTISCREEN: 'multiscreen actions',
  ACTION_TYPE_PRESENTATION_DOCUMENT: 'presentation document actions',
  ACTION_TYPE_PROP_SLIDE: 'prop slides',
  ACTION_TYPE_EXTERNAL_PRESENTATION: 'external presentations',
  ACTION_TYPE_AUDIENCE_LOOK: 'looks',
  ACTION_TYPE_AUDIO_INPUT: 'audio routing',
  ACTION_TYPE_AUDIO_BIN_PLAYLIST: 'audio bin playlists',
  ACTION_TYPE_MEDIA_BIN_PLAYLIST: 'media bin playlists',
  ACTION_TYPE_SLIDE_DESTINATION: 'slide destinations',
  ACTION_TYPE_MACRO: 'macros',
  ACTION_TYPE_CLEAR_GROUP: 'clear groups',
};

function actionKind(a: Msg): string {
  if (typeof a.type === 'string' && a.type !== 'ACTION_TYPE_UNKNOWN') return a.type;
  if (a.slide) return 'ACTION_TYPE_PRESENTATION_SLIDE';
  if (a.media) return 'ACTION_TYPE_MEDIA';
  if (a.macro) return 'ACTION_TYPE_MACRO';
  if (a.timer) return 'ACTION_TYPE_TIMER';
  if (a.stage) return 'ACTION_TYPE_STAGE_LAYOUT';
  if (a.audienceLook) return 'ACTION_TYPE_AUDIENCE_LOOK';
  if (a.clear) return 'ACTION_TYPE_CLEAR';
  if (a.prop) return 'ACTION_TYPE_PROP';
  if (a.message) return 'ACTION_TYPE_MESSAGE';
  return 'ACTION_TYPE_UNKNOWN';
}

/**
 * The kind of media an action or fill refers to. The element's `TypeProperties` oneof is authoritative;
 * the action's own `MediaType` playback oneof is a fallback (ProPresenter's exports put an empty `audio`
 * block on image actions, so it cannot be trusted on its own).
 */
export function mediaElementKind(
  m: Msg,
): 'image' | 'video' | 'audio' | 'liveVideo' | 'webContent' | 'unknown' {
  const el = (m.element ?? m) as Msg;
  for (const k of ['image', 'video', 'audio', 'liveVideo', 'webContent'] as const) if (el[k]) return k;
  if (m.element) for (const k of ['image', 'video', 'audio', 'liveVideo'] as const) if (m[k]) return k;
  return 'unknown';
}

/** Map one cue to a slide (null when the cue has no slide). Background media from media actions. */
function slideFromCue(cue: Msg, ctx: Ctx): Slide | null {
  if (cue.isEnabled === false) {
    skip(ctx, 'disabled cues');
    return null;
  }
  if (typeof cue.name === 'string' && cue.name.trim()) skip(ctx, 'slide labels');
  let base: Msg | undefined;
  let notes: string | undefined;
  let backgroundMediaId: string | undefined;
  let hasTransition = false;
  for (const a of (cue.actions ?? []) as Msg[]) {
    if (a.isEnabled === false) continue;
    const kind = actionKind(a);
    if (kind === 'ACTION_TYPE_PRESENTATION_SLIDE') {
      const ps = (a.slide as Msg | undefined)?.presentation as Msg | undefined;
      if (ps?.baseSlide && !base) {
        base = ps.baseSlide;
        if (ps.notes?.rtfData?.length) {
          const t = parseRtf(ps.notes.rtfData as Uint8Array).text;
          if (t.trim()) notes = t;
        }
        if (ps.transition) hasTransition = true;
      } else if ((a.slide as Msg | undefined)?.prop) skip(ctx, 'prop slides');
      continue;
    }
    if (
      kind === 'ACTION_TYPE_MEDIA' ||
      kind === 'ACTION_TYPE_BACKGROUND_MEDIA' ||
      kind === 'ACTION_TYPE_FOREGROUND_MEDIA'
    ) {
      const m = a.media as Msg | undefined;
      if (!m) continue;
      // What the media is comes from the element (its `image`/`video`/`audio` properties), not from the
      // action's playback settings: ProPresenter writes an empty `audio` playback block on image actions.
      const kind = mediaElementKind(m);
      if (kind === 'audio') {
        skip(ctx, 'audio cues');
        continue;
      }
      if (kind === 'liveVideo' || kind === 'webContent') {
        skip(ctx, 'live video cues');
        continue;
      }
      const paths = pro7UrlPaths((m.element as Msg | undefined)?.url);
      const path = paths[0];
      if (!path) continue;
      if (backgroundMediaId) {
        skip(ctx, 'additional media actions on one slide');
        continue;
      }
      if (m.layerType === 'LAYER_TYPE_FOREGROUND') {
        note(ctx, 'info', `foreground media ${basename(path)} imported as the slide background`);
      }
      backgroundMediaId = ctx.media.resolve(paths, (msg) => note(ctx, 'warn', msg), ctx.item);
      continue;
    }
    const what = SKIPPED_ACTIONS[kind];
    skip(ctx, what ?? 'unknown actions');
  }
  if (!base && !backgroundMediaId) return null;
  if (hasTransition) skip(ctx, 'per-slide transitions');
  const sizeMsg = base?.size as Msg | undefined;
  const size: SlideSize = {
    width: sizeMsg?.width > 0 ? sizeMsg!.width : LOGICAL_WIDTH,
    height: sizeMsg?.height > 0 ? sizeMsg!.height : LOGICAL_HEIGHT,
  };
  const objects: SlideObject[] = [];
  let lyricObjectId: string | undefined;
  for (const se of (base?.elements ?? []) as Msg[]) {
    const el = se.element as Msg | undefined;
    if (!el) continue;
    if (se.buildIn || se.buildOut || (se.childBuilds?.length ?? 0) > 0) skip(ctx, 'builds and animations');
    // Every ProPresenter text box carries a visibility link; only a link that replaces the words matters.
    const links = ((se.dataLinks ?? []) as Msg[]).filter((l) => !l.visibilityLink);
    if (links.length) skip(ctx, 'linked text (timers, clocks, stage data) imported as last saved');
    if (el.hidden) {
      skip(ctx, 'hidden elements');
      continue;
    }
    if (el.text?.rtfData?.length) {
      const to = textObjectFrom(el, size, ctx);
      if (to) {
        objects.push(to);
        if (!lyricObjectId) lyricObjectId = to.id;
      }
      continue;
    }
    if (el.text && !(el.fill as Msg | undefined)?.media) {
      // A text box with no RTF at all (an emptied placeholder or a template box): nothing to show.
      skip(ctx, 'empty text elements');
      continue;
    }
    if ((el.fill as Msg | undefined)?.media) {
      const io = imageObjectFrom(el, size, ctx);
      if (io) objects.push(io);
      continue;
    }
    const so = shapeObjectFrom(el, size, ctx);
    if (so) objects.push(so);
    else if (el.fill?.enable || el.stroke?.enable) skip(ctx, 'shapes');
  }
  if (base?.drawsBackgroundColor) skip(ctx, 'slide background colours');
  const slide: Slide = { id: newId(), objects };
  if (lyricObjectId) slide.lyricObjectId = lyricObjectId;
  if (backgroundMediaId) slide.backgroundMediaId = backgroundMediaId;
  if (notes) slide.notes = notes;
  if (
    typeof cue.completionTime === 'number' &&
    cue.completionTime > 0 &&
    cue.completionActionType === 'COMPLETION_ACTION_TYPE_AFTER_TIME'
  ) {
    slide.durationMs = Math.round(cue.completionTime * 1000);
  }
  return slide;
}

export type Pro7PresentationResult = {
  presentation: Presentation;
  /** ProPresenter UUID of the document (for playlists). */
  pro7Uuid?: string;
  /** Document name and cue count as stored, for telling a copy from a second reference to one document. */
  name: string;
  cueCount: number;
  /** ProPresenter arrangement UUID to ordo arrangement id. */
  arrangementIds: Map<string, string>;
  arrangementNames: Map<string, string>;
};

/** Map a decoded rv.data.Presentation to an ordo presentation. */
export function mapPresentation(
  doc: Msg,
  opts: { item: string; log: ImportLogEntry[]; media: MediaResolver; fileName?: string; id?: string },
): Pro7PresentationResult {
  const ctx: Ctx = {
    item: opts.item,
    log: opts.log,
    media: opts.media,
    skipped: new Map(),
    approximated: new Map(),
    rtfMixed: 0,
  };
  const cuesById = new Map<string, Msg>();
  for (const c of (doc.cues ?? []) as Msg[]) {
    const id = uuidOf(c.uuid);
    if (id) cuesById.set(id, c);
  }
  const used = new Set<string>();
  const sections: Section[] = [];
  const sectionByGroup = new Map<string, string>();
  let knownLabels = 0;
  for (const cg of (doc.cueGroups ?? []) as Msg[]) {
    const group = (cg.group ?? {}) as Msg;
    const lbl = sectionLabelFor(group.name);
    if (lbl.known) knownLabels++;
    const slides: Slide[] = [];
    for (const cid of (cg.cueIdentifiers ?? []) as Msg[]) {
      const id = uuidOf(cid);
      if (!id) continue;
      const cue = cuesById.get(id);
      if (!cue) {
        note(ctx, 'warn', `group "${lbl.label}" references a missing cue ${id}`);
        continue;
      }
      // A cue listed twice (in one group or across groups) is one slide, at its first place.
      if (used.has(id)) continue;
      used.add(id);
      const s = slideFromCue(cue, ctx);
      if (s) slides.push(s);
    }
    const section: Section = { id: newId(), label: lbl.label, short: lbl.short, slides };
    sections.push(section);
    const gid = uuidOf(group.uuid);
    if (gid) sectionByGroup.set(gid, section.id);
  }
  // Cues that belong to no group still become slides, in document order.
  const loose: Slide[] = [];
  for (const [id, cue] of cuesById) {
    if (used.has(id)) continue;
    const s = slideFromCue(cue, ctx);
    if (s) loose.push(s);
  }
  if (loose.length) {
    sections.push({ id: newId(), label: 'Slides', short: 'S', slides: loose });
    if (sections.length > 1) note(ctx, 'info', `${loose.length} slide(s) outside any group put in "Slides"`);
  }

  // Arrangements; ProPresenter's selected arrangement first so it is the default.
  const arrangementIds = new Map<string, string>();
  const arrangementNames = new Map<string, string>();
  const arrangements: Arrangement[] = [];
  const selected = uuidOf(doc.selectedArrangement);
  for (const a of (doc.arrangements ?? []) as Msg[]) {
    const sectionIds: string[] = [];
    for (const g of (a.groupIdentifiers ?? []) as Msg[]) {
      const gid = uuidOf(g);
      const sid = gid ? sectionByGroup.get(gid) : undefined;
      if (sid) sectionIds.push(sid);
      else note(ctx, 'warn', `arrangement "${a.name ?? ''}" references a missing group`);
    }
    const arr: Arrangement = { id: newId(), name: (a.name as string) || 'Arrangement', sectionIds };
    const pid = uuidOf(a.uuid);
    if (pid) arrangementIds.set(pid, arr.id);
    if (arr.name && !arrangementNames.has(arr.name.toLowerCase()))
      arrangementNames.set(arr.name.toLowerCase(), arr.id);
    if (pid && pid === selected) arrangements.unshift(arr);
    else arrangements.push(arr);
  }
  if (arrangements.length === 0) {
    arrangements.push({ id: newId(), name: 'Default', sectionIds: sections.map((s) => s.id) });
  }

  // Background: a media file shared by every slide that has one becomes the presentation background.
  const allSlides = sections.flatMap((s) => s.slides);
  const bgs = new Set(allSlides.map((s) => s.backgroundMediaId).filter((x): x is string => !!x));
  let backgroundMediaId: string | undefined;
  if (bgs.size === 1 && allSlides.length > 0) {
    const [only] = bgs;
    const first = allSlides.find((s) => s.backgroundMediaId);
    // Only lift it when the first slide sets it (ProPresenter keeps a background running until cleared).
    if (first === allSlides[0]) {
      backgroundMediaId = only;
      for (const s of allSlides) delete s.backgroundMediaId;
    }
  }
  const bg = doc.background as Msg | undefined;
  if (bg?.isEnabled && (bg.color || bg.gradient)) skip(ctx, 'presentation background colour');
  if (doc.transition) skip(ctx, 'presentation transition');
  if (doc.timeline?.cues?.length || doc.timeline?.cuesV2?.length || doc.timeline?.audioAction)
    skip(ctx, 'timelines');
  // Every ProPresenter slide carries an empty chord-chart URL (platform only); only a real file counts.
  if (pro7UrlPath(doc.chordChart as Msg | undefined)) skip(ctx, 'chord charts');

  const ccli = (doc.ccli ?? {}) as Msg;
  const title =
    (typeof doc.name === 'string' && doc.name.trim()) ||
    (typeof ccli.songTitle === 'string' && ccli.songTitle.trim()) ||
    (opts.fileName ? stripExt(basename(opts.fileName)) : 'Untitled');
  // ProPresenter's publisher field usually starts with the year already ("2012 Hillsong Music").
  const publisher = String(ccli.publisher ?? '').trim();
  const year = ccli.copyrightYear ? String(ccli.copyrightYear) : '';
  const copyright = (year && !publisher.startsWith(year) ? `${year} ${publisher}` : publisher).trim();
  const isSong = !!ccli.songNumber || (sections.length > 0 && knownLabels >= Math.ceil(sections.length / 2));
  const meta: Presentation['meta'] = { tags: [] };
  // Author and artist credits are both kept when they differ ("John Newton" / "Chris Tomlin").
  const credits = [ccli.author, ccli.artistCredits]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x, i, arr) => x && arr.indexOf(x) === i);
  if (credits.length) meta.author = credits.join(' / ');
  if (ccli.songNumber) meta.ccli = String(ccli.songNumber);
  if (copyright) meta.copyright = copyright;
  const key =
    (doc.music as Msg | undefined)?.userMusicKey || (doc.music as Msg | undefined)?.originalMusicKey;
  if (typeof key === 'string' && key) meta.key = key;
  if (typeof doc.category === 'string' && doc.category) meta.tags.push(doc.category);

  if (ctx.rtfMixed > 0) {
    note(ctx, 'info', `${ctx.rtfMixed} text element(s) had mixed styles; the first run's style was used`);
  }
  for (const [what, count] of ctx.approximated) note(ctx, 'info', `${what} (${count})`);
  for (const [what, count] of ctx.skipped) note(ctx, 'info', `skipped ${what} (${count})`);

  const slideCount = allSlides.length;
  const presentation: Presentation = {
    id: opts.id ?? newId(),
    rev: 1,
    title,
    kind: isSong ? 'song' : 'slides',
    meta,
    sections,
    arrangements,
    source: { kind: 'pro7' },
    archived: false,
  };
  if (backgroundMediaId) presentation.backgroundMediaId = backgroundMediaId;
  sanitizePresentation(presentation);
  note(
    ctx,
    slideCount === 0 ? 'warn' : 'info',
    `imported "${title}": ${sections.length} section(s), ${slideCount} slide(s), ${arrangements.length} arrangement(s)`,
  );
  return {
    presentation,
    pro7Uuid: uuidOf(doc.uuid),
    name: typeof doc.name === 'string' ? doc.name.trim() : '',
    cueCount: Array.isArray(doc.cues) ? doc.cues.length : 0,
    arrangementIds,
    arrangementNames,
  };
}

/** The ordo id an imported document keeps across imports (ProPresenter UUIDs are stable). */
export function pro7PresentationId(uuid: string): string {
  return `pro7-${uuid.toLowerCase()}`;
}

function looksLikePresentation(doc: Msg): boolean {
  return Array.isArray(doc.cues) || Array.isArray(doc.cueGroups) || typeof doc.name === 'string';
}

/** Is this file (by path) a playlist document candidate, as `importPro7` decides it? */
export function isPlaylistCandidate(path: string): boolean {
  const lower = path.toLowerCase();
  const base = basename(lower);
  if (lower.endsWith('.pro') || MEDIA_EXT.test(lower)) return false;
  if (base === 'data' || lower.endsWith('.proplaylist')) return true;
  // Library playlist documents live in ProPresenter/Playlists/<name> without an extension.
  return /(^|\/)playlists\/[^/]+$/.test(lower) && !base.includes('.');
}

type PresRef = Pro7PresRef;

/**
 * Import a ProPresenter 7 library or export from its files: `.pro` documents, playlist documents (library
 * `Playlists/*` files or the `data` file inside a `.proPlaylist` bundle) and the media they reference.
 * With `opts` one batch of a larger import (see `Pro7ImportOptions`).
 */
export function importPro7(files: Map<string, Uint8Array>, opts: Pro7ImportOptions = {}): Pro7ImportResult {
  const phase = opts.phase ?? 'all';
  const log: ImportLogEntry[] = [{ level: 'info', message: `ProPresenter 7 proto ${PRO7_PROTO_VERSION}` }];
  const media = new MediaResolver(files);
  const presentations: Presentation[] = [];
  const refs: PresRef[] = [...(opts.refs ?? [])];
  const paths = [...files.keys()].sort();

  for (const path of paths) {
    if (phase === 'playlists' || !/\.pro$/i.test(path)) continue;
    const item = basename(path);
    try {
      const doc = decodeAs('rv.data.Presentation', files.get(path)!);
      if (!looksLikePresentation(doc)) {
        log.push({ level: 'error', item, message: 'not a ProPresenter 7 presentation' });
        continue;
      }
      // The same document can appear twice (library folder and a .proPlaylist bundle): import it once.
      // A copied document keeps its UUID in ProPresenter, so the name and cue count must match too.
      const docUuid = uuidOf(doc.uuid as Msg | undefined);
      const sameUuid = docUuid ? refs.filter((r) => r.pro7Uuid === docUuid) : [];
      const cueCount = Array.isArray(doc.cues) ? doc.cues.length : 0;
      const name = typeof doc.name === 'string' ? doc.name.trim() : '';
      const dup = sameUuid.find((r) => r.name === name && r.cueCount === cueCount);
      if (dup) {
        log.push({ level: 'info', item, message: `same document as ${basename(dup.path)}; imported once` });
        refs.push({ ...dup, path });
        continue;
      }
      if (sameUuid.length > 0) {
        const other = sameUuid.find((r) => r.name === name) ?? sameUuid[0]!;
        log.push({
          level: 'warn',
          item,
          message:
            `same ProPresenter UUID as ${basename(other.path)} but a different ` +
            `${other.name !== name ? 'name' : 'slide count'}; imported both`,
        });
      }
      // A stable ordo id from the ProPresenter UUID, so importing the library again updates the earlier
      // copy instead of adding a second one; a copy with the same UUID but other content gets a suffix.
      let id: string | undefined;
      if (docUuid) {
        id = pro7PresentationId(docUuid);
        for (let n = 2; refs.some((r) => r.id === id) || presentations.some((p) => p.id === id); n++)
          id = `${pro7PresentationId(docUuid)}-${n}`;
      }
      const result = mapPresentation(doc, { item, log, media, fileName: path, id });
      presentations.push(result.presentation);
      refs.push({
        path,
        id: result.presentation.id,
        title: result.presentation.title,
        pro7Uuid: result.pro7Uuid,
        name: result.name,
        cueCount: result.cueCount,
        arrangementIds: result.arrangementIds,
        arrangementNames: result.arrangementNames,
      });
    } catch (e) {
      log.push({ level: 'error', item, message: `could not decode: ${(e as Error).message}` });
    }
  }

  const playlists: Playlist[] = [];
  for (const path of paths) {
    if (phase === 'documents' || !isPlaylistCandidate(path)) continue;
    const item = basename(path) === 'data' ? basename(path.replace(/\/data$/, '')) : basename(path);
    let doc: Msg;
    try {
      doc = decodeAs('rv.data.PlaylistDocument', files.get(path)!);
    } catch (e) {
      log.push({ level: 'warn', item, message: `not a playlist document: ${(e as Error).message}` });
      continue;
    }
    if (!doc.rootNode) {
      log.push({ level: 'warn', item, message: 'not a playlist document' });
      continue;
    }
    if (doc.type === 'TYPE_AUDIO' || doc.type === 'TYPE_MEDIA') {
      log.push({ level: 'info', item, message: 'skipped media/audio bin document' });
      continue;
    }
    const before = playlists.length;
    try {
      collectPlaylists(doc.rootNode as Msg, [], { item, path, log, media, refs, out: playlists });
    } catch (e) {
      log.push({ level: 'error', item, message: `playlist could not be read: ${(e as Error).message}` });
    }
    log.push({ level: 'info', item, message: `imported ${playlists.length - before} playlist(s)` });
  }

  const usedMedia = new Map<string, string>(media.found);
  // Media a slide or presentation uses as its background is marked so the hub files it as a background.
  const backgrounds = new Set<string>();
  for (const p of presentations) {
    if (p.backgroundMediaId) backgrounds.add(p.backgroundMediaId);
    for (const sec of p.sections)
      for (const sl of sec.slides) if (sl.backgroundMediaId) backgrounds.add(sl.backgroundMediaId);
  }
  return {
    presentations,
    playlists,
    media: [...usedMedia].map(([key, path]) => ({ key, path, background: backgrounds.has(key) })),
    log,
    protoVersion: PRO7_PROTO_VERSION,
    refs,
  };
}

interface PlCtx {
  item: string;
  /** The playlist document's path inside the import (its `.proPlaylist` bundle directory, if any). */
  path: string;
  log: ImportLogEntry[];
  media: MediaResolver;
  refs: PresRef[];
  out: Playlist[];
}

/**
 * The imported document a playlist item points at. Matches are ranked: the exact path, a path suffix,
 * a document shipped inside the same `.proPlaylist` bundle as this playlist, any document with the same
 * file name, and finally the item's name. The best rank wins, so a library's "Archive/Amazing Grace.pro"
 * never beats the "Songs/Amazing Grace.pro" the playlist names.
 */
function findPresentation(item: Msg, refs: PresRef[], bundleDir: string): PresRef | undefined {
  const pres = item.presentation as Msg | undefined;
  const docPath = pro7UrlPath(pres?.documentPath);
  let best: { rank: number; ref: PresRef } | undefined;
  const consider = (rank: number, ref: PresRef) => {
    if (!best || rank < best.rank) best = { rank, ref };
  };
  if (docPath) {
    const lower = docPath.toLowerCase().replace(/^\/+/, '');
    const base = basename(lower);
    const dir = bundleDir.toLowerCase();
    for (const r of refs) {
      const rp = r.path.toLowerCase();
      if (lower === rp || lower.endsWith('/' + rp)) consider(0, r);
      else if (rp.endsWith('/' + lower)) consider(1, r);
      else if (basename(rp) === base) consider(dir && dirname(rp) === dir ? 2 : 3, r);
    }
  }
  if (!best) {
    const name = (typeof item.name === 'string' ? item.name : '').trim().toLowerCase();
    if (name) {
      const byName = refs.find((r) => r.title.trim().toLowerCase() === name);
      if (byName) consider(4, byName);
    }
  }
  return best?.ref;
}

function collectPlaylists(node: Msg, trail: string[], ctx: PlCtx, depth = 0): void {
  const name = clipText((typeof node.name === 'string' && node.name) || 'Playlist', IMPORT_LIMITS.name);
  if (depth > PLAYLIST_MAX_DEPTH) {
    ctx.log.push({ level: 'warn', item: ctx.item, message: `skipped playlist "${name}": nested too deep` });
    return;
  }
  const children: Msg[] = [
    ...(((node.playlists as Msg | undefined)?.playlists ?? []) as Msg[]),
    ...((node.children ?? []) as Msg[]),
  ];
  const isRoot = node.type === 'TYPE_ROOT' || (depth === 0 && !node.items && children.length > 0);
  if (node.type === 'TYPE_SMART') {
    ctx.log.push({ level: 'info', item: ctx.item, message: `skipped smart playlist "${name}"` });
    return;
  }
  if (children.length > 0) {
    const nextTrail = isRoot ? trail : [...trail, name];
    for (const c of children) collectPlaylists(c, nextTrail, ctx, depth + 1);
  }
  const items = ((node.items as Msg | undefined)?.items ?? []) as Msg[];
  if (isRoot || (node.type === 'TYPE_GROUP' && items.length === 0)) return;
  if (!node.items && children.length > 0) return;
  const plName = clipText([...trail, name].join(' / '), IMPORT_LIMITS.name);
  const out: PlaylistItem[] = [];
  const skipped = new Map<string, number>();
  const bump = (k: string) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  for (const it of items) {
    if (it.presentation) {
      if (it.isHidden === true) {
        bump('hidden items');
        continue;
      }
      const ref = findPresentation(it, ctx.refs, dirname(ctx.path));
      if (!ref) {
        ctx.log.push({
          level: 'warn',
          item: ctx.item,
          message: `playlist "${plName}": presentation "${it.name ?? '?'}" was not in the import`,
        });
        continue;
      }
      // The arrangement by UUID, else by its name (ProPresenter writes `arrangement_name` alongside, and
      // in exported playlists the UUID can belong to an arrangement the document no longer carries).
      const presItem = it.presentation as Msg;
      const arrUuid = uuidOf(presItem.arrangement);
      const arrName = typeof presItem.arrangementName === 'string' ? presItem.arrangementName.trim() : '';
      let arrangementId = arrUuid ? ref.arrangementIds.get(arrUuid) : undefined;
      if (!arrangementId && arrName) arrangementId = ref.arrangementNames.get(arrName.toLowerCase());
      if (!arrangementId && (arrUuid || arrName) && ref.arrangementIds.size > 0)
        ctx.log.push({
          level: 'warn',
          item: ctx.item,
          message: `playlist "${plName}": arrangement ${arrName ? `"${arrName}"` : arrUuid} of "${ref.title}" was not found; the default is used`,
        });
      const pi: PlaylistItem = {
        id: newId(),
        kind: 'presentation',
        presentationId: ref.id,
      };
      if (arrangementId) pi.arrangementId = arrangementId;
      out.push(pi);
      continue;
    }
    if (it.cue) {
      const cue = it.cue as Msg;
      let added = false;
      let unresolved = false;
      for (const a of (cue.actions ?? []) as Msg[]) {
        const m = a.media as Msg | undefined;
        if (!m || mediaElementKind(m) === 'liveVideo' || mediaElementKind(m) === 'webContent') continue;
        const paths = pro7UrlPaths((m.element as Msg | undefined)?.url);
        if (paths.length === 0) continue;
        const key = ctx.media.resolve(
          paths,
          (msg) => ctx.log.push({ level: 'warn', item: ctx.item, message: `playlist "${plName}": ${msg}` }),
          ctx.path,
        );
        if (!key) {
          unresolved = true;
          break;
        }
        const video = m.video as Msg | undefined;
        const loop = video?.playbackBehavior === 'PLAYBACK_BEHAVIOR_LOOP';
        const end = video?.endBehavior as string | undefined;
        const mi: PlaylistItem = { id: newId(), kind: 'media', mediaId: key };
        if (loop) mi.loop = true;
        if (end === 'END_BEHAVIOR_STOP_ON_BLACK' || end === 'END_BEHAVIOR_FADE_TO_BLACK') mi.onEnd = 'black';
        else if (end === 'END_BEHAVIOR_STOP_ON_CLEAR' || end === 'END_BEHAVIOR_FADE_TO_CLEAR')
          mi.onEnd = 'black';
        if (m.audio) bump('audio cues imported as media');
        out.push(mi);
        added = true;
        break;
      }
      if (!added && !unresolved) bump('cues without media');
      continue;
    }
    if (it.header) {
      // ordo playlists have no divider item yet: the header's name is logged so the order of service can
      // be checked against ProPresenter.
      const hn = typeof it.name === 'string' && it.name.trim() ? it.name.trim() : '(unnamed)';
      ctx.log.push({
        level: 'info',
        item: ctx.item,
        message: `playlist "${plName}": header "${hn}" before item ${out.length + 1} not imported`,
      });
    } else if (it.planningCenter) bump('Planning Center items');
    else if (it.placeholder) bump('placeholders');
    else bump('unknown items');
  }
  for (const [what, n] of skipped) {
    ctx.log.push({ level: 'info', item: ctx.item, message: `playlist "${plName}": skipped ${what} (${n})` });
  }
  ctx.out.push({ id: newId(), rev: 1, name: plName, items: out });
}

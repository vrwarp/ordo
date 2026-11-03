import {
  type Arrangement,
  type Box,
  DEFAULT_THEME,
  type ImageObject,
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

export type ImportLogLevel = 'info' | 'warn' | 'error';
export type ImportLogEntry = { level: ImportLogLevel; item?: string; message: string };

export type Pro7ImportResult = {
  presentations: Presentation[];
  playlists: Playlist[];
  /** Media files referenced by the imported entities, keyed by the placeholder id used inside them. */
  media: { key: string; path: string }[];
  log: ImportLogEntry[];
  protoVersion: string;
};

/** Prefix of placeholder media ids inside imported entities; see `remapMediaIds`. */
export const PRO7_MEDIA_PREFIX = 'pro7media:';

const MEDIA_EXT =
  /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|jpe?g|png|gif|bmp|tiff?|heic|webp|wav|mp3|aac|m4a|flac|ogg|aiff?)$/i;

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

/** The file path a ProPresenter URL points at, with forward slashes and URL escapes decoded. */
export function pro7UrlPath(url: Msg | undefined): string | undefined {
  if (!url) return undefined;
  let raw: string | undefined;
  const local = url.local as Msg | undefined;
  if (typeof url.absoluteString === 'string' && url.absoluteString) raw = url.absoluteString;
  else if (typeof local?.path === 'string' && local.path) raw = local.path;
  else if (typeof url.relativePath === 'string' && url.relativePath) raw = url.relativePath;
  if (!raw) return undefined;
  let p = raw.replace(/^file:\/\/(localhost)?/i, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep as-is
  }
  p = p.replace(/\\/g, '/').replace(/^[a-zA-Z]:\//, '/');
  return p;
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
  /** Returns a placeholder id for the media, or undefined if the file is not in the import. */
  resolve(path: string | undefined, log: (m: string) => void): string | undefined {
    if (!path) return undefined;
    const norm = path.replace(/^\/+/, '');
    const key = PRO7_MEDIA_PREFIX + norm;
    if (this.found.has(key)) return key;
    const lower = norm.toLowerCase();
    let hit = this.byLower.get(lower);
    if (!hit) {
      // Longest relative suffix that matches an entry ("Media/Assets/x.mp4" inside "Library/Media/Assets/x.mp4").
      const segs = lower.split('/');
      for (let i = 1; i < segs.length - 1 && !hit; i++) {
        const suffix = segs.slice(i).join('/');
        for (const [k, v] of this.byLower) {
          if (k === suffix || k.endsWith('/' + suffix)) {
            hit = v;
            break;
          }
        }
      }
    }
    if (!hit) {
      const cands = this.byBase.get(basename(lower));
      if (cands && cands.length > 0) {
        hit = cands[0];
        if (cands.length > 1)
          log(`media "${basename(norm)}" matched ${cands.length} files by name; used ${hit}`);
      }
    }
    if (!hit) {
      log(`media file not found in import: ${norm}`);
      return undefined;
    }
    this.found.set(key, hit);
    return key;
  }
}

function colorOf(c: Msg | undefined): Rgba | undefined {
  if (!c) return undefined;
  const ch = (v: unknown) => Math.round(Math.max(0, Math.min(1, typeof v === 'number' ? v : 0)) * 255);
  return { r: ch(c.red), g: ch(c.green), b: ch(c.blue), a: typeof c.alpha === 'number' ? c.alpha : 1 };
}

function initials(label: string): string {
  const words = label.split(/[\s\-_/]+/).filter(Boolean);
  const num = /(\d+)$/.exec(label)?.[1] ?? '';
  const letters = words
    .filter((w) => !/^\d+$/.test(w))
    .map((w) => w[0]!.toUpperCase())
    .join('')
    .slice(0, 3);
  return (letters || label.slice(0, 2).toUpperCase()) + num;
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

function scaleBox(bounds: Msg | undefined, size: SlideSize, rotation: number): Box {
  const sx = LOGICAL_WIDTH / size.width;
  const sy = LOGICAL_HEIGHT / size.height;
  const o = bounds?.origin ?? {};
  const s = bounds?.size ?? {};
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    x: r((o.x ?? 0) * sx),
    y: r((o.y ?? 0) * sy),
    w: r((s.width ?? size.width) * sx),
    h: r((s.height ?? size.height) * sy),
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
      approx(ctx, 'ALL CAPS applied to the text itself');
    } else skip(ctx, `${cap.replace('CAPITALIZATION_', '').toLowerCase().replace(/_/g, ' ')} capitalization`);
  }
  const custom = (attrs.customAttributes ?? []) as Msg[];
  if (custom.some((c) => c.capitalization && c.capitalization !== 'CAPITALIZATION_NONE'))
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
  const scale = LOGICAL_HEIGHT / size.height;
  const attrs = (t.attributes ?? {}) as Msg;
  const font = (attrs.font ?? {}) as Msg;
  if (parsed.styleRuns > 1) ctx.rtfMixed++;
  if (parsed.plain) approx(ctx, 'plain-text (non-RTF) elements imported with the attribute style only');
  const { allCaps } = noteTextTransforms(t, attrs, ctx);
  const text = allCaps ? parsed.text.toUpperCase() : parsed.text;

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
  };
  const margins = t.margins as Msg | undefined;
  if (margins) {
    const m = Math.max(margins.left ?? 0, margins.right ?? 0, margins.top ?? 0, margins.bottom ?? 0);
    if (m > 0) style.padding = Math.round(m * scale * 100) / 100;
  }
  // Outline: Cocoa RTF \strokewidth is a percentage of the font size (x20 in RTF); the attributes carry
  // the stroke in points.
  const strokeEl = el.stroke as Msg | undefined;
  if (typeof attrs.strokeWidth === 'number' && attrs.strokeWidth !== 0) {
    style.outline = {
      width: Math.abs(attrs.strokeWidth) * scale,
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

function imageObjectFrom(el: Msg, size: SlideSize, ctx: Ctx): ImageObject | null {
  const mediaMsg = (el.fill as Msg | undefined)?.media as Msg | undefined;
  const path = pro7UrlPath(mediaMsg?.url);
  if (!path) return null;
  if (mediaMsg?.liveVideo || mediaMsg?.webContent || mediaMsg?.audio) {
    skip(ctx, 'live video, web and audio elements');
    return null;
  }
  const id = ctx.media.resolve(path, (m) => note(ctx, 'warn', m));
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

/** Map one cue to a slide (null when the cue has no slide). Background media from media actions. */
function slideFromCue(cue: Msg, ctx: Ctx): Slide | null {
  let base: Msg | undefined;
  let notes: string | undefined;
  let backgroundMediaId: string | undefined;
  let hasTransition = false;
  for (const a of (cue.actions ?? []) as Msg[]) {
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
      if (m.audio) {
        skip(ctx, 'audio cues');
        continue;
      }
      if (m.liveVideo) {
        skip(ctx, 'live video cues');
        continue;
      }
      const path = pro7UrlPath((m.element as Msg | undefined)?.url);
      if (!path) continue;
      if (backgroundMediaId) {
        skip(ctx, 'additional media actions on one slide');
        continue;
      }
      if (m.layerType === 'LAYER_TYPE_FOREGROUND') {
        note(ctx, 'info', `foreground media ${basename(path)} imported as the slide background`);
      }
      backgroundMediaId = ctx.media.resolve(path, (msg) => note(ctx, 'warn', msg));
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
    if (se.dataLinks?.length) skip(ctx, 'linked text (timers, clocks, stage data)');
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
    if (el.fill?.enable || el.stroke?.enable) skip(ctx, 'shapes');
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
};

/** Map a decoded rv.data.Presentation to an ordo presentation. */
export function mapPresentation(
  doc: Msg,
  opts: { item: string; log: ImportLogEntry[]; media: MediaResolver; fileName?: string },
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
  if (doc.chordChart) skip(ctx, 'chord charts');

  const ccli = (doc.ccli ?? {}) as Msg;
  const title =
    (typeof doc.name === 'string' && doc.name.trim()) ||
    (typeof ccli.songTitle === 'string' && ccli.songTitle.trim()) ||
    (opts.fileName ? stripExt(basename(opts.fileName)) : 'Untitled');
  const copyright = [ccli.copyrightYear ? String(ccli.copyrightYear) : '', ccli.publisher ?? '']
    .filter(Boolean)
    .join(' ')
    .trim();
  const isSong = !!ccli.songNumber || (sections.length > 0 && knownLabels >= Math.ceil(sections.length / 2));
  const meta: Presentation['meta'] = { tags: [] };
  const author = (ccli.author as string) || (ccli.artistCredits as string);
  if (author) meta.author = author;
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
    id: newId(),
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
  };
}

function looksLikePresentation(doc: Msg): boolean {
  return Array.isArray(doc.cues) || Array.isArray(doc.cueGroups) || typeof doc.name === 'string';
}

function isPlaylistCandidate(path: string): boolean {
  const lower = path.toLowerCase();
  const base = basename(lower);
  if (lower.endsWith('.pro') || MEDIA_EXT.test(lower)) return false;
  if (base === 'data' || lower.endsWith('.proplaylist')) return true;
  // Library playlist documents live in ProPresenter/Playlists/<name> without an extension.
  return /(^|\/)playlists\/[^/]+$/.test(lower) && !base.includes('.');
}

type PresRef = { result: Pro7PresentationResult; path: string };

/**
 * Import a ProPresenter 7 library or export from its files: `.pro` documents, playlist documents (library
 * `Playlists/*` files or the `data` file inside a `.proPlaylist` bundle) and the media they reference.
 */
export function importPro7(files: Map<string, Uint8Array>): Pro7ImportResult {
  const log: ImportLogEntry[] = [{ level: 'info', message: `ProPresenter 7 proto ${PRO7_PROTO_VERSION}` }];
  const media = new MediaResolver(files);
  const presentations: Presentation[] = [];
  const refs: PresRef[] = [];
  const paths = [...files.keys()].sort();

  for (const path of paths) {
    if (!/\.pro$/i.test(path)) continue;
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
      const sameUuid = docUuid ? refs.filter((r) => r.result.pro7Uuid === docUuid) : [];
      const cueCount = Array.isArray(doc.cues) ? doc.cues.length : 0;
      const name = typeof doc.name === 'string' ? doc.name.trim() : '';
      const dup = sameUuid.find((r) => r.result.name === name && r.result.cueCount === cueCount);
      if (dup) {
        log.push({ level: 'info', item, message: `same document as ${basename(dup.path)}; imported once` });
        refs.push({ result: dup.result, path });
        continue;
      }
      if (sameUuid.length > 0) {
        const other = sameUuid.find((r) => r.result.name === name) ?? sameUuid[0]!;
        log.push({
          level: 'warn',
          item,
          message:
            `same ProPresenter UUID as ${basename(other.path)} but a different ` +
            `${other.result.name !== name ? 'name' : 'slide count'}; imported both`,
        });
      }
      const result = mapPresentation(doc, { item, log, media, fileName: path });
      presentations.push(result.presentation);
      refs.push({ result, path });
    } catch (e) {
      log.push({ level: 'error', item, message: `could not decode: ${(e as Error).message}` });
    }
  }

  const playlists: Playlist[] = [];
  for (const path of paths) {
    if (!isPlaylistCandidate(path)) continue;
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
    collectPlaylists(doc.rootNode as Msg, [], { item, log, media, refs, out: playlists });
    log.push({ level: 'info', item, message: `imported ${playlists.length - before} playlist(s)` });
  }

  const usedMedia = new Map<string, string>(media.found);
  return {
    presentations,
    playlists,
    media: [...usedMedia].map(([key, path]) => ({ key, path })),
    log,
    protoVersion: PRO7_PROTO_VERSION,
  };
}

interface PlCtx {
  item: string;
  log: ImportLogEntry[];
  media: MediaResolver;
  refs: PresRef[];
  out: Playlist[];
}

function findPresentation(item: Msg, refs: PresRef[]): PresRef | undefined {
  const pres = item.presentation as Msg | undefined;
  const docPath = pro7UrlPath(pres?.documentPath);
  if (docPath) {
    const lower = docPath.toLowerCase();
    const byPath = refs.find((r) => {
      const rp = r.path.toLowerCase();
      return (
        lower === rp ||
        lower.endsWith('/' + rp) ||
        rp.endsWith('/' + basename(lower)) ||
        rp === basename(lower)
      );
    });
    if (byPath) return byPath;
  }
  const name = (typeof item.name === 'string' ? item.name : '').trim().toLowerCase();
  if (name) return refs.find((r) => r.result.presentation.title.trim().toLowerCase() === name);
  return undefined;
}

function collectPlaylists(node: Msg, trail: string[], ctx: PlCtx, depth = 0): void {
  const name = (typeof node.name === 'string' && node.name) || 'Playlist';
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
  const plName = [...trail, name].join(' / ');
  const out: PlaylistItem[] = [];
  const skipped = new Map<string, number>();
  const bump = (k: string) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  for (const it of items) {
    if (it.presentation) {
      const ref = findPresentation(it, ctx.refs);
      if (!ref) {
        ctx.log.push({
          level: 'warn',
          item: ctx.item,
          message: `playlist "${plName}": presentation "${it.name ?? '?'}" was not in the import`,
        });
        continue;
      }
      const arrUuid = uuidOf((it.presentation as Msg).arrangement);
      const arrangementId = arrUuid ? ref.result.arrangementIds.get(arrUuid) : undefined;
      const pi: PlaylistItem = {
        id: newId(),
        kind: 'presentation',
        presentationId: ref.result.presentation.id,
      };
      if (arrangementId) pi.arrangementId = arrangementId;
      out.push(pi);
      continue;
    }
    if (it.cue) {
      const cue = it.cue as Msg;
      let added = false;
      for (const a of (cue.actions ?? []) as Msg[]) {
        const m = a.media as Msg | undefined;
        if (!m || m.liveVideo) continue;
        const path = pro7UrlPath((m.element as Msg | undefined)?.url);
        if (!path) continue;
        const key = ctx.media.resolve(path, (msg) =>
          ctx.log.push({ level: 'warn', item: ctx.item, message: `playlist "${plName}": ${msg}` }),
        );
        if (!key) break;
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
      if (!added) bump('cues without media');
      continue;
    }
    if (it.header) bump('headers');
    else if (it.planningCenter) bump('Planning Center items');
    else if (it.placeholder) bump('placeholders');
    else bump('unknown items');
  }
  for (const [what, n] of skipped) {
    ctx.log.push({ level: 'info', item: ctx.item, message: `playlist "${plName}": skipped ${what} (${n})` });
  }
  ctx.out.push({ id: newId(), rev: 1, name: plName, items: out });
}

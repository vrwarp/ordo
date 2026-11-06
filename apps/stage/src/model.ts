/**
 * Pure stage-display logic (design/16): layout from the Stage look, slide text, timers, message fades and
 * frame statistics. No DOM access here so it is unit-tested in Node.
 */
import {
  type Box,
  type Cue,
  formatDuration,
  type GeneralSettings,
  importedText,
  LOOK_STAGE,
  type LiveState,
  type Look,
  nextTimeOfDay,
  type PropBox,
  type Rgba,
  type Slide,
  type SlideContent,
  type StageMessage,
  type TextStyle,
  type Timer,
} from '@ordo/domain';

export type Region = { box: Box; style: TextStyle };

export type StageLayout = {
  current: Region | null;
  next: Region | null;
  clock: PropBox | null;
  countdown: PropBox | null;
  elapsed: PropBox | null;
  /** Remaining time of the live video (prd/04: the stage shows nothing of the media layer but this). */
  mediaRemaining: PropBox | null;
  messages: PropBox | null;
  /** Section label shown as a kicker above the current lyrics. */
  section: TextStyle | null;
  clearColor: Rgba;
  nonSong: 'text' | 'none';
};

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

function base(style: Partial<TextStyle>): TextStyle {
  return {
    fontFamily: 'Inter',
    fontWeight: 700,
    fontStyle: 'normal',
    fontSizePx: 56,
    color: WHITE,
    align: 'left',
    valign: 'middle',
    lineHeight: 1.15,
    letterSpacing: 0,
    padding: 0,
    transform: 'none',
    ...style,
  };
}

/** Defaults for prop boxes the look does not style. The top band (y < 140) holds clock and timers. */
export type PropKey = 'clock' | 'countdown' | 'elapsed' | 'mediaRemaining' | 'messages';

export function defaultPropBoxes(fontFamily: string): Record<PropKey, PropBox> {
  return {
    clock: {
      ...base({ fontFamily, fontSizePx: 84, fontWeight: 700 }),
      box: { x: 60, y: 16, w: 700, h: 110, rotation: 0 },
    },
    countdown: {
      ...base({ fontFamily, fontSizePx: 64, align: 'right', color: { r: 255, g: 214, b: 10, a: 1 } }),
      box: { x: 1060, y: 16, w: 800, h: 110, rotation: 0 },
    },
    elapsed: {
      ...base({ fontFamily, fontSizePx: 64, align: 'right', color: { r: 120, g: 220, b: 255, a: 1 } }),
      box: { x: 1060, y: 16, w: 800, h: 110, rotation: 0 },
    },
    mediaRemaining: {
      ...base({ fontFamily, fontSizePx: 56, align: 'center', color: { r: 255, g: 140, b: 120, a: 1 } }),
      box: { x: 770, y: 16, w: 280, h: 110, rotation: 0 },
    },
    messages: {
      ...base({
        fontFamily,
        fontSizePx: 64,
        align: 'center',
        color: { r: 0, g: 0, b: 0, a: 1 },
        padding: 18,
        fill: { color: { r: 255, g: 214, b: 10, a: 1 }, radius: 14 },
      }),
      box: { x: 60, y: 820, w: 1800, h: 240, rotation: 0 },
    },
  };
}

/** Compute the stage layout from a look; props without a style box use the defaults above. */
export function stageLayout(look: Look | undefined): StageLayout {
  const l = look ?? LOOK_STAGE;
  const rule = l.layers.slide;
  const props = l.layers.props;
  let current: Region | null = null;
  let next: Region | null = null;
  let nonSong: 'text' | 'none' = 'text';
  if (rule.mode === 'lyricOnly') {
    current = { box: rule.band, style: rule.style };
    next = rule.nextSlide ? { box: rule.nextSlide.band, style: rule.nextSlide.style } : null;
    nonSong = rule.nonSong ?? 'text';
  } else if (rule.mode === 'authored') {
    // A non-stage look on the stage screen: still show lyrics in a sensible band.
    const s = LOOK_STAGE.layers.slide;
    if (s.mode === 'lyricOnly') {
      current = { box: s.band, style: s.style };
      next = s.nextSlide ? { box: s.nextSlide.band, style: s.nextSlide.style } : null;
    }
  }
  const family = current?.style.fontFamily ?? 'Inter';
  const d = defaultPropBoxes(family);
  const pick = (k: PropKey, on: boolean) => (on ? (props.style[k] ?? d[k]) : null);
  let countdown = pick('countdown', props.countdown);
  let elapsed = pick('elapsed', props.elapsed);
  // Both timers top right on default boxes: stack them in two half-height rows.
  if (countdown && elapsed && !props.style.countdown && !props.style.elapsed) {
    elapsed = { ...elapsed, fontSizePx: 44, box: { ...elapsed.box, y: 72, h: 60 } };
    countdown = { ...countdown, fontSizePx: 44, box: { ...countdown.box, y: 10, h: 60 } };
  }
  const section = current
    ? {
        ...current.style,
        fontSizePx: Math.round(current.style.fontSizePx * 0.5),
        fontWeight: 600,
        color: { r: 255, g: 214, b: 10, a: 1 },
        outline: undefined,
        shadow: undefined,
        fill: undefined,
      }
    : null;
  return {
    current,
    next,
    clock: pick('clock', props.clock),
    countdown,
    elapsed,
    // Looks saved before the flag existed follow `elapsed`.
    mediaRemaining: pick('mediaRemaining', props.mediaRemaining ?? props.elapsed),
    messages: pick('messages', props.messages),
    section: props.style.section ?? section,
    clearColor: l.clearColor,
    nonSong,
  };
}

/** The look a stage window uses: its output's look from config, then the live playlist's looks, then default. */
export function resolveStageLook(lookId: string | undefined, ...sources: (Look[] | undefined)[]): Look {
  if (lookId) {
    for (const list of sources) {
      const hit = list?.find((x) => x.id === lookId);
      if (hit) return hit;
    }
  }
  for (const list of sources) {
    const stage = list?.find((x) => x.kind === 'stage');
    if (stage) return stage;
  }
  return LOOK_STAGE;
}

/** The lyric text of a slide: its lyric object, else its first text box. */
export function slideText(slide: Slide | undefined): string {
  if (!slide) return '';
  const lyric = slide.lyricObjectId ? slide.objects.find((o) => o.id === slide.lyricObjectId) : undefined;
  if (lyric?.type === 'text' && lyric.text.trim()) return lyric.text;
  for (const o of slide.objects) if (o.type === 'text' && o.text.trim()) return o.text;
  if (slide.scripture) return slide.scripture.text;
  // A picture slide: the picture's own text, once it is known to be this slide's (design/27 §11).
  return importedText(slide);
}

function findSlide(
  s: LiveState,
  presentationId: string | undefined,
  slideId: string | undefined,
): Slide | undefined {
  if (!presentationId || !slideId) return undefined;
  const p = s.resolved?.presentations[presentationId];
  if (!p) return undefined;
  for (const sec of p.sections) for (const sl of sec.slides) if (sl.id === slideId) return sl;
  return undefined;
}

export type StageText = {
  text: string;
  /** Section label (song) or presentation title (non-song). */
  label?: string;
  /** Position within the section, e.g. "2/3". */
  position?: string;
};

function sectionCount(s: LiveState, cue: Cue): number {
  let n = 0;
  for (const c of s.cues)
    if (c.itemIndex === cue.itemIndex && c.arrangementPos === cue.arrangementPos && c.kind === 'slide') n++;
  return n;
}

/** What the current lyrics region shows for the displayed slide content (null: nothing). */
export function currentText(
  s: LiveState,
  content: SlideContent | null,
  layout: StageLayout,
): StageText | null {
  if (!content) return null;
  const cue = s.cues[content.cueIndex];
  const p = s.resolved?.presentations[content.presentationId];
  const isSong = p?.kind === 'song';
  if (!isSong && layout.nonSong === 'none') return null;
  const slide = findSlide(s, content.presentationId, content.slideId);
  let text = slideText(slide);
  if (!text && !isSong) text = p?.title ?? '';
  if (!text) return null;
  const out: StageText = { text };
  if (isSong && cue?.sectionLabel) {
    out.label = cue.sectionLabel;
    const total = sectionCount(s, cue);
    if (total > 1 && cue.slideIndexInSection !== undefined)
      out.position = `${cue.slideIndexInSection + 1}/${total}`;
  } else if (!isSong && p?.title && p.title !== text) out.label = p.title;
  return out;
}

/**
 * The next slide after the displayed one: the following slide cue of the same item, else the next item's
 * first slide (labelled with its title).
 */
export function nextText(s: LiveState, content: SlideContent | null, layout: StageLayout): StageText | null {
  if (!content || !layout.next) return null;
  const cur = s.cues[content.cueIndex];
  if (!cur) return null;
  for (let i = content.cueIndex + 1; i < s.cues.length; i++) {
    const c = s.cues[i]!;
    if (c.kind !== 'slide') {
      if (c.itemIndex !== cur.itemIndex) {
        return { text: '', label: c.label ? `Next: ${c.label}` : undefined };
      }
      continue;
    }
    const p = c.presentationId ? s.resolved?.presentations[c.presentationId] : undefined;
    const isSong = p?.kind === 'song';
    let text = slideText(findSlide(s, c.presentationId, c.slideId));
    if (!text && !isSong) text = p?.title ?? '';
    if (c.itemIndex !== cur.itemIndex) return { text, label: `Next: ${p?.title ?? c.label}` };
    const out: StageText = { text };
    if (c.sectionLabel && c.arrangementPos !== cur.arrangementPos) out.label = c.sectionLabel;
    return out;
  }
  return null;
}

export type TimerDisplay = { label: string; value: string; running: boolean; overdue?: boolean };

/** Countdown to service from `props.countdownTimerId`. */
export function countdownDisplay(s: LiveState, now: number, timeZone: string): TimerDisplay | null {
  const id = s.props.countdownTimerId;
  const t = id ? s.timers[id] : undefined;
  if (!t?.running || t.spec.kind !== 'countdownTo') return null;
  const target = nextTimeOfDay(t.spec.timeOfDay, timeZone, now);
  const remaining = target - now;
  return {
    label: t.spec.label ?? 'Service in',
    value: formatDuration(Math.max(0, remaining + 999)),
    running: true,
    overdue: remaining <= 0,
  };
}

/** The elapsed timer to show: the most recently started running one, else a stopped one with time on it. */
export function elapsedDisplay(s: LiveState, now: number): TimerDisplay | null {
  let best: Timer | undefined;
  for (const t of Object.values(s.timers)) {
    if (t.spec.kind !== 'elapsed') continue;
    if (t.running && t.startedAt !== undefined) {
      if (!best?.running || (best.startedAt ?? 0) < t.startedAt) best = t;
    } else if (!best && (t.elapsedMs ?? 0) > 0) best = t;
  }
  if (!best) return null;
  const ms = best.running ? now - (best.startedAt ?? now) : (best.elapsedMs ?? 0);
  return { label: best.spec.label ?? 'Elapsed', value: formatDuration(ms), running: best.running };
}

/**
 * Remaining time of the live video on the media layer, from the reducer's transport state and the media's
 * duration. Null when nothing is playing, the layer holds an image, or the duration is unknown (a video
 * still transcoding). Looping videos count down each pass.
 */
export function mediaRemainingDisplay(s: LiveState, now: number): TimerDisplay | null {
  const m = s.layers.media.content;
  if (!m || m.mediaKind !== 'video') return null;
  const media = s.resolved?.media[m.mediaId];
  const duration = media?.durationMs;
  if (!duration || !Number.isFinite(duration) || duration <= 0) return null;
  let position = m.state === 'playing' ? now - m.startedAt : m.positionMs;
  if (!Number.isFinite(position) || position < 0) position = 0;
  if (m.loop && position >= duration) position %= duration;
  const remaining = Math.max(0, duration - position);
  return {
    label: media?.name ?? 'Video',
    // Round up so the last second reads 00:01, not 00:00 while frames still play.
    value: formatDuration(Math.ceil(remaining / 1000) * 1000),
    running: m.state === 'playing',
    overdue: m.state === 'ended' || (remaining <= 0 && !m.loop),
  };
}

/** Messages to show now, newest first, without expired ones. */
export function activeMessages(messages: StageMessage[], now: number): StageMessage[] {
  return messages.filter((m) => m.expiresAt === undefined || m.expiresAt > now);
}

/** Next time (hub ms) a message expires, for scheduling a re-render. */
export function nextExpiry(messages: StageMessage[], now: number): number | undefined {
  let t: number | undefined;
  for (const m of messages)
    if (m.expiresAt !== undefined && m.expiresAt > now && (t === undefined || m.expiresAt < t))
      t = m.expiresAt;
  return t;
}

export const MESSAGE_FADE_MS = 1000;

export type ShownMessage = { id: string; text: string; phase: 'in' | 'out'; since: number };

/**
 * Reconcile displayed messages with the active list: new ones fade in (newest first), removed ones fade
 * out for 1 s and are then dropped. Order follows the active list; leaving messages keep their slot.
 */
export function reconcileMessages(
  shown: ShownMessage[],
  active: Pick<StageMessage, 'id' | 'text'>[],
  now: number,
): ShownMessage[] {
  const activeIds = new Set(active.map((m) => m.id));
  const byId = new Map(shown.map((m) => [m.id, m]));
  const out: ShownMessage[] = [];
  for (const m of active) {
    const prev = byId.get(m.id);
    if (prev && prev.phase === 'in') out.push(prev.text === m.text ? prev : { ...prev, text: m.text });
    else out.push({ id: m.id, text: m.text, phase: 'in', since: now });
  }
  // Keep leaving messages at their previous position.
  shown.forEach((m, i) => {
    if (activeIds.has(m.id)) return;
    const leaving: ShownMessage = m.phase === 'out' ? m : { ...m, phase: 'out', since: now };
    if (now - leaving.since >= MESSAGE_FADE_MS) return;
    out.splice(Math.min(i, out.length), 0, leaving);
  });
  return out;
}

/** Delay before flipping to content scheduled at hub time `at`; 0 when due. */
export function flipDelay(at: number, now: number): number {
  return Math.max(0, at - now);
}

/**
 * Frame statistics from rAF timestamps: presented frames, missed vsyncs (a gap of n intervals counts n-1
 * misses, gaps over 1 s are ignored as the page was hidden) and fps over the last second.
 */
export class FrameStats {
  presented = 0;
  missed = 0;
  private last = 0;
  private interval = 1000 / 60;
  private window: number[] = [];

  frame(t: number): void {
    this.presented++;
    if (this.last > 0) {
      const dt = t - this.last;
      if (dt > 0 && dt < 1000) {
        // Track the display's frame interval (fast down, slow up) so 30/50/120 Hz screens work.
        this.interval =
          dt < this.interval ? this.interval * 0.8 + dt * 0.2 : this.interval * 0.995 + dt * 0.005;
        const n = Math.round(dt / this.interval);
        if (n > 1) this.missed += n - 1;
      }
    }
    this.last = t;
    this.window.push(t);
    while (this.window.length > 0 && t - this.window[0]! > 1000) this.window.shift();
  }

  get fps(): number {
    return this.window.length;
  }

  get frameMs(): number {
    return this.interval;
  }
}

export type ClockSettings = Pick<GeneralSettings, 'timeZone' | 'clock24h'>;

/** CSS for a text style at 1 logical px = 1 CSS px (the stage scales the 1920x1080 canvas). */
export function textCss(style: TextStyle): Record<string, string | number> {
  const c = style.color;
  const css: Record<string, string | number> = {
    fontFamily: `"${style.fontFamily}", Inter, system-ui, sans-serif`,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    fontSize: `${style.fontSizePx}px`,
    textTransform: style.transform === 'uppercase' ? 'uppercase' : 'none',
    color: `rgba(${c.r},${c.g},${c.b},${c.a})`,
    textAlign: style.align,
    lineHeight: style.lineHeight,
    letterSpacing: `${style.letterSpacing}px`,
    padding: `${style.padding}px`,
    justifyContent: style.valign === 'top' ? 'flex-start' : style.valign === 'bottom' ? 'flex-end' : 'center',
  };
  if (style.outline && style.outline.width > 0) {
    const o = style.outline.color;
    css.WebkitTextStroke = `${style.outline.width * 2}px rgba(${o.r},${o.g},${o.b},${o.a})`;
    css.paintOrder = 'stroke fill';
  }
  if (style.shadow) {
    const s = style.shadow;
    css.textShadow = `${s.dx}px ${s.dy}px ${s.blur}px rgba(${s.color.r},${s.color.g},${s.color.b},${s.color.a})`;
  }
  if (style.fill) {
    const f = style.fill.color;
    css.background = `rgba(${f.r},${f.g},${f.b},${f.a})`;
    css.borderRadius = `${style.fill.radius}px`;
  }
  return css;
}

export function boxCss(b: Box): Record<string, string> {
  return {
    left: `${b.x}px`,
    top: `${b.y}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
    ...(b.rotation ? { transform: `rotate(${b.rotation}deg)` } : {}),
  };
}

/** Font families the stage needs (its look's styles). */
export function stageFontFamilies(layout: StageLayout): Set<string> {
  const fams = new Set<string>();
  for (const r of [layout.current, layout.next]) if (r) fams.add(r.style.fontFamily);
  for (const p of [layout.clock, layout.countdown, layout.elapsed, layout.mediaRemaining, layout.messages])
    if (p) fams.add(p.fontFamily);
  if (layout.section) fams.add(layout.section.fontFamily);
  return fams;
}

import {
  type Box,
  type CountdownCorner,
  type CountdownPreset,
  DEFAULT_LYRIC_STYLE,
  type LiveState,
  type Look,
  MANUAL_ELAPSED_TIMER_ID,
  type PropBox,
  type Rgba,
  type TextStyle,
  type Timer,
  WHITE,
  formatClock,
  formatDuration,
  nextTimeOfDay,
} from '@ordo/domain';

/**
 * The props layer (logo, countdown, clock, elapsed timer, top stage message) as data. The output
 * computes this once per second and re-rasterizes only when `key` changes.
 */

export type PropTextItem = { id: PropId; text: string; style: TextStyle; box: Box };
export type PropId = 'countdown' | 'countdownLabel' | 'clock' | 'elapsed' | 'message' | 'videoRemaining';
export type CountdownRing = {
  box: Box;
  /** Remaining fraction in [0, 1]. */
  progress: number;
  fillColor: Rgba;
  trackColor: Rgba;
  strokeColor: Rgba;
};
export type PropsModel = {
  key: string;
  items: PropTextItem[];
  ring?: CountdownRing;
  logo?: { mediaId: string; box: Box };
  /** True when the logo toggled on or off (the change uses the look's transition, others cut). */
  empty: boolean;
};

export type PropsContext = {
  now: number;
  timeZone: string;
  clock24h: boolean;
  logoMediaId?: string;
  /** Look signature (see lookSignature) so style edits re-rasterize. */
  lookSig?: string;
};

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h, rotation: 0 });

const base: TextStyle = {
  ...DEFAULT_LYRIC_STYLE,
  outline: { width: 3, color: { r: 0, g: 0, b: 0, a: 0.85 } },
  shadow: undefined,
  padding: 12,
};

export function effectiveCountdownPreset(look: Look): CountdownPreset {
  return look.layers.props.countdownPreset ?? 'cornerCircle';
}

export function effectiveCountdownCorner(look: Look): CountdownCorner {
  return look.layers.props.countdownCorner ?? (look.kind === 'stream' ? 'topRight' : 'bottomRight');
}

const CORNER_MARGIN = 48;
const CIRCLE_SIZE = 200;
const PILL_W = 420;
const PILL_COMPACT_W = 200;
const PILL_H = 72;

function cornerOrigin(corner: CountdownCorner, w: number, h: number): { x: number; y: number } {
  const right = corner === 'topRight' || corner === 'bottomRight';
  const bottom = corner === 'bottomLeft' || corner === 'bottomRight';
  return {
    x: right ? 1920 - CORNER_MARGIN - w : CORNER_MARGIN,
    y: bottom ? 1080 - CORNER_MARGIN - h : CORNER_MARGIN,
  };
}

/** Default prop placement in logical 1920x1080 space. Stage-like looks keep the top and bottom strips. */
export function defaultPropBox(id: PropId | 'logo', look: Look): PropBox {
  const stage = look.kind === 'stage';
  switch (id) {
    case 'clock':
      return { ...base, fontSizePx: 64, align: 'right', valign: 'middle', box: box(1400, 16, 500, 110) };
    case 'elapsed':
      return { ...base, fontSizePx: 64, align: 'left', valign: 'middle', box: box(20, 16, 500, 110) };
    case 'countdown': {
      if (stage)
        return { ...base, fontSizePx: 64, align: 'center', valign: 'middle', box: box(660, 16, 600, 110) };
      const preset = effectiveCountdownPreset(look);
      if (preset === 'centerHero') {
        return { ...base, fontSizePx: 180, align: 'center', valign: 'middle', box: box(410, 330, 1100, 260) };
      }
      const corner = effectiveCountdownCorner(look);
      if (preset === 'cornerPill') {
        const { x, y } = cornerOrigin(corner, PILL_W, PILL_H);
        return {
          ...base,
          fontSizePx: 36,
          outline: undefined,
          fill: { color: { r: 15, g: 23, b: 42, a: 0.78 }, radius: 36 },
          padding: 20,
          align: 'right',
          valign: 'middle',
          box: box(x, y, PILL_W, PILL_H),
        };
      }
      const { x, y } = cornerOrigin(corner, CIRCLE_SIZE, CIRCLE_SIZE);
      return {
        ...base,
        fontSizePx: 50,
        outline: undefined,
        padding: 8,
        align: 'center',
        valign: 'middle',
        box: box(x + 18, y + 48, CIRCLE_SIZE - 36, 84),
      };
    }
    case 'countdownLabel': {
      if (stage) {
        return {
          ...base,
          fontSizePx: 30,
          fontWeight: 400,
          align: 'center',
          valign: 'top',
          box: box(660, 116, 600, 50),
        };
      }
      const preset = effectiveCountdownPreset(look);
      if (preset === 'centerHero') {
        return {
          ...base,
          fontSizePx: 56,
          fontWeight: 400,
          align: 'center',
          valign: 'top',
          box: box(260, 600, 1400, 120),
        };
      }
      const corner = effectiveCountdownCorner(look);
      if (preset === 'cornerPill') {
        const { x, y } = cornerOrigin(corner, PILL_W, PILL_H);
        return {
          ...base,
          fontSizePx: 22,
          fontWeight: 500,
          color: { r: 226, g: 232, b: 240, a: 0.95 },
          outline: undefined,
          padding: 20,
          align: 'left',
          valign: 'middle',
          box: box(x, y, 250, PILL_H),
        };
      }
      const { x, y } = cornerOrigin(corner, CIRCLE_SIZE, CIRCLE_SIZE);
      return {
        ...base,
        fontSizePx: 18,
        fontWeight: 600,
        color: { r: 210, g: 220, b: 235, a: 0.92 },
        outline: undefined,
        padding: 4,
        align: 'center',
        valign: 'top',
        box: box(x + 22, y + 128, CIRCLE_SIZE - 44, 34),
      };
    }
    case 'message':
      return {
        ...base,
        fontSizePx: 56,
        color: WHITE,
        outline: undefined,
        fill: { color: { r: 200, g: 30, b: 30, a: 0.9 }, radius: 12 },
        padding: 18,
        align: 'center',
        valign: 'middle',
        box: box(60, 960, 1800, 110),
      };
    case 'videoRemaining':
      return { ...base, fontSizePx: 64, align: 'right', valign: 'middle', box: box(1400, 954, 500, 110) };
    case 'logo':
      return { ...base, fontSizePx: 10, box: box(360, 190, 1200, 700) };
  }
}

export function propBox(id: PropId | 'logo', look: Look): PropBox {
  return look.layers.props.style[id] ?? defaultPropBox(id, look);
}

function split(p: PropBox): { style: TextStyle; box: Box } {
  const { box: b, ...style } = p;
  return { style, box: b };
}

/** The elapsed timer an output shows: the running elapsed timer started last, else a stopped one with time. */
export function elapsedTimer(state: LiveState): Timer | undefined {
  let best: Timer | undefined;
  for (const t of Object.values(state.timers)) {
    if (t.spec.kind !== 'elapsed') continue;
    if (t.running) {
      if (!best?.running || (t.startedAt ?? 0) > (best.startedAt ?? 0)) best = t;
    } else if (!best && (t.elapsedMs ?? 0) > 0) best = t;
  }
  return best ?? state.timers[MANUAL_ELAPSED_TIMER_ID];
}

export function elapsedMsOf(t: Timer, now: number): number {
  if (t.running && t.startedAt !== undefined) return Math.max(0, now - t.startedAt);
  return t.elapsedMs ?? 0;
}

/** Text of the countdown timer, or null when no countdown is running. */
export function countdownText(
  state: LiveState,
  ctx: PropsContext,
  look?: Look,
): { text: string; label?: string; remainingMs: number; progress: number } | null {
  const id = state.props.countdownTimerId;
  const t = id ? state.timers[id] : undefined;
  if (!t?.running || t.spec.kind !== 'countdownTo') return null;
  const target = nextTimeOfDay(t.spec.timeOfDay, ctx.timeZone, t.startedAt ?? ctx.now);
  const diff = target - ctx.now;
  // Audience displays auto-hide countdown after holding 00:00 for 3.5 seconds
  if (look && look.kind !== 'stage' && diff < -3500) return null;
  const remainingMs = Math.max(0, diff);
  // Round up so the display reaches 00:00 exactly at the target second.
  const roundedMs = Math.ceil(remainingMs / 1000) * 1000;
  const totalMs = t.startedAt !== undefined ? Math.max(1000, target - t.startedAt) : 0;
  const progress = totalMs > 0 ? Math.max(0, Math.min(1, roundedMs / totalMs)) : 0;
  return { text: formatDuration(roundedMs), label: t.spec.label, remainingMs, progress };
}

/** The newest stage message that has not expired. */
export function topMessage(state: LiveState, now: number): string | undefined {
  for (const m of state.messages) if (m.expiresAt === undefined || m.expiresAt > now) return m.text;
  return undefined;
}

/**
 * Remaining time of the live media video, `mm:ss` rounded up (prd/04: the stage look shows it instead of
 * the video). Nothing for images, loops, ended videos or media without a known duration.
 */
export function videoRemainingText(state: LiveState, now: number): string | undefined {
  const c = state.layers.media.content;
  if (!c || c.mediaKind !== 'video' || c.loop || c.state === 'ended') return undefined;
  const dur = state.resolved?.media[c.mediaId]?.durationMs;
  if (!dur) return undefined;
  const pos = c.state === 'playing' ? Math.max(0, now - c.startedAt) : c.positionMs;
  return formatDuration(Math.ceil(Math.max(0, dur - pos) / 1000) * 1000);
}

/** Whether a look shows the video remaining time: stage looks do (prd/04). */
export function showsVideoRemaining(look: Look): boolean {
  return look.kind === 'stage';
}

export function propsModel(state: LiveState, look: Look, ctx: PropsContext): PropsModel {
  const rule = look.layers.props;
  const items: PropTextItem[] = [];
  let ring: CountdownRing | undefined;
  let logo: PropsModel['logo'];
  if (state.mode === 'live' && !state.black) {
    if (rule.logo && state.props.logo && ctx.logoMediaId)
      logo = { mediaId: ctx.logoMediaId, box: propBox('logo', look).box };
    if (rule.countdown) {
      const cd = countdownText(state, ctx, look);
      if (cd) {
        const customCountdown = Boolean(rule.style.countdown);
        const preset = effectiveCountdownPreset(look);
        const corner = effectiveCountdownCorner(look);
        let cdBox = propBox('countdown', look);
        if (look.kind !== 'stage' && !customCountdown) {
          if (preset === 'cornerCircle') {
            const { x, y } = cornerOrigin(corner, CIRCLE_SIZE, CIRCLE_SIZE);
            ring = {
              box: box(x, y, CIRCLE_SIZE, CIRCLE_SIZE),
              progress: cd.progress,
              fillColor: { r: 15, g: 23, b: 42, a: 0.78 },
              trackColor: { r: 255, g: 255, b: 255, a: 0.18 },
              strokeColor: { r: 255, g: 255, b: 255, a: 0.95 },
            };
            if (!cd.label) {
              cdBox = { ...cdBox, box: box(x + 18, y + 56, CIRCLE_SIZE - 36, 88) };
            }
          } else if (preset === 'cornerPill' && !cd.label) {
            const { x, y } = cornerOrigin(corner, PILL_COMPACT_W, PILL_H);
            cdBox = { ...cdBox, align: 'center', box: box(x, y, PILL_COMPACT_W, PILL_H) };
          }
        }
        items.push({ id: 'countdown', text: cd.text, ...split(cdBox) });
        if (cd.label)
          items.push({ id: 'countdownLabel', text: cd.label, ...split(propBox('countdownLabel', look)) });
      }
    }
    if (rule.elapsed) {
      const t = elapsedTimer(state);
      if (t && (t.running || (t.elapsedMs ?? 0) > 0))
        items.push({
          id: 'elapsed',
          text: formatDuration(elapsedMsOf(t, ctx.now)),
          ...split(propBox('elapsed', look)),
        });
    }
    if (rule.messages) {
      const m = topMessage(state, ctx.now);
      if (m) items.push({ id: 'message', text: m, ...split(propBox('message', look)) });
    }
    if (showsVideoRemaining(look)) {
      const v = videoRemainingText(state, ctx.now);
      if (v) items.push({ id: 'videoRemaining', text: v, ...split(propBox('videoRemaining', look)) });
    }
  }
  if (rule.clock && state.mode === 'live' && !state.black)
    items.push({
      id: 'clock',
      text: formatClock(ctx.now, ctx.timeZone, ctx.clock24h),
      ...split(propBox('clock', look)),
    });
  const empty = !logo && !ring && items.length === 0;
  const key = empty
    ? ''
    : `pr|${ctx.lookSig ?? look.id}|${logo ? `L:${logo.mediaId}` : ''}|${ring ? `R:${Math.round(ring.progress * 360)}` : ''}|${items.map((i) => `${i.id}=${i.text}`).join('|')}`;
  return { key, items, ring, logo, empty };
}

import {
  type Box,
  DEFAULT_LYRIC_STYLE,
  type LiveState,
  type Look,
  MANUAL_ELAPSED_TIMER_ID,
  type PropBox,
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
export type PropId = 'countdown' | 'countdownLabel' | 'clock' | 'elapsed' | 'message';
export type PropsModel = {
  key: string;
  items: PropTextItem[];
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

/** Default prop placement in logical 1920x1080 space. Stage-like looks keep the top and bottom strips. */
export function defaultPropBox(id: PropId | 'logo', look: Look): PropBox {
  const stage = look.kind === 'stage';
  switch (id) {
    case 'clock':
      return { ...base, fontSizePx: 64, align: 'right', valign: 'middle', box: box(1400, 16, 500, 110) };
    case 'elapsed':
      return { ...base, fontSizePx: 64, align: 'left', valign: 'middle', box: box(20, 16, 500, 110) };
    case 'countdown':
      return stage
        ? { ...base, fontSizePx: 64, align: 'center', valign: 'middle', box: box(660, 16, 600, 110) }
        : { ...base, fontSizePx: 180, align: 'center', valign: 'middle', box: box(410, 330, 1100, 260) };
    case 'countdownLabel':
      return stage
        ? { ...base, fontSizePx: 30, fontWeight: 400, align: 'center', valign: 'top', box: box(660, 116, 600, 50) }
        : { ...base, fontSizePx: 56, fontWeight: 400, align: 'center', valign: 'top', box: box(260, 600, 1400, 120) };
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
      if (!best || !best.running || (t.startedAt ?? 0) > (best.startedAt ?? 0)) best = t;
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
): { text: string; label?: string; remainingMs: number } | null {
  const id = state.props.countdownTimerId;
  const t = id ? state.timers[id] : undefined;
  if (!t || !t.running || t.spec.kind !== 'countdownTo') return null;
  const target = nextTimeOfDay(t.spec.timeOfDay, ctx.timeZone, t.startedAt ?? ctx.now);
  const remainingMs = Math.max(0, target - ctx.now);
  // Round up so the display reaches 00:00 exactly at the target second.
  return { text: formatDuration(Math.ceil(remainingMs / 1000) * 1000), label: t.spec.label, remainingMs };
}

/** The newest stage message that has not expired. */
export function topMessage(state: LiveState, now: number): string | undefined {
  for (const m of state.messages) if (m.expiresAt === undefined || m.expiresAt > now) return m.text;
  return undefined;
}

export function propsModel(state: LiveState, look: Look, ctx: PropsContext): PropsModel {
  const rule = look.layers.props;
  const items: PropTextItem[] = [];
  let logo: PropsModel['logo'];
  if (state.mode === 'live' && !state.black) {
    if (rule.logo && state.props.logo && ctx.logoMediaId)
      logo = { mediaId: ctx.logoMediaId, box: propBox('logo', look).box };
    if (rule.countdown) {
      const cd = countdownText(state, ctx);
      if (cd) {
        items.push({ id: 'countdown', text: cd.text, ...split(propBox('countdown', look)) });
        if (cd.label) items.push({ id: 'countdownLabel', text: cd.label, ...split(propBox('countdownLabel', look)) });
      }
    }
    if (rule.elapsed) {
      const t = elapsedTimer(state);
      if (t && (t.running || (t.elapsedMs ?? 0) > 0))
        items.push({ id: 'elapsed', text: formatDuration(elapsedMsOf(t, ctx.now)), ...split(propBox('elapsed', look)) });
    }
    if (rule.messages) {
      const m = topMessage(state, ctx.now);
      if (m) items.push({ id: 'message', text: m, ...split(propBox('message', look)) });
    }
  }
  if (rule.clock && state.mode === 'live' && !state.black)
    items.push({
      id: 'clock',
      text: formatClock(ctx.now, ctx.timeZone, ctx.clock24h),
      ...split(propBox('clock', look)),
    });
  const empty = !logo && items.length === 0;
  const key = empty
    ? ''
    : `pr|${ctx.lookSig ?? look.id}|${logo ? `L:${logo.mediaId}` : ''}|${items.map((i) => `${i.id}=${i.text}`).join('|')}`;
  return { key, items, logo, empty };
}

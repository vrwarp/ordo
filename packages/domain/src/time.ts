/**
 * Wall-clock helpers for the venue time zone. All maths goes through Intl so DST transitions are handled by
 * the zone database, never by adding minutes to a UTC timestamp.
 */

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      f = formatter('UTC');
    }
    fmtCache.set(timeZone, f);
  }
  return f;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const p = formatter(timeZone).formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
    ms: ((ms % 1000) + 1000) % 1000,
  };
}

/**
 * The instant at which the civil time (y, m, d, hh, mm) occurs in `timeZone`. Converges in two rounds of
 * correction, which covers DST offsets. For a civil time that does not exist (spring-forward gap) the result
 * is the instant after the gap; for an ambiguous one (fall-back overlap) the earlier instant.
 */
export function zonedToMs(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss = 0,
): number {
  let guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    const have = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(y, m - 1, d, hh, mm, ss);
    const diff = want - have;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/**
 * Hub ms of the occurrence of HH:MM in `timeZone` nearest after `nowMs`.
 * Default: if that time today passed less than an hour ago it is still "today" (so a countdown that just hit
 * zero reads 00:00, not 23:59:59). With `strictlyAfter`, the result is always later than `nowMs` by at least
 * `minLeadMs` (schedulers use this so a job never re-fires in the same slot).
 */
export function nextTimeOfDay(
  timeOfDay: string,
  timeZone: string,
  nowMs: number,
  opts: { strictlyAfter?: boolean; minLeadMs?: number } = {},
): number {
  const [hh, mm] = timeOfDay.split(':').map(Number) as [number, number];
  const p = zonedParts(nowMs, timeZone);
  let at = zonedToMs(timeZone, p.year, p.month, p.day, hh, mm);
  const lead = opts.strictlyAfter ? (opts.minLeadMs ?? 60_000) : -60 * 60_000;
  if (at - nowMs < lead) {
    // Tomorrow's civil date, computed via the zone so month and DST boundaries are respected.
    const t = zonedParts(at + 36 * 3600_000, timeZone);
    at = zonedToMs(timeZone, t.year, t.month, t.day, hh, mm);
  }
  return at;
}

/** mm:ss or h:mm:ss, clamped at zero. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatClock(ms: number, timeZone: string, h24: boolean): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: !h24 }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/**
 * Hub ms of the next occurrence of HH:MM in `timeZone`, at or after `nowMs`.
 * If that time today has passed by more than 1 hour, it is tomorrow; within the hour it stays today
 * (so a countdown that just reached zero shows 00:00, not 23:59:59).
 */
export function nextTimeOfDay(timeOfDay: string, timeZone: string, nowMs: number): number {
  const [hh, mm] = timeOfDay.split(':').map(Number) as [number, number];
  const parts = zonedParts(nowMs, timeZone);
  const nowInZoneMin = parts.hour * 60 + parts.minute + parts.second / 60;
  const targetMin = hh * 60 + mm;
  let deltaMin = targetMin - nowInZoneMin;
  if (deltaMin < -60) deltaMin += 24 * 60;
  return Math.round(nowMs + deltaMin * 60_000 - parts.ms);
}

export function zonedParts(
  ms: number,
  timeZone: string,
): { hour: number; minute: number; second: number; ms: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  const p = fmt.formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { hour: get('hour') % 24, minute: get('minute'), second: get('second'), ms: ms % 1000 };
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
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: !h24,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/**
 * Reading an output window's link log (`__ordo.telemetry().recentLog`, the last 20 lines link-core.ts `diagLog`
 * wrote): each line is `HH:MM:SS.mmm <text>`, the time of day in UTC by the window's own clock.
 */

const DAY_MS = 86_400_000;

/**
 * When (epoch ms) and why the window left its bus for none at or after `since` (epoch ms): the first
 * `bus: none (<reason>)` line stamped at or after it. A stamp is read on the day nearest `since`, so a run
 * across midnight UTC still reads right. Undefined when there is no such line (yet).
 */
export function leftBusIn(log: readonly string[], since: number): { at: number; reason: string } | undefined {
  const day = Math.floor(since / DAY_MS) * DAY_MS;
  for (const line of log) {
    const m = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) bus: none \((.*)\)$/.exec(line);
    if (!m) continue;
    let at = day + ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
    if (at - since > DAY_MS / 2) at -= DAY_MS;
    else if (since - at > DAY_MS / 2) at += DAY_MS;
    if (at >= since) return { at, reason: m[5]! };
  }
  return undefined;
}

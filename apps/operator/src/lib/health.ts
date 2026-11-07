import type { LiveState } from '@ordo/domain';
import type { OutputHealthEntry } from '@ordo/protocol';

export type Dot = 'green' | 'amber' | 'red' | 'grey';

/** Overall health dot for an output in the top bar. */
export function outputDot(h: OutputHealthEntry | undefined, now = Date.now()): Dot {
  if (!h?.connected) return 'red';
  if (now - h.lastSeen > 5000) return 'red';
  if (h.error || h.audio === 'lost' || h.armedOk === false) return 'red';
  if (h.cache.total > 0 && h.cache.ready < h.cache.total) return 'amber';
  if (h.bus === 'fallback') return 'amber';
  if (outputIssues(h).some((i) => i.level === 'warn')) return 'amber';
  return 'green';
}

export type HealthIssueId = 'fontMissing' | 'fontCoverage' | 'raster' | 'upload';

/**
 * Something on an output that does not stop the service but should be looked at (design/27 §13, M7): a
 * `label` in plain words for the volunteer at the desk (what the audience may notice and whom to tell), and
 * a `detail` with the figures for the tech. `level` 'warn' (a performance alarm: the output's dot turns
 * amber and the top bar says it) or 'note' (fonts: nothing to do during a service, so only the
 * diagnostics view and the dot's tooltip list it, for the tech to fix before the next one).
 */
export type HealthIssue = { id: HealthIssueId; level: 'warn' | 'note'; label: string; detail: string };

const list = (xs: readonly string[], max = 6) =>
  xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', ');

/** The issues an output reports: missing fonts, characters no font has, and budget alarms. */
export function outputIssues(h: OutputHealthEntry | undefined): HealthIssue[] {
  if (!h?.connected) return [];
  const out: HealthIssue[] = [];
  if (h.fontFallbacks?.length)
    out.push({
      id: 'fontMissing',
      level: 'note',
      label: 'A font is missing on this screen, so some text looks different. Tell the tech team.',
      detail: `Not loaded here: ${list(h.fontFallbacks)}. Text in these fonts is drawn in a fallback font. Upload the font (Library, Fonts) or check that the screen's cache is complete.`,
    });
  const fc = h.fontCoverage;
  if (fc?.count)
    out.push({
      id: 'fontCoverage',
      level: 'note',
      label: 'Some letters or symbols are not in any font, so they may look different or show as boxes.',
      detail: `${fc.count} character${fc.count === 1 ? '' : 's'} no font of this output has: ${[...fc.chars].join(' ')}${fc.count > [...fc.chars].length ? ' …' : ''} (scripts ${fc.scripts.join(', ')}). This computer's own fonts draw them. Upload a font that has them.`,
    });
  const alarms = new Set(h.alarms ?? []);
  const b = h.budgets;
  if (alarms.has('raster'))
    out.push({
      id: 'raster',
      level: 'warn',
      label: 'This computer is slow to prepare slides, so a slide may appear a moment late.',
      detail: `Slide drawing p50 ${alarmed(h)?.p50 ?? '?'} ms, p95 ${alarmed(h)?.p95 ?? '?'} ms over the last ${alarmed(h)?.n ?? '?'} slides${h.rasterHeavy ? ` whose content fits the budget (${h.rasterHeavy} more are past it by their content, such as large traced decorations, and not counted: p95 ${h.rasterMs?.p95 ?? '?'} ms with them)` : ''}; budget p95 ${b?.rasterP95Ms ?? '?'} ms (design/27 §13). Check the computer's power plan and other running programs.`,
    });
  if (alarms.has('upload'))
    out.push({
      id: 'upload',
      level: 'warn',
      label: 'This computer is slow to send new slides to the screen, so motion may stutter at a change.',
      detail: `Texture upload in strips up to ${h.uploadMs ?? '?'} ms of the render worker's time in one frame over the last minute; budget ${b?.uploadMs ?? '?'} ms (design/27 §13).${wholeText(h)} Check the computer's power plan and other running programs; bench:venue measures the GPU itself.`,
    });
  return out;
}

/** The raster figures the alarm read: the slides whose content fits the budget when some do not, else all. */
function alarmed(h: OutputHealthEntry): OutputHealthEntry['rasterMs'] {
  return h.rasterAlarmMs ?? h.rasterMs;
}

/** Whole uploads made by design (a refresh, recovery after a GPU reset), for an upload detail. */
function wholeText(h: OutputHealthEntry): string {
  const w = h.wholeUploads;
  return w?.count
    ? ` Apart from these, ${w.count} frame(s) uploaded what was on screen whole (a slide drawn again, recovery after a GPU reset), up to ${w.maxMs} ms in the last minute: by design, not counted.`
    : '';
}

/** "p50 / p95 ms" of slide drawing, or a dash. */
export function rasterText(h: OutputHealthEntry | undefined): string {
  const r = h?.rasterMs;
  return r ? `${r.p50} / ${r.p95} ms` : '—';
}

/** Per-output arm marker for a cue: grey (not armed), amber (arming), green (armed), red (failed). */
export function armDot(h: OutputHealthEntry | undefined, cueIndex: number, state: LiveState): Dot {
  if (!h?.connected) return 'grey';
  if (h.armed === cueIndex) {
    if (h.armedOk === false) return 'red';
    if (h.armedOk === true) return 'green';
    return 'amber';
  }
  if (h.live === cueIndex && state.live === cueIndex) return 'green';
  if (state.armed === cueIndex) return 'amber';
  return 'grey';
}

/** Whether an output is still waiting to show the live cue (GO on an unarmed slide). */
export function waitingForLive(h: OutputHealthEntry | undefined, state: LiveState): boolean {
  if (!h || !h.connected || state.live === undefined) return false;
  return h.live !== state.live;
}

/** Minimum cache progress across windows (the operator's own fill counts as one window). */
export function cacheSummary(
  entries: OutputHealthEntry[],
  own?: { ready: number; total: number },
): { ready: number; total: number; frac: number } {
  let worst = own && own.total > 0 ? own.ready / own.total : 1;
  let ready = own?.ready ?? 0;
  let total = own?.total ?? 0;
  for (const h of entries) {
    if (!h.connected || h.cache.total === 0) continue;
    const f = h.cache.ready / h.cache.total;
    if (f < worst) {
      worst = f;
      ready = h.cache.ready;
      total = h.cache.total;
    }
  }
  return { ready, total, frac: worst };
}

export function dotTitle(h: OutputHealthEntry | undefined, name: string): string {
  if (!h) return `${name}: not connected`;
  return [
    `${name}: ${h.connected ? 'connected' : 'disconnected'}${h.bus ? ` via ${h.bus}` : ''}`,
    `frames ${h.presented}, missed ${h.missed}, long tasks ${h.longTasks}, late flips ${h.lateFlips ?? 0}`,
    `cache ${h.cache.ready}/${h.cache.total}`,
    h.fps !== undefined ? `fps ${h.fps.toFixed(1)}` : '',
    h.gpuLost ? `GPU lost ${h.gpuLost}×` : '',
    h.videoDropped ? `video dropped ${h.videoDropped}` : '',
    h.audio ? `audio ${h.audio}` : '',
    h.error ? `error: ${h.error}` : '',
    ...outputIssues(h).map((i) => i.label),
  ]
    .filter(Boolean)
    .join('\n');
}

export type CacheIntegrity = {
  outputId: string;
  name: string;
  ready: number;
  total: number;
  /** Files of the live manifest this window does not hold yet (or failed to fetch). */
  missing: number;
  /** Not connected or not reporting: nothing can be said about its cache. */
  unknown: boolean;
};

/**
 * Cache integrity per output window (prd/08 "A cache integrity check runs at Launch outputs"): compares
 * what each window reports against the manifest size the hub gave it. Only outputs in `outputs` (the
 * enabled ones) are checked; the stage window has no media to cache but reports fonts the same way.
 */
export function cacheIntegrity(
  outputs: { id: string; name: string }[],
  health: Record<string, OutputHealthEntry | undefined>,
): CacheIntegrity[] {
  return outputs.map((o) => {
    const h = health[o.id];
    if (!h?.connected) return { outputId: o.id, name: o.name, ready: 0, total: 0, missing: 0, unknown: true };
    const missing = Math.max(0, h.cache.total - h.cache.ready);
    return {
      outputId: o.id,
      name: o.name,
      ready: h.cache.ready,
      total: h.cache.total,
      missing,
      unknown: false,
    };
  });
}

/** True once every window has reported and none is still filling (ready = total). */
export function cacheSettled(rows: CacheIntegrity[]): boolean {
  return rows.every((r) => !r.unknown && r.missing === 0);
}

/**
 * Operator-facing summary of a cache check, or null when every window holds the whole manifest:
 * "Service cache: 3 missing on Audience 1 (41/44), Lobby not reporting".
 */
export function cacheIntegrityMessage(rows: CacheIntegrity[]): string | null {
  const parts: string[] = [];
  for (const r of rows) {
    if (r.unknown) parts.push(`${r.name} not reporting`);
    else if (r.missing > 0) parts.push(`${r.missing} missing on ${r.name} (${r.ready}/${r.total})`);
  }
  return parts.length ? `Service cache: ${parts.join(', ')}` : null;
}

/**
 * Decides when a cache check after Launch is over: every window holds the whole manifest, or no window's
 * numbers have moved for `settleMs` (`unknownMs` for a window that has not reported yet, since launching
 * and connecting takes a few seconds), or `timeoutMs` has passed since the launch.
 */
export class CacheCheckTracker {
  private last = new Map<string, { key: string; at: number }>();
  constructor(
    private readonly started: number,
    private readonly opts: { settleMs: number; unknownMs: number; timeoutMs: number } = {
      settleMs: 5000,
      unknownMs: 15_000,
      timeoutMs: 60_000,
    },
  ) {}

  /** Feed the latest rows; true when the check should report now. */
  update(rows: CacheIntegrity[], now: number): boolean {
    if (cacheSettled(rows)) return true;
    if (now - this.started >= this.opts.timeoutMs) return true;
    let moving = false;
    for (const r of rows) {
      const key = r.unknown ? 'unknown' : `${r.ready}/${r.total}`;
      let prev = this.last.get(r.outputId);
      if (!prev || prev.key !== key) {
        prev = { key, at: now };
        this.last.set(r.outputId, prev);
      }
      if (r.unknown || r.missing > 0) {
        const limit = r.unknown ? this.opts.unknownMs : this.opts.settleMs;
        if (now - prev.at < limit) moving = true;
      }
    }
    return !moving;
  }
}

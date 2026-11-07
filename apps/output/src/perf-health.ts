import type { OutputHealth } from '@ordo/protocol';
import { type PerfAlarm, TimingWindow, coverageScripts } from '@ordo/renderer';

/**
 * The link's performance and font-coverage part of health (design/27 §13 and §15 M7): slide raster times
 * from the asset worker's results, the characters drawn that no face of the output covers, and a log line
 * whenever a budget alarm starts or ends. The figures go into `buildHealth` (renderer health.ts), which
 * adds the budgets for the output's size and the alarms.
 */

/** Slides the raster percentiles are taken over. */
export const RASTER_WINDOW = 64;
/** Slide keys whose uncovered characters are kept (this service), oldest dropped first. */
const MAX_COVERAGE_KEYS = 256;
/** Distinct uncovered characters a health report lists (the count says how many there are). */
const MAX_REPORTED_CHARS = 64;

export type DoneTiming = { key: string; ms: number; rasterMs?: number; uncovered?: string };

/** The performance figures of a health report. */
type Perf = Pick<OutputHealth, 'gpuMB' | 'rasterMs' | 'uploadMs' | 'budgets' | 'alarms' | 'fontCoverage'>;

const ALARM_TEXT: Record<PerfAlarm, (h: Perf) => string> = {
  gpuMemory: (h) => `GPU memory ${h.gpuMB} MB is over the ${h.budgets?.gpuMB} MB budget`,
  raster: (h) =>
    `slide raster p95 ${h.rasterMs?.p95} ms is over the ${h.budgets?.rasterP95Ms} ms budget (p50 ${h.rasterMs?.p50} ms, ${h.rasterMs?.n} slides)`,
  upload: (h) => `texture upload ${h.uploadMs} ms per frame is over the ${h.budgets?.uploadMs} ms budget`,
};

export class PerfHealth {
  readonly raster = new TimingWindow(RASTER_WINDOW);
  /** Uncovered characters by the slide key that drew them (this service). */
  private uncovered = new Map<string, string>();
  /** Every uncovered character logged this service: each is logged once. */
  private logged = new Set<string>();
  private alarms = new Set<string>();

  /**
   * A job's result. Slide keys count toward the raster percentiles (`rasterMs`, the draw on the asset
   * worker's thread; `ms`, its whole time, from a worker that does not report it). Returns a log line
   * when the job drew characters not logged before.
   */
  done(m: DoneTiming): string | undefined {
    const slide = m.key.startsWith('sl|');
    if (slide) this.raster.add(m.rasterMs ?? m.ms);
    if (!m.uncovered) {
      this.uncovered.delete(m.key);
      return undefined;
    }
    this.uncovered.delete(m.key);
    this.uncovered.set(m.key, m.uncovered);
    while (this.uncovered.size > MAX_COVERAGE_KEYS)
      this.uncovered.delete(this.uncovered.keys().next().value!);
    const fresh = [...m.uncovered].filter((ch) => !this.logged.has(ch));
    if (!fresh.length) return undefined;
    for (const ch of fresh) this.logged.add(ch);
    const chars = fresh.join('');
    const codes = fresh.map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    return `no font on this output has ${fresh.length} character(s) of ${m.key.slice(0, 60)}: ${chars} (${codes.slice(0, 8).join(' ')}${codes.length > 8 ? ' …' : ''}; ${coverageScripts(chars).join(', ')}); drawn with this computer's own fallback font`;
  }

  /** The characters of this service no face covers, for `buildHealth`; undefined when there are none. */
  fontCoverage(): { chars: string; count: number; scripts: string[] } | undefined {
    const all = new Set<number>();
    for (const s of this.uncovered.values()) for (const ch of s) all.add(ch.codePointAt(0)!);
    if (!all.size) return undefined;
    const chars = String.fromCodePoint(...[...all].sort((a, b) => a - b).slice(0, MAX_REPORTED_CHARS));
    return { chars, count: all.size, scripts: coverageScripts(String.fromCodePoint(...all)).slice(0, 16) };
  }

  /**
   * Faces became available: the slides with uncovered characters may be covered now. Returns them (the
   * link draws again those the renderer holds); they report again when drawn. Keys not drawn again are
   * forgotten, since nothing can say whether they are still uncovered.
   */
  fontsReady(): string[] {
    const keys = [...this.uncovered.keys()];
    this.uncovered.clear();
    return keys;
  }

  /** A new service (or End service): what was uncovered belonged to the previous one. */
  newService(): void {
    this.uncovered.clear();
    this.logged.clear();
  }

  /** Log lines for alarms that started or ended since the previous report. */
  alarmChanges(h: Perf, size: string): string[] {
    const now = new Set<string>(h.alarms ?? []);
    const out: string[] = [];
    for (const a of now)
      if (!this.alarms.has(a))
        out.push(`performance alarm at ${size}: ${ALARM_TEXT[a as PerfAlarm]?.(h) ?? a}`);
    for (const a of this.alarms) if (!now.has(a)) out.push(`performance alarm over: ${a}`);
    this.alarms = now;
    return out;
  }
}

/** Diagnostics lines (the output's Ctrl+Shift+D view) for the performance figures of a health report. */
export function perfDiagnostics(h: Perf): Record<string, string> {
  const b = h.budgets;
  const r = h.rasterMs;
  const fc = h.fontCoverage;
  return {
    raster: r
      ? `slides p50 ${r.p50} ms, p95 ${r.p95} ms, max ${r.max} ms over ${r.n}${b ? ` (budget p95 ${b.rasterP95Ms} ms)` : ''}`
      : '-',
    upload:
      h.uploadMs !== undefined
        ? `${h.uploadMs} ms per frame at most${b ? ` (budget ${b.uploadMs} ms)` : ''}`
        : '-',
    gpuBudget: b ? `${b.gpuMB} MB` : '-',
    alarms: h.alarms?.length ? h.alarms.join(', ') : 'none',
    glyphs: fc ? `${fc.count} without a font: ${fc.chars} (${fc.scripts.join(', ')})` : 'ok',
  };
}

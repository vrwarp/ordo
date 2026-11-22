/**
 * Test mode of the bake service (`?test=1` in the URL, or localStorage `ordo.test` = 1, as services/controller.ts
 * reads it; a copy, because the controller imports the boot): the end-to-end specs shorten the waits with
 * `&bakeTimings=start:0,settle:500,gap:0,resume:2000,idle:2000` and read `window.__ordo.bake`. Nothing here is read
 * outside test mode, so the product's waits (15 s, 3 s, 1 s, 120 s, 300 s) cannot be changed from a URL.
 */

export type BakeTimings = {
  startDelayMs: number;
  settleMs: number;
  gapMs: number;
  resumeMs: number;
  idleSweepMs: number;
};

export function bakeTestMode(
  search: string = typeof location === 'undefined' ? '' : location.search,
  stored: () => string | null = () => {
    try {
      return localStorage.getItem('ordo.test');
    } catch {
      return null;
    }
  },
): boolean {
  try {
    if (new URLSearchParams(search).get('test') === '1') return true;
    return stored() === '1';
  } catch {
    return false;
  }
}

/** `&bakeTimings=start:0,settle:500,gap:0,resume:2000,idle:2000` (test mode only), milliseconds, at most ten minutes. */
export function bakeTimingsFromUrl(
  search: string = typeof location === 'undefined' ? '' : location.search,
): Partial<BakeTimings> {
  const raw = new URLSearchParams(search).get('bakeTimings');
  const out: Partial<BakeTimings> = {};
  if (!raw) return out;
  const names: Record<string, keyof BakeTimings> = {
    start: 'startDelayMs',
    settle: 'settleMs',
    gap: 'gapMs',
    resume: 'resumeMs',
    idle: 'idleSweepMs',
  };
  for (const part of raw.split(',')) {
    const [k, v] = part.split(':');
    const n = Number(v);
    const name = k ? names[k] : undefined;
    if (name && Number.isFinite(n) && n >= 0 && n <= 600_000) out[name] = n;
  }
  return out;
}

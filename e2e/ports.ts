import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every port the end-to-end suite listens on, in one table (design/23 "Ports"): each row is a spec's ports as
 * an offset from one base and a count, the ports that spec really opens (hubs, proxies, servers). A spec
 * reads its ports with `portOf(row, i)`, never a literal and never an environment variable of its own, so
 * two specs cannot share a port and `e2e/ports.test.ts` checks the table: offsets unique, ranges disjoint,
 * every range inside the span, and no spec with a literal port or a port variable.
 *
 * The base is `ORDO_E2E_PORT_BASE` when set. On CI (`CI` or `ORDO_CI`) it is fixed at 16000. Otherwise it is
 * 16000 + 1000 x (a hash of this checkout's path, mod 15): two worktrees of the repository on one machine get
 * different bases, so their suites can run side by side. Every default range ends below 32768, where Linux
 * starts handing out ephemeral ports (`ip_local_port_range`), and starts at 16000 or above.
 *
 * The shared web server of `playwright.config.ts` (the hub most specs use, `helpers.ts` PORT) is the row
 * `shared`; `ORDO_E2E_PORT` still moves it on its own.
 */

/** Ports from the base the table may use: every row ends below base + span. */
export const PORT_SPAN = 1000;
/** The lowest default base and the number of 1000-port slots a checkout's hash picks from. */
export const DEFAULT_BASE_MIN = 16_000;
export const DEFAULT_BASE_SLOTS = 15;
/** The base CI uses (one checkout per runner). */
export const CI_PORT_BASE = 16_000;

type Row = {
  /** First port, from the base. */
  readonly offset: number;
  /** How many ports from there (index 0 .. count - 1). */
  readonly count: number;
  /** The spec that owns the row (path under e2e/); a spec not written yet holds the row reserved. */
  readonly spec: string;
  /** What each port is for. */
  readonly what: string;
};

export const PORT_TABLE = {
  shared: {
    offset: 0,
    count: 1,
    spec: '(playwright.config.ts)',
    what: 'the shared web server; ORDO_E2E_PORT overrides',
  },
  degraded: { offset: 10, count: 1, spec: 'degraded.spec.ts', what: 'hub' },
  operator: { offset: 11, count: 1, spec: 'operator.spec.ts', what: 'hub' },
  'playlist-continuous-scroll': {
    offset: 12,
    count: 1,
    spec: 'playlist-continuous-scroll.spec.ts',
    what: 'hub',
  },
  'link-silent-hub': { offset: 20, count: 2, spec: 'link-silent-hub.spec.ts', what: '0 TCP proxy, 1 hub' },
  'link-blip': { offset: 22, count: 2, spec: 'link-blip.spec.ts', what: '0 TCP proxy, 1 hub' },
  'link-fallback-leave': { offset: 24, count: 1, spec: 'link-fallback-leave.spec.ts', what: 'hub' },
  'pptx-preview': {
    offset: 30,
    count: 2,
    spec: 'pptx-preview.spec.ts',
    what: '0 hub, 1 hub without LibreOffice',
  },
  'pptx-native': { offset: 32, count: 2, spec: 'pptx-native.spec.ts', what: '0 hub, 1 lite hub' },
  'pptx-media': { offset: 34, count: 1, spec: 'pptx-media.spec.ts', what: 'hub' },
  'pptx-import-tab': { offset: 35, count: 1, spec: 'pptx-import-tab.spec.ts', what: 'hub' },
  // Reserved for the wave r2a specs being written beside this table (the integrator moves them onto it).
  'pptx-lineart': { offset: 36, count: 1, spec: 'pptx-lineart.spec.ts', what: 'hub (reserved)' },
  'pptx-decor': { offset: 37, count: 2, spec: 'pptx-decor.spec.ts', what: 'hubs (reserved)' },
  'pptx-guard': {
    offset: 39,
    count: 2,
    spec: 'pptx-guard.spec.ts',
    what: 'hubs with and without LibreOffice (reserved)',
  },
  'pptx-text': { offset: 41, count: 1, spec: 'pptx-text.spec.ts', what: 'hub (reserved)' },
  'chaos-output': {
    offset: 50,
    count: 6,
    spec: 'chaos-output.spec.ts',
    what: '0 hub, 1 hub, 2 hub, 3 file-outage proxy of 2, 4 hub, 5 file-outage proxy of 4',
  },
  'chaos-operator': { offset: 60, count: 7, spec: 'chaos-operator.spec.ts', what: 'one hub per test' },
  'chaos-stage': { offset: 70, count: 2, spec: 'chaos-stage.spec.ts', what: '0 hub, 1 hub (fallback bus)' },
  'chaos-hub': { offset: 75, count: 1, spec: 'chaos-hub.spec.ts', what: 'hub (supervisor and children)' },
  'local-golive': { offset: 80, count: 2, spec: 'local-golive.spec.ts', what: 'one hub per test' },
  'pages-demo': {
    offset: 85,
    count: 1,
    spec: 'pages-demo.spec.ts',
    what: 'static server of the Pages build',
  },
  'pro7-import': { offset: 86, count: 1, spec: 'pro7-import.spec.ts', what: 'hub' },
  'editor-m4': { offset: 100, count: 1, spec: 'editor-m4.spec.ts', what: 'hub' },
  'editor-text': { offset: 101, count: 1, spec: 'editor-text.spec.ts', what: 'hub' },
  'editor-group': { offset: 102, count: 1, spec: 'editor-group.spec.ts', what: 'hub' },
  'editor-format': { offset: 103, count: 1, spec: 'editor-format.spec.ts', what: 'hub' },
  'editor-pictures': { offset: 104, count: 1, spec: 'editor-pictures.spec.ts', what: 'hub' },
  'editor-slides': { offset: 105, count: 1, spec: 'editor-slides.spec.ts', what: 'hub' },
  'editor-reimport': { offset: 106, count: 1, spec: 'editor-reimport.spec.ts', what: 'hub' },
  'editor-stage': { offset: 107, count: 1, spec: 'editor-stage.spec.ts', what: 'hub' },
  'editor-merge': { offset: 108, count: 1, spec: 'editor-merge.spec.ts', what: 'hub' },
  'editor-keys': { offset: 109, count: 1, spec: 'editor-keys.spec.ts', what: 'hub' },
  'editor-script': { offset: 110, count: 1, spec: 'editor-script.spec.ts', what: 'hub' },
  'editor-canvas-first': { offset: 111, count: 1, spec: 'editor-canvas-first.spec.ts', what: 'hub' },
  'editor-fit': { offset: 112, count: 1, spec: 'editor-fit.spec.ts', what: 'hub' },
  // The iPad specs run twice (landscape and portrait projects), one test at a time: a test that runs in both
  // takes one port per orientation where the two would otherwise reuse each other's hub data.
  'ipad-edit': { offset: 200, count: 4, spec: 'ipad/edit.spec.ts', what: 'one hub per test' },
  'ipad-group': { offset: 210, count: 2, spec: 'ipad/group.spec.ts', what: '0 landscape, 1 portrait' },
  'ipad-touch-targets': {
    offset: 215,
    count: 2,
    spec: 'ipad/touch-targets.spec.ts',
    what: '0 landscape, 1 portrait',
  },
  'ipad-touch': {
    offset: 220,
    count: 6,
    spec: 'ipad/touch.spec.ts',
    what: 'tests 0-2 landscape, 3-5 portrait',
  },
} as const satisfies Record<string, Row>;

export type PortRow = keyof typeof PORT_TABLE;

/** FNV-1a (32 bit) of a string: a stable hash of the checkout's path, the same in every worker. */
export function pathHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The default base for a checkout at `root`: 16000 + 1000 x (hash mod 15). */
export function defaultBase(root: string): number {
  return DEFAULT_BASE_MIN + 1000 * (pathHash(root) % DEFAULT_BASE_SLOTS);
}

/** This checkout's root (the folder above e2e/), resolved, so a symlinked path hashes like the real one. */
function checkoutRoot(): string {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The base from the environment: ORDO_E2E_PORT_BASE, else CI's, else this checkout's default. */
export function portBase(
  env: Record<string, string | undefined> = process.env,
  root = checkoutRoot(),
): number {
  const set = env.ORDO_E2E_PORT_BASE;
  if (set !== undefined && set !== '') {
    const n = Number(set);
    if (!Number.isInteger(n) || n < 1024 || n + PORT_SPAN > 65_536)
      throw new RangeError(`ORDO_E2E_PORT_BASE=${set}: a whole number from 1024 to ${65_536 - PORT_SPAN}`);
    return n;
  }
  if (env.CI || env.ORDO_CI) return CI_PORT_BASE;
  return defaultBase(root);
}

export const PORT_BASE = portBase();

/** Port `i` of a row: base + offset + i. Asking past the row's count throws (add the port to the table). */
export function portOf(row: PortRow, i = 0): number {
  const r: Row = PORT_TABLE[row];
  if (!Number.isInteger(i) || i < 0 || i >= r.count)
    throw new RangeError(`e2e port row '${row}' has ${r.count} port(s); #${i} is not one (e2e/ports.ts)`);
  return PORT_BASE + r.offset + i;
}

/** The shared web server's port (playwright.config.ts, helpers.ts PORT): ORDO_E2E_PORT, else the table's. */
export const SHARED_PORT = sharedPort();

function sharedPort(): number {
  const set = process.env.ORDO_E2E_PORT;
  if (set === undefined || set === '') return portOf('shared');
  const n = Number(set);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new RangeError(`ORDO_E2E_PORT=${set}: not a port`);
  return n;
}

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
 * starts handing out ephemeral ports (`ip_local_port_range`), and starts at 16000 or above. An explicit base may
 * sit below 16000 (a wave's parallel tracks each take a block outside the default bases, design/29 §4); it then
 * keeps out of 5000-5999 (`tools/serve-demo.mjs` serves on 5173) and 8000-8999 (the shared `ORDO_E2E_PORT`s), and
 * no row may land on a port browsers refuse to fetch (10080 is one: base 10000 puts `local-golive` there).
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
  'surfaces-upgrade': {
    offset: 13,
    count: 1,
    spec: 'surfaces-upgrade.spec.ts',
    what: 'hub (restarted on a seeded surfaces row)',
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
  'pptx-lineart': { offset: 36, count: 1, spec: 'pptx-lineart.spec.ts', what: 'hub' },
  'pptx-decor': {
    offset: 37,
    count: 2,
    spec: 'pptx-decor.spec.ts',
    what: '0 hub without LibreOffice (Import tab), 1 hub with LibreOffice (upload route)',
  },
  'pptx-guard': {
    offset: 39,
    count: 2,
    spec: 'pptx-guard.spec.ts',
    what: '0 hub with LibreOffice, 1 hub without',
  },
  'pptx-text': { offset: 41, count: 1, spec: 'pptx-text.spec.ts', what: 'hub without LibreOffice' },
  'chaos-output': {
    offset: 50,
    count: 6,
    spec: 'chaos-output.spec.ts',
    what: '0 hub, 1 hub, 2 hub, 3 file-outage proxy of 2, 4 hub, 5 file-outage proxy of 4',
  },
  'chaos-operator': { offset: 60, count: 9, spec: 'chaos-operator.spec.ts', what: 'one hub per test' },
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
  // The iPad specs run three times (landscape, portrait and the Android tablet projects), one test at a time: a
  // test that runs in each takes one port per project where they would otherwise reuse each other's hub data.
  'ipad-edit': { offset: 200, count: 4, spec: 'ipad/edit.spec.ts', what: 'one hub per test' },
  'ipad-group': {
    offset: 210,
    count: 3,
    spec: 'ipad/group.spec.ts',
    what: '0 landscape, 1 portrait, 2 chromium-tablet (skips)',
  },
  'ipad-touch-targets': {
    offset: 215,
    count: 3,
    spec: 'ipad/touch-targets.spec.ts',
    what: '0 landscape, 1 portrait, 2 chromium-tablet',
  },
  'ipad-touch': {
    offset: 220,
    count: 6,
    spec: 'ipad/touch.spec.ts',
    what: 'tests 0-2 landscape, 3-5 portrait',
  },
  // Phones P0 (design/28 §8), the code split: a spec both phone projects run takes one port per project.
  // 310-339 belong to the compact shell's specs, 340-349 to the hub's, 350-359 to the integration's.
  'split-full': { offset: 300, count: 1, spec: 'split-full.spec.ts', what: 'hub' },
  'ipad-split': {
    offset: 301,
    count: 3,
    spec: 'ipad/split.spec.ts',
    what: '0 webkit-ipad, 1 webkit-ipad-portrait, 2 chromium-tablet',
  },
  'phone-split': {
    offset: 305,
    count: 2,
    spec: 'phone/split.spec.ts',
    what: '0 webkit-iphone, 1 chromium-android',
  },
  // The compact shell: one hub per test and project (test k: 2k webkit-iphone, 2k+1 chromium-android), so a
  // test's sign-ins, lockouts and live service never meet another's; the row may grow to 26.
  'phone-shell': {
    offset: 310,
    count: 24,
    spec: 'phone/shell.spec.ts',
    what: 'test k: 2k webkit-iphone, 2k+1 chromium-android',
  },
  'phone-demo': {
    offset: 336,
    count: 2,
    spec: 'phone/demo.spec.ts',
    what: 'static server of the Pages build, one per phone project',
  },
  // Phones P0, the hub lane (design/28 §8 "Live boundary" and "Hub"): offsets 340-349.
  'phone-live-boundary': {
    offset: 340,
    count: 2,
    spec: 'phone/live-boundary.spec.ts',
    what: '0 webkit-iphone, 1 chromium-android',
  },
  'phones-live-load': { offset: 345, count: 1, spec: 'phones-live-load.spec.ts', what: 'hub' },
  'phones-writes': { offset: 346, count: 1, spec: 'phones-writes.spec.ts', what: 'hub' },
  // M9 wave r2b's specs: offsets 400-659, in offset order (sub-wave 1: 400-459; sub-wave 1b: 440, and 445-449 kept
  // for its integration; the integrations' 425, 630-659).
  // effect-units: effects past the budget and lone line art drawn from units.
  'effect-units': {
    offset: 400,
    count: 2,
    spec: 'effect-units.spec.ts',
    what: '0 hub (effects past the budget), 1 hub (hostile lone line art, upload route)',
  },
  // units-live: a GO never waits for drawing; late parts fade in; the playlist warmed ahead.
  'units-live': {
    offset: 405,
    count: 2,
    spec: 'units-live.spec.ts',
    what: '0 hub (a jump to a slide not prepared; a GO 50 ms after its arm), 1 hub (the playlist warmed ahead)',
  },
  'editor-table': { offset: 420, count: 1, spec: 'editor-table.spec.ts', what: 'hub' },
  'ipad-table-targets': {
    offset: 421,
    count: 3,
    spec: 'ipad/table-targets.spec.ts',
    what: '0 webkit-ipad, 1 webkit-ipad-portrait, 2 chromium-tablet',
  },
  // The integration of sub-wave 1: a PowerPoint table imported, a cell edited, live.
  'pptx-table-edit': {
    offset: 425,
    count: 1,
    spec: 'pptx-table-edit.spec.ts',
    what: 'hub without LibreOffice (import tableDeck, edit a cell, Go live)',
  },
  // tables-conv: PowerPoint tables imported as one table object.
  'pptx-tables': {
    offset: 430,
    count: 3,
    spec: 'pptx-tables.spec.ts',
    what: '0 hub without LibreOffice (Import tab), 1 hub without LibreOffice (upload route), 2 hub with LibreOffice',
  },
  // tables-cells (1b): 'Make editable' on LibreOffice's page a native import stored, on a hub with LibreOffice.
  'editor-reimport-lo': {
    offset: 440,
    count: 1,
    spec: 'editor-reimport-lo.spec.ts',
    what: 'hub with LibreOffice (a 64 KB page made editable: 202, the job, its text boxes)',
  },
  // golive-prepare (design/29 §2.3 M8): Go live prepared beside the running service.
  'golive-prepare': {
    offset: 450,
    count: 2,
    spec: 'golive-prepare.spec.ts',
    what: '0 hub with a slowed library (Go live again during a service), 1 hub (size ceiling)',
  },
  // live-by-ref (design/29 §2.3 M2): a hub killed and restarted during a 6 MiB service kept by reference.
  'live-by-ref': {
    offset: 480,
    count: 1,
    spec: 'live-by-ref.spec.ts',
    what: 'hub (restarted)',
  },
  // xml-compact (design/29 B3-B6): dense decks through the upload route and the Import tab.
  'pptx-dense': {
    offset: 510,
    count: 2,
    spec: 'pptx-dense.spec.ts',
    what: '0 hub without LibreOffice (the upload route: a traced deck, an 80 MB deck, a part and a slide past the bounds, a deck declaring 300 MiB), 1 hub without LibreOffice (the Import tab: the browser parses a 12 MB deck, declines an 80 MB one and the hub parses it)',
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

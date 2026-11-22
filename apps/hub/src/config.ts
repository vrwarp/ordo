import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRERENDER_ON } from '@ordo/domain/prerender.ts';
import type { Logger } from 'pino';
import { minFreeConfig, type StatFsFn } from './diskfloor.ts';
import type { SystemFaceLookup } from './pptx/systemFaces.ts';
import type { ToolProbe } from './tools.ts';

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type HubConfig = {
  /** e.g. `localhost` or `venue.synology.me`. Role hosts are `<label>.<domain>`. */
  domain: string;
  /** Data directory: ordo.db, media/, fonts/, uploads/, backups/. */
  dataDir: string;
  port: number;
  host: string;
  /** CIDR list of reverse proxies whose X-Forwarded-* headers are trusted. */
  trustedProxies: string[];
  /** Fallback venue time zone (IANA): seeds settings.general.timeZone on first run and stands in when that is unusable. */
  timeZone: string;
  /** Extra Host names the hub answers for, besides the domain, its role hosts, localhost and loopback. */
  allowedHosts: string[];
  /** Directory holding apps/<name>/dist. */
  appsDir: string;
  /** Optional `operate[:edit]` PINs for unattended dev/test setup. */
  devPin?: string;
  /** Roots a `POST /import/pro7 { path }` may read from. */
  importRoots: string[];
  logLevel: string;
  /** Write logs to stdout (the ring buffer always receives them). */
  logToStdout: boolean;
  /** Network fetcher for Google Fonts; injectable for tests. */
  fetch: FetchLike;
  /** Run the nightly backup scheduler. */
  scheduleBackups: boolean;
  /** Seconds between live snapshots. */
  snapshotIntervalMs: number;
  /** Health summary interval. */
  healthIntervalMs: number;
  /**
   * How long after End service held heavy jobs keep waiting (ORDO_PACE_GRACE_MS, default 2 minutes; design/28
   * §5.3): a second service on the same morning, the venue PC's offline download after the first.
   */
  paceGraceMs: number;
  /** ORDO_COLLECT: what the nightly collection of unnamed content files does (see `collectMode`). */
  collect: CollectMode;
  /**
   * The free-space floor (ORDO_MIN_FREE_GB, whole GB; design/29 §1.3 A25): replaces the computed one
   * (5 % of the volume, from 5 GiB to 25 GiB); 0 turns it off. Unset: computed. `minFreeWarning`: why a
   * value given was not understood (logged once at start). `statfs`: tests only.
   */
  minFreeBytes?: number;
  minFreeWarning?: string;
  statfs?: StatFsFn;
  /** Optional override for the importers module (tests). */
  importers?: unknown;
  /** Tool timeouts (ms). */
  timeouts: { probe: number; transcode: number; soffice: number; pdf: number; light: number };
  /**
   * Headless Chromium for the pptx-preview PowerPoint renderer (ORDO_CHROMIUM, default `chromium` on the
   * PATH). `sandbox` keeps Chromium's sandbox (ORDO_CHROMIUM_SANDBOX=1); containers usually cannot.
   */
  chromium: { path: string; sandbox: boolean };
  /**
   * LibreOffice (design/27 M9: optional; `tools.ts`). `ORDO_LIBREOFFICE`: `auto` or unset (the default:
   * `soffice` on the PATH, else the Debian alias `libreoffice`), `off` (also `0`, `false`, `no`: no office code
   * ever runs on a deck), or the absolute path of soffice. Anything else is `warning` (logged at start) and auto.
   */
  libreoffice: LibreOfficeConfig;
  /**
   * ORDO_LIVE_BYREF (live-by-ref): the running service is kept and sent by reference (snapshots and the journal
   * name the resolved copy, a socket that holds it is sent the state without it). `off` writes and sends the
   * whole forms as before this existed; a data folder written either way restores either way. Read once.
   */
  liveByRef: boolean;
  /** Why the value given was not understood (logged once at start; on applies). */
  liveByRefWarning?: string;
  /**
   * ORDO_PRERENDER (store-2, design/29 §1.11): the release's one switch for pictures of heavy slides, read once at
   * start by each hub process (`prerenderConfig` has the table). `on` is what operators are told
   * (`GET /capabilities` `prerender.state`, the public health) and what the Go-live picture line (W33) follows;
   * `store` (the picture PUT, the keys job, the picture rows of a goLive) is closed only by an explicit `off`.
   */
  prerender: PrerenderConfig;
  /**
   * Tests only: decides each server tool's state instead of looking for it on the PATH and running its version
   * command (`tools.ts` `HubTools`). `libreoffice.mode: 'off'` still wins.
   */
  toolProbe?: ToolProbe;
  /**
   * Where the hub finds this computer's script faces (sub-wave 1c rule H, `pptx/systemFaces.ts`): a table cell
   * in a script drawn glyph by glyph that the font library has no face for is measured with the face this
   * computer's font configuration gives (the face its LibreOffice and its browsers fall back to). Unset:
   * fontconfig (`fontconfigLookup`, fc-match by absolute path), resolved once at start. The hub's test helpers
   * set `noSystemFaces`, so a hub test means the same on every computer; a test injects its own lookup.
   */
  systemFaces?: SystemFaceLookup;
  /** Number of concurrent heavy and light jobs. */
  jobs: { heavy: number; light: number };
  /**
   * Where the bundled fonts are installed (ORDO_FONTS_DIR; the image sets /usr/share/fonts): registered as
   * library fonts at start (fonts/bundled.ts, design/27 §10). Unset: none are registered.
   */
  fontsDir?: string;
  /**
   * How long the hub waits for its bundled fonts to be registered before it listens (ORDO_FONTS_WAIT_MS; default
   * 2,000, 0 = do not wait): until then the font list is partial (fresh data folder, or an image with new fonts).
   * After the bound it listens anyway and says so in its log.
   */
  fontsWaitMs: number;
};

export type LibreOfficeConfig = {
  mode: 'auto' | 'off';
  /** The command auto looks for (`soffice`), or the absolute path given; '' when off. */
  exe: string;
  /** Why the value given was not understood (logged once at start; auto applies). */
  warning?: string;
};

/** `ORDO_LIBREOFFICE` read (`HubConfig.libreoffice`). Never throws. */
export function libreofficeConfig(v: string | undefined): LibreOfficeConfig {
  const t = (v ?? '').trim();
  if (!t || t.toLowerCase() === 'auto') return { mode: 'auto', exe: 'soffice' };
  if (/^(0|off|false|no)$/i.test(t)) return { mode: 'off', exe: '' };
  if (isAbsolute(t) && !t.includes('\0') && t.length <= 4096) return { mode: 'auto', exe: t };
  return {
    mode: 'auto',
    exe: 'soffice',
    warning: `ORDO_LIBREOFFICE is neither auto, off nor an absolute path (${JSON.stringify(t.slice(0, 100))}): auto`,
  };
}

/** `ORDO_LIVE_BYREF` read: `on` (default and anything unset), `off`; any other value is on with a warning. */
export function liveByRefConfig(v: string | undefined): { on: boolean; warning?: string } {
  const t = (v ?? '').trim();
  if (!t || /^(1|on|true|yes)$/i.test(t)) return { on: true };
  if (/^(0|off|false|no)$/i.test(t)) return { on: false };
  return {
    on: true,
    warning: `ORDO_LIVE_BYREF is neither on nor off (${JSON.stringify(t.slice(0, 100))}): on`,
  };
}

export type PrerenderSetting = 'auto' | 'on' | 'off';
export type PrerenderConfig = {
  /** What was set (`auto` when unset or not understood). */
  setting: PrerenderSetting;
  /** What operators are told, and what W33 follows: auto follows the domain constant, on and off say so. */
  on: boolean;
  /** Whether the store works: the picture PUT, the keys job and the picture rows of a goLive. False only for `off`. */
  store: boolean;
  /** Why the value given was not understood (logged once at start; auto applies). */
  warning?: string;
};

/**
 * `ORDO_PRERENDER` read (`HubConfig.prerender`), never throws. The table (C-S2-1):
 *
 *   setting  on        store
 *   auto     constant  true     (unset, empty, `auto`; before the release's switch commit the constant is false:
 *                                the hub is exactly the 0.10.0 hub, so nothing changes for anyone)
 *   on       true      true     (`on`, `1`, `true`, `yes`)
 *   off      false     false    (`off`, `0`, `false`, `no`: no picture is accepted, no key is computed, a goLive
 *                                lists no picture rows and judges no W33; whatever is stored stays)
 *
 * Any other value is auto with a warning. `constant` is `PRERENDER_ON`, injected by the tests (the hub's test helpers
 * pin `false`, so a hub test means the same before and after the switch commit). This is the one place the hub reads
 * the constant.
 */
export function prerenderConfig(v: string | undefined, constant: boolean = PRERENDER_ON): PrerenderConfig {
  const t = (v ?? '').trim();
  if (!t || /^auto$/i.test(t)) return { setting: 'auto', on: constant, store: true };
  if (/^(1|on|true|yes)$/i.test(t)) return { setting: 'on', on: true, store: true };
  if (/^(0|off|false|no)$/i.test(t)) return { setting: 'off', on: false, store: false };
  return {
    setting: 'auto',
    on: constant,
    store: true,
    warning: `ORDO_PRERENDER is neither auto, on nor off (${JSON.stringify(t.slice(0, 100))}): auto`,
  };
}

/**
 * The start-up lines of the switch, once per process: the warning for a value that is not understood, and (`says`)
 * one plain sentence when the setting is `off`. The library process (or the one-process hub) says it; the live process
 * gives the warning only, so the sentence is in the log once per start.
 */
export function logPrerender(c: PrerenderConfig, log: Pick<Logger, 'info' | 'warn'>, says: boolean): void {
  if (c.warning) log.warn({}, c.warning);
  if (says && c.setting === 'off')
    log.info(
      {},
      'Pictures of heavy slides are turned off (ORDO_PRERENDER=off): heavy slides are drawn live and whole, and nothing already stored is deleted.',
    );
}

/** apps/ of this repo: src/ and dist/ both sit two levels below it. */
export function defaultAppsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

export function parseCidrList(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<HubConfig> = {},
): HubConfig {
  const dataDir = resolve(env.ORDO_DATA ?? './.data');
  const minFree = minFreeConfig(env.ORDO_MIN_FREE_GB);
  return {
    domain: (env.ORDO_DOMAIN ?? 'localhost').toLowerCase(),
    dataDir,
    port: Number(env.ORDO_PORT ?? 8080),
    host: env.ORDO_HOST ?? '0.0.0.0',
    trustedProxies: parseCidrList(env.ORDO_TRUSTED_PROXY),
    timeZone: env.ORDO_TZ ?? env.TZ ?? 'UTC',
    allowedHosts: parseCidrList(env.ORDO_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    appsDir: resolve(env.ORDO_APPS_DIR ?? defaultAppsDir()),
    devPin: env.ORDO_DEV_PIN || undefined,
    importRoots: (env.ORDO_IMPORT_ROOTS
      ? env.ORDO_IMPORT_ROOTS.split(':')
      : [resolve(dataDir, 'import')]
    ).map((p) => resolve(p)),
    logLevel: env.ORDO_LOG_LEVEL ?? 'info',
    logToStdout: true,
    fetch: globalThis.fetch as unknown as FetchLike,
    scheduleBackups: true,
    snapshotIntervalMs: 5000,
    healthIntervalMs: 1000,
    paceGraceMs: paceGrace(env.ORDO_PACE_GRACE_MS),
    collect: collectMode(env.ORDO_COLLECT),
    minFreeBytes: minFree.bytes,
    minFreeWarning: minFree.warning,
    timeouts: { probe: 30_000, transcode: 4 * 3600_000, soffice: 180_000, pdf: 300_000, light: 600_000 },
    jobs: { heavy: 1, light: 2 },
    chromium: { path: env.ORDO_CHROMIUM || 'chromium', sandbox: env.ORDO_CHROMIUM_SANDBOX === '1' },
    libreoffice: libreofficeConfig(env.ORDO_LIBREOFFICE),
    liveByRef: liveByRefConfig(env.ORDO_LIVE_BYREF).on,
    liveByRefWarning: liveByRefConfig(env.ORDO_LIVE_BYREF).warning,
    prerender: prerenderConfig(env.ORDO_PRERENDER),
    fontsDir: env.ORDO_FONTS_DIR ? resolve(env.ORDO_FONTS_DIR) : undefined,
    fontsWaitMs: fontsWait(env.ORDO_FONTS_WAIT_MS),
    ...overrides,
  };
}

/** ORDO_FONTS_WAIT_MS: a whole number of milliseconds from 0 to 30,000; anything else is the default (2 s). */
export function fontsWait(v: string | undefined): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 && n <= 30_000 ? n : 2000;
}

/** ORDO_PACE_GRACE_MS: a whole number of milliseconds from 0 to a day; anything else is the default (2 min). */
export function paceGrace(v: string | undefined): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 && n <= 86_400_000 ? n : 120_000;
}

export type CollectMode = 'off' | 'report' | 'on';

/**
 * ORDO_COLLECT: `on` deletes the content files nothing has named for 31 days (the backups' retention and a night),
 * `off` runs nothing, `report` (the default, also for any other value) marks them and logs what `on` would delete,
 * deleting nothing (design/29, OQ-PS2: collection ships in report mode so an owner sees the counts before any file
 * goes).
 */
export function collectMode(v: string | undefined): CollectMode {
  const m = v?.trim().toLowerCase();
  return m === 'on' || m === 'off' ? m : 'report';
}

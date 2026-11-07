import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
   * Tests only: decides each server tool's state instead of looking for it on the PATH and running its version
   * command (`tools.ts` `HubTools`). `libreoffice.mode: 'off'` still wins.
   */
  toolProbe?: ToolProbe;
  /** Number of concurrent heavy and light jobs. */
  jobs: { heavy: number; light: number };
  /**
   * Where the bundled fonts are installed (ORDO_FONTS_DIR; the image sets /usr/share/fonts): registered as
   * library fonts at start (fonts/bundled.ts, design/27 §10). Unset: none are registered.
   */
  fontsDir?: string;
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
    timeouts: { probe: 30_000, transcode: 4 * 3600_000, soffice: 180_000, pdf: 300_000, light: 600_000 },
    jobs: { heavy: 1, light: 2 },
    chromium: { path: env.ORDO_CHROMIUM || 'chromium', sandbox: env.ORDO_CHROMIUM_SANDBOX === '1' },
    libreoffice: libreofficeConfig(env.ORDO_LIBREOFFICE),
    fontsDir: env.ORDO_FONTS_DIR ? resolve(env.ORDO_FONTS_DIR) : undefined,
    ...overrides,
  };
}

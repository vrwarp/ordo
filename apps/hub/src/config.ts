import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /** Venue time zone (IANA). */
  timeZone: string;
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
  /** Number of concurrent heavy and light jobs. */
  jobs: { heavy: number; light: number };
};

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
    ...overrides,
  };
}

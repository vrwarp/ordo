/**
 * The Chromium the browser tests and the harness tools drive (design/23 "CI"): Playwright's own build when it
 * is installed (`pnpm exec playwright install chromium`; the version the e2e suite runs), else
 * `ORDO_TEST_CHROMIUM`. The CLI tools (`system: true`) take `ORDO_CHROMIUM` first (an explicit choice) and,
 * after those two, a Chromium or Chrome where Linux distributions put them.
 *
 * Nothing found: a developer's run skips the browser tests (undefined), but under CI (`CI` or `ORDO_CI` set)
 * this throws, so a browser test that would quietly skip fails the run instead.
 */
import { existsSync } from 'node:fs';

/** Chromium or Chrome where Linux distributions put them (the tools only). */
const SYSTEM = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];

export type FindChromiumOptions = {
  /** `ORDO_CHROMIUM` first, and the system's Chromium or Chrome last (the CLI tools; tests stay on the pinned one). */
  system?: boolean;
  /** The environment to read (default `process.env`; tests of this function). */
  env?: Record<string, string | undefined>;
  /** Playwright's Chromium (default: `chromium.executablePath()` of `@playwright/test`, when installed). */
  playwright?: () => Promise<string | undefined>;
  /** Whether a path exists (default `existsSync`). */
  exists?: (path: string) => boolean;
};

async function playwrightChromium(): Promise<string | undefined> {
  try {
    const { chromium } = await import('@playwright/test');
    return chromium.executablePath();
  } catch {
    return undefined; // @playwright/test not installed
  }
}

/** Whether this run is CI's: a browser test must run there, never skip. */
export function underCi(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.CI || env.ORDO_CI);
}

export async function findChromium(opts: FindChromiumOptions = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const candidates: (string | undefined)[] = [
    ...(opts.system ? [env.ORDO_CHROMIUM] : []),
    await (opts.playwright ?? playwrightChromium)(),
    env.ORDO_TEST_CHROMIUM,
    ...(opts.system ? SYSTEM : []),
  ];
  for (const c of candidates) if (c && exists(c)) return c;
  if (underCi(env))
    throw new Error(
      'no Chromium for the browser tests: install Playwright\'s ("pnpm exec playwright install chromium") or set ORDO_TEST_CHROMIUM',
    );
  return undefined;
}

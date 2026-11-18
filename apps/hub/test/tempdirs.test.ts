/**
 * A hub test run leaves no `ordo-*` folder in TMPDIR (integrate-1b chore g: about 99 folders a run of the hub's
 * tests, 14,000 on this machine over the waves). The helpers' `tempDir` folders and `startHub` hubs are removed
 * and closed after the test file that made them, also when the file has no cleanup of its own; a process a test
 * starts must not outlive it and write into a removed folder. Each case runs a child vitest with a TMPDIR of its
 * own, which must hold no `ordo-*` folder afterwards.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

/** Run vitest with `args` and a TMPDIR of its own; the `ordo-*` folders it left there. */
function leftBy(args: string[], passed: RegExp): string[] {
  const own = mkdtempSync(join(tmpdir(), 'tempdirs-'));
  try {
    const r = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...args], {
      cwd: root,
      env: { ...process.env, TMPDIR: own },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(passed);
    return readdirSync(own).filter((n) => n.startsWith('ordo-'));
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
}

describe('hub test folders', () => {
  it('a test file that makes folders and a hub without cleaning up leaves nothing in TMPDIR', () => {
    expect(leftBy(['--config', join(here, 'leaks/vitest.config.ts')], /1 passed/)).toEqual([]);
  }, 120_000);

  it('the library and live processes of review3 H4 leave nothing behind them (no LibreOffice probe outlives the test)', () => {
    expect(leftBy([join(here, 'review3.test.ts'), '-t', 'H4'], /1 passed/)).toEqual([]);
  }, 120_000);
});

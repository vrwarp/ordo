import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rasterArgs } from '../../apps/hub/src/pptx/rasterPage.ts';
import { findChromium } from '../find-chromium.ts';

/*
 * The image smoke script of docker-pr.yml ("The picture maker's browser draws a 4K picture inside the image"):
 * its flags are the hub's (a drift here would make the smoke test a different browser from the one the hub starts),
 * it passes against a real Chromium, it fails when the page is missing or the browser dies, and the workflow, the
 * Dockerfile and the hub's build keep the pieces it needs in the image.
 */

const root = join(import.meta.dirname, '../..');
const script = join(import.meta.dirname, 'raster-canvas.mjs');
const source = readFileSync(script, 'utf8');

const exe = await findChromium({ system: true });
if (exe === undefined)
  console.warn('raster-canvas.test.ts: the browser run is SKIPPED, no Chromium found (design/23 "CI")');

let scratch = '';
let page = '';
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ordo-image-smoke-'));
  // The built page's one promise to the driver: `window.__raster` exists once its scripts have run.
  page = join(scratch, 'raster-page.js');
  writeFileSync(page, 'window.__raster = {};');
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH, SMOKE_DRAWS: '1', ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });

describe("the image smoke script is the hub's own browser", () => {
  it("starts Chromium with the picture driver's flags, and with the container's default /dev/shm", () => {
    const literal = /const FLAGS = (\[[\s\S]*?\n\]);/.exec(source)?.[1];
    expect(literal, 'the FLAGS list of the script').toBeDefined();
    const flags = new Function(`return ${literal}`)() as string[];
    expect(flags).toEqual(
      rasterArgs('PROFILE', {}).map((a) =>
        a.startsWith('--user-data-dir=') ? '--user-data-dir=PROFILE' : a,
      ),
    );
    expect(flags).not.toContain('--disable-dev-shm-usage');
  });
});

describe.skipIf(exe === undefined)('the image smoke script in a real Chromium', () => {
  it('draws the 4K pictures and exits 0', () => {
    const r = run({ ORDO_CHROMIUM: exe!, RASTER_PAGE: page, SMOKE_DRAWS: '2' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('the picture page started');
    expect(r.stdout).toMatch(/picture 2: 3840 x 2160, \d+ bytes/);
    expect(r.stdout).toContain('drew 2 pictures of 3840 x 2160');
  });

  it('fails, naming it, when the picture page is not in the image', () => {
    const r = run({ ORDO_CHROMIUM: exe!, RASTER_PAGE: join(scratch, 'nope.js') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not in the image');
  });

  it('fails when the picture page does not start', () => {
    const dead = join(scratch, 'dead-page.js');
    writeFileSync(dead, 'throw new Error("no page");');
    const r = run({ ORDO_CHROMIUM: exe!, RASTER_PAGE: dead, READY_MS: '1000' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the picture page did not start');
  });
});

describe('the image smoke script when the browser is gone', () => {
  it('fails when the browser exits instead of answering', () => {
    const r = run({ ORDO_CHROMIUM: '/bin/false', RASTER_PAGE: page });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/the browser exited/);
  });
});

describe('the pieces the smoke step needs are in the workflow and the image', () => {
  const read = (p: string) => readFileSync(join(root, p), 'utf8');

  it("docker-pr.yml copies the script into the running image and runs it with the image's browser", () => {
    const yml = read('.github/workflows/docker-pr.yml');
    expect(yml).toContain("The picture maker's browser draws a 4K picture inside the image");
    expect(yml).toContain('docker cp tools/image-smoke/raster-canvas.mjs ordo-smoke:/tmp/raster-canvas.mjs');
    expect(yml).toContain('docker exec ordo-smoke node /tmp/raster-canvas.mjs');
    expect(yml).toContain('test -s /app/apps/hub/dist/raster-page.js');
    // The step runs after the one that starts the image and keeps the owner's steps in place.
    expect(yml.indexOf('Start the image and wait for its health check')).toBeLessThan(
      yml.indexOf("The picture maker's browser draws a 4K picture inside the image"),
    );
    expect(yml).toContain("The packages' copyright notices are in the image");
  });

  it('the Dockerfile ships the hub dist, and the hub build puts the picture page there', () => {
    expect(read('Dockerfile')).toContain('/src/apps/hub/dist /app/apps/hub/dist');
    expect(read('apps/hub/build.mjs')).toContain("join(here, 'dist/raster-page.js')");
    // The smoke script's default is the path the hub finds the page at (next to the bundle).
    expect(source).toContain("'/app/apps/hub/dist/raster-page.js'");
  });
});

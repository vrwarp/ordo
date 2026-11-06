import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { png } from './png.ts';
import { pngSize, ssim } from './ssim.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'ordo-ssim-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A 192x108 picture: white, with a black square at (x, y). */
function page(name: string, x: number, y: number, w = 192): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    png(w, 108, (px, py) =>
      px >= x && px < x + 30 && py >= y && py < y + 30 ? [0, 0, 0, 255] : [255, 255, 255, 255],
    ),
  );
  return file;
}

describe('pngSize', () => {
  it('reads the size from the header', async () => {
    expect(await pngSize(page('size.png', 0, 0))).toEqual({ w: 192, h: 108 });
    const bad = join(dir, 'bad.png');
    writeFileSync(bad, 'not a png');
    expect(await pngSize(bad)).toBeUndefined();
  });
});

describe.skipIf(!hasFfmpeg)('ssim', () => {
  it('is 1 for the same picture and less for a moved square', async () => {
    const a = page('a.png', 20, 20);
    expect(await ssim(a, a)).toBeCloseTo(1, 6);
    const moved = await ssim(a, page('b.png', 120, 60));
    expect(moved).toBeLessThan(0.95);
  });

  it('scores only the region when given one, from both pictures at the same place', async () => {
    const a = page('c.png', 20, 20);
    const b = page('d.png', 120, 60);
    // The left half holds a's square and nothing of b's: different. The top right holds neither: the same.
    expect(await ssim(a, b, { x: 0, y: 0, w: 96, h: 108 })).toBeLessThan(0.95);
    expect(await ssim(a, b, { x: 100, y: 0, w: 92, h: 50 })).toBeCloseTo(1, 6);
    // A region off the picture is cut to it.
    expect(await ssim(a, b, { x: 150, y: -20, w: 500, h: 50 })).toBeCloseTo(1, 6);
  });

  it("cuts LibreOffice's extra column before scoring a whole page", async () => {
    const a = page('e.png', 20, 20, 193);
    const b = page('f.png', 20, 20);
    expect(await ssim(a, b)).toBeGreaterThan(0.99);
  });
});

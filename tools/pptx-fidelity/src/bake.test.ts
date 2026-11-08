import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bakePicture, bounded } from './bake.ts';
import { png } from './png.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'ordo-fid-bake-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The size and first pixel of a PNG, decoded by ffmpeg. */
function look(file: string): { w: number; h: number; px: number[] } {
  const b = readFileSync(file);
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const raw = spawnSync('ffmpeg', [
    '-loglevel',
    'error',
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ]);
  return { w, h, px: [...raw.stdout.subarray(0, 4)] };
}

describe.skipIf(!hasFfmpeg)('baked pictures in the native column', () => {
  const src = join(dir, 'red.png');
  writeFileSync(
    src,
    png(32, 16, () => [255, 0, 0, 255]),
  );

  it('recolours a picture at its own size', async () => {
    const out = join(dir, 'gray.png');
    await bakePicture(src, 'png', { w: 32, h: 16 }, { recolor: [{ kind: 'grayscale' }] }, undefined, out);
    expect(look(out)).toEqual({ w: 32, h: 16, px: [75, 75, 75, 255] });
  });

  it('tiles a fill over its box at 3840 px density', async () => {
    const out = join(dir, 'tile.png');
    const tile = { aspect: 0.5, w: 0.1, h: 0.2, x: 0, y: 0, flip: 'none' as const };
    await bakePicture(src, 'png', { w: 32, h: 16 }, { tile }, { w: 500, h: 0 }, out);
    expect(look(out)).toMatchObject({ w: 1000, h: 500, px: [255, 0, 0, 255] });
  });

  it('keeps sizes within the bake limits', () => {
    expect(bounded(20_000, 100).width).toBe(8_192);
    const b = bounded(8_000, 8_000);
    expect(b.width * b.height).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});

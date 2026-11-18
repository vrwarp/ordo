/**
 * Run by `tempdirs.test.ts` in a child vitest with a TMPDIR of its own: a test file as the hub's are written,
 * folders made at its top level and inside its tests, and a hub started without a cleanup of its own. Once the
 * run ends, nothing of them may be left in TMPDIR.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startHub, tempDir } from '../helpers.ts';

const fx = tempDir('ordo-fx-');

describe('a test file that leaves its folders to the helpers', () => {
  it('makes folders and a hub, and cleans none of them up itself', async () => {
    writeFileSync(join(fx, 'a.txt'), 'a');
    const inside = tempDir('ordo-photo-');
    writeFileSync(join(inside, 'b.txt'), 'b');
    const hub = await startHub();
    expect(existsSync(hub.dir)).toBe(true);
  });
});

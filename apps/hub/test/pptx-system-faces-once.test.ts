/**
 * Rule H's start-up check (`src/pptx/systemFaces.ts` `SystemFaces`) reads and parses each distinct face once, however
 * many scripts fontconfig names it for (on a computer with one CJK face, all four: a 17 MB collection read once, not
 * four times in parallel on the starting process).
 */
import { writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { sfntFont } from '@ordo/pptx-scene/test-util.ts';
import { describe, expect, it, vi } from 'vitest';
import { type SystemFaceLookup, SystemFaces } from '../src/pptx/systemFaces.ts';
import { tempDir } from './helpers.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, readFile: vi.fn(real.readFile) };
});

describe('SystemFaces reads each face once', () => {
  it('reads a face fontconfig names for four scripts once', async () => {
    const dir = tempDir('ordo-sysfaces-once-');
    const cjk = join(dir, 'cjk.ttf');
    writeFileSync(
      cjk,
      sfntFont(
        Object.fromEntries(
          [
            ...'一人大日中上下天山水火木あいうえおかきくのをんすアイウエオカキクンストー가나다라마바사아자하한글',
          ].map((c) => [c, 1000]),
        ),
      ),
    );
    const lookup: SystemFaceLookup = async () => ({ file: cjk, index: 0 });
    const read = vi.mocked(fsp.readFile);
    read.mockClear();
    const faces = await new SystemFaces(lookup, { info: () => undefined, warn: () => undefined }).ready;
    expect(faces.map(([s]) => s)).toEqual(['Hani', 'Hira', 'Kana', 'Hang']);
    expect(read.mock.calls.filter(([f]) => f === cjk)).toHaveLength(1);
  });
});

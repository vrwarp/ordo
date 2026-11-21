import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The packed tokenizer reads the commands of an `a:path` as two typed arrays and leaves its `children` empty (design/29 X1):
 * a reader that walked the children would see nothing and draw nothing. The only readers are `pathCommands` and, through it,
 * `geom.ts` and `walk.ts`; this test fails for any other source of the package that names a path's commands or reads a path
 * list (the gradient `a:path` of color.ts is another element and is not a path list).
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const ALLOWED = new Set(['xml.ts', 'geom.ts', 'walk.ts']);
const NAMES = ['a:pt', 'a:lnTo', 'a:moveTo', 'a:cubicBezTo', 'a:quadBezTo', 'a:arcTo', 'a:pathLst'];

/** The source files of `dir` (not tests, not test utilities) outside the allowed three that name a path command. */
function pathReaders(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.ts') || /\.test(-util)?\.ts$/.test(name) || name === 'test-util.ts') continue;
    if (ALLOWED.has(name)) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    const hit = NAMES.filter((n) => new RegExp(`${n}(?![A-Za-z])`).test(text));
    if (hit.length) out.push(`${name}: ${hit.join(', ')}`);
  }
  return out;
}

describe('no reader of a path outside xml.ts, geom.ts and walk.ts', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('holds for the package’s sources', () => {
    expect(pathReaders(SRC)).toEqual([]);
  });

  it('fails for a file that names a command, in a temporary copy of the sources', () => {
    const copy = mkdtempSync(join(tmpdir(), 'ordo-xml-guard-'));
    made.push(copy);
    for (const name of ['color.ts', 'markup.ts', 'rendercopy.ts'])
      writeFileSync(join(copy, name), readFileSync(join(SRC, name)));
    expect(pathReaders(copy)).toEqual([]);
    writeFileSync(
      join(copy, 'reader.ts'),
      "export const n = (p: { children: { name: string }[] }) => p.children.filter((c) => c.name === 'a:lnTo');\n",
    );
    expect(pathReaders(copy)).toEqual(['reader.ts: a:lnTo']);
  });
});

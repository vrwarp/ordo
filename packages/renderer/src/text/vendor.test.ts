import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/*
 * linebreak and bidi-js (and the stages that use them) bundle for the browser: esbuild packs them with
 * platform 'browser', and the bundle runs in a bare JavaScript realm (no require, process, Buffer or fs),
 * as in the asset worker, the thumbnail worker and the editor.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');

type Esbuild = {
  build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

/** esbuild is not a dependency of this package; vite (apps/output) depends on it (as golden/run.ts does). */
async function loadEsbuild(): Promise<Esbuild> {
  const fromOutput = createRequire(join(root, 'apps/output/package.json'));
  const esbuildPath = createRequire(fromOutput.resolve('vite')).resolve('esbuild');
  return (await import(esbuildPath)) as Esbuild;
}

async function bundle(contents: string): Promise<string> {
  const esbuild = await loadEsbuild();
  const out = await esbuild.build({
    stdin: { contents, resolveDir: here, loader: 'ts', sourcefile: 'entry.ts' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    logLevel: 'silent',
  });
  return out.outputFiles[0]!.text;
}

/** Runs `code` in a fresh realm with only the language built-ins and returns its `globalThis.result`. */
function run(code: string): unknown {
  const sandbox: { result?: unknown } = {};
  vm.runInNewContext(code, sandbox, { timeout: 10_000 });
  return sandbox.result;
}

describe('browser bundle', () => {
  it('packs linebreak and bidi-js and runs them without Node', async () => {
    const code = await bundle(`
      import LineBreaker from 'linebreak';
      import bidiFactory from 'bidi-js';
      const lb = new LineBreaker('Gloire à Dieu\\u{00A0}! 主啊、我信');
      const breaks = [];
      for (let b = lb.nextBreak(); b; b = lb.nextBreak()) breaks.push(b.position);
      const levels = Array.from(bidiFactory().getEmbeddingLevels('abc שלום', 'ltr').levels);
      globalThis.result = { breaks, levels };
    `);
    expect(code).not.toMatch(/\brequire\(["']fs["']\)/);
    expect(run(code)).toEqual({ breaks: [7, 9, 16, 17, 19, 20, 21], levels: [0, 0, 0, 0, 1, 1, 1, 1] });
  });

  it('packs the stages that use them', async () => {
    const code = await bundle(`
      import { breakOpportunities } from './breaks.ts';
      import { bidiParagraph } from './bidi.ts';
      import { segText } from './segments.ts';
      const t = 'สวัสดีครับ שלום';
      globalThis.result = {
        breaks: breakOpportunities(t, 0, t.length, 'th'),
        level: bidiParagraph(t, 11, 15, 'auto').level,
        joined: segText('مرحبا', 0, 3, 'none').length,
      };
    `);
    expect(run(code)).toEqual({ breaks: [6, 11], level: 1, joined: 4 });
  });
});

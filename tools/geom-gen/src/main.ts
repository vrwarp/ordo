import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate, generateTextWarps } from './gen.ts';

/*
 * pnpm --filter @ordo/geom-gen gen          writes packages/renderer/src/geom/presets.gen.ts and textwarps.gen.ts
 * pnpm --filter @ordo/geom-gen gen --check  exits 1 when either committed file is not the generator's output
 */

export const XML_PATH = fileURLToPath(
  new URL('../../../third_party/poi-presets/presetShapeDefinitions.xml', import.meta.url),
);
export const OUT_PATH = fileURLToPath(
  new URL('../../../packages/renderer/src/geom/presets.gen.ts', import.meta.url),
);
export const TEXTWARPS_XML_PATH = fileURLToPath(
  new URL('../../../third_party/ooxml-textwarps/presetTextWarpDefinitions.xml', import.meta.url),
);
export const TEXTWARPS_OUT_PATH = fileURLToPath(
  new URL('../../../packages/renderer/src/geom/textwarps.gen.ts', import.meta.url),
);

const outputs = [
  { name: 'presets.gen.ts', path: OUT_PATH, out: generate(readFileSync(XML_PATH, 'utf8')) },
  {
    name: 'textwarps.gen.ts',
    path: TEXTWARPS_OUT_PATH,
    out: generateTextWarps(readFileSync(TEXTWARPS_XML_PATH, 'utf8')),
  },
];

if (process.argv.includes('--check')) {
  let stale = false;
  for (const { name, path, out } of outputs) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {}
    if (current !== out) {
      console.error(`${path} is not the generator's output: run pnpm --filter @ordo/geom-gen gen`);
      stale = true;
    } else console.log(`${name} is up to date`);
  }
  if (stale) process.exit(1);
} else {
  for (const { path, out } of outputs) {
    writeFileSync(path, out);
    console.log(`wrote ${path} (${out.length} bytes)`);
  }
}

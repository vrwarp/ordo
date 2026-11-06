import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from './gen.ts';

/*
 * pnpm --filter @ordo/geom-gen gen          writes packages/renderer/src/geom/presets.gen.ts
 * pnpm --filter @ordo/geom-gen gen --check  exits 1 when the committed file is not the generator's output
 */

export const XML_PATH = fileURLToPath(
  new URL('../../../third_party/poi-presets/presetShapeDefinitions.xml', import.meta.url),
);
export const OUT_PATH = fileURLToPath(
  new URL('../../../packages/renderer/src/geom/presets.gen.ts', import.meta.url),
);

const out = generate(readFileSync(XML_PATH, 'utf8'));
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT_PATH, 'utf8');
  } catch {}
  if (current !== out) {
    console.error(`${OUT_PATH} is not the generator's output: run pnpm --filter @ordo/geom-gen gen`);
    process.exit(1);
  }
  console.log('presets.gen.ts is up to date');
} else {
  writeFileSync(OUT_PATH, out);
  console.log(`wrote ${OUT_PATH} (${out.length} bytes)`);
}

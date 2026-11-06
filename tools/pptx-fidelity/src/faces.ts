/**
 * The converter's font faces in the harness (`ParseOptions.fontFace`, design/27 §15 M6 tables): the face
 * file fontconfig gives each family, as the page registers it to draw the slides (`fonts.ts`), so a table row
 * grows exactly as far as the text drawn there needs. The whole file is read (`sfntMetrics`), so the measure
 * has the face's pair kerning (`GPOS`, else `kern`) and the vertical metrics LibreOffice's row rule uses
 * (`FaceMetrics.ascent`, `descent`; the probe deck, `table-probe.ts`, was measured with these files).
 * Synchronous (the converter is): `fc-match` runs once per family, weight and slant and the file is read
 * once per path, both memoised for the worker's life.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { type FaceMetrics, type FaceSource, sfntMetrics } from '@ordo/pptx-scene';

/** Font files read at most (a CJK collection is about 20 MB). */
const MAX_FONT_BYTES = 64 * 1024 * 1024;

const matches = new Map<string, { file: string; index: number } | undefined>();
const files = new Map<string, FaceMetrics | undefined>();

/** A family as one fontconfig pattern element: `-`, `:`, `,` and `\` escaped (as `fonts.ts` `fcFamily`). */
const fcFamily = (family: string) => family.replace(/[\\\-:,]/g, (c) => `\\${c}`);

function fcMatch(pattern: string): { file: string; index: number } | undefined {
  if (matches.has(pattern)) return matches.get(pattern);
  let got: { file: string; index: number } | undefined;
  try {
    const r = spawnSync('fc-match', ['-f', '%{file}\t%{index}', pattern], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const [file, index] = (r.stdout ?? '').split('\t');
    if (r.status === 0 && file) got = { file, index: Number(index) || 0 };
  } catch {
    got = undefined; // no fontconfig: widths are estimated
  }
  matches.set(pattern, got);
  return got;
}

/** fontconfig's face for each family (bold and italic as asked), read with `sfntMetrics`. */
export const hostFace: FaceSource = (family, bold, italic) => {
  const name = family.trim();
  if (!name || name.length > 300) return undefined;
  const m = fcMatch(`${fcFamily(name)}${bold ? ':bold' : ''}${italic ? ':italic' : ''}`);
  if (!m) return undefined;
  const key = `${m.file}#${m.index}`;
  if (files.has(key)) return files.get(key);
  let v: FaceMetrics | undefined;
  try {
    if (statSync(m.file).size <= MAX_FONT_BYTES) v = sfntMetrics(readFileSync(m.file), m.index);
  } catch {
    v = undefined;
  }
  files.set(key, v);
  return v;
};

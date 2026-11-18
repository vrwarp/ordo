/**
 * The converter's font faces in the harness (`ParseOptions.fontFace`, design/27 §15 M6 tables): the face
 * file fontconfig gives each family, as the page registers it to draw the slides (`fonts.ts`), so a table row
 * grows exactly as far as the text drawn there needs. The whole file is read (`sfntMetrics`), so the measure
 * has the face's pair kerning (`GPOS`, else `kern`) and the vertical metrics LibreOffice's row rule uses
 * (`FaceMetrics.ascent`, `descent`; the probe deck, `table-probe.ts`, was measured with these files).
 * Synchronous (the converter is): `fc-match` runs once per family, weight and slant and the file is read
 * once per path, both memoised for the worker's life.
 *
 * A script's face (`FaceSource.script`, M9 tables-conv): the face fontconfig gives for a character of the
 * script (`fc-match :charset=<hex>`, `SCRIPT_SAMPLES`), as Chromium falls back per glyph on this host (for
 * Hangul: WenQuanYi Zen Hei where Noto Sans KR is not installed), so a cell whose family lacks its script is
 * spaced by the face the page draws it in.
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

/** The face file fontconfig matched, read with `sfntMetrics` once per path. */
function faceAt(m: { file: string; index: number } | undefined): FaceMetrics | undefined {
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
}

/**
 * A letter of each fallback script (`@ordo/domain` `FALLBACK_SCRIPTS`, ISO 15924), for fontconfig's charset
 * match (`faces.test.ts` checks every script has one of its own).
 */
export const SCRIPT_SAMPLES: Readonly<Record<string, number>> = {
  Hebr: 0x05d0,
  Arab: 0x0627,
  Syrc: 0x0710,
  Thaa: 0x0780,
  Nkoo: 0x07ca,
  Deva: 0x0905,
  Beng: 0x0985,
  Guru: 0x0a05,
  Gujr: 0x0a85,
  Orya: 0x0b05,
  Taml: 0x0b85,
  Telu: 0x0c05,
  Knda: 0x0c85,
  Mlym: 0x0d05,
  Sinh: 0x0d85,
  Thai: 0x0e01,
  Laoo: 0x0e81,
  Mymr: 0x1000,
  Khmr: 0x1780,
  Tibt: 0x0f40,
  Ethi: 0x1200,
  Armn: 0x0531,
  Geor: 0x10d0,
  Grek: 0x03b1,
  Cyrl: 0x0430,
  Hani: 0x4e00,
  Hira: 0x3042,
  Kana: 0x30a2,
  Hang: 0xac00,
};

/** The fontconfig pattern that asks for a script's face (`:charset=<hex>` of its sample), or undefined. */
export function scriptPattern(code: string): string | undefined {
  const cp = Object.hasOwn(SCRIPT_SAMPLES, code) ? SCRIPT_SAMPLES[code] : undefined;
  return cp === undefined ? undefined : `:charset=${cp.toString(16)}`;
}

/** fontconfig's face for each family (bold and italic as asked), read with `sfntMetrics`; and for a script. */
export const hostFace: FaceSource = (family, bold, italic) => {
  const name = family.trim();
  if (!name || name.length > 300) return undefined;
  return faceAt(fcMatch(`${fcFamily(name)}${bold ? ':bold' : ''}${italic ? ':italic' : ''}`));
};
hostFace.script = (code) => {
  const pattern = scriptPattern(code);
  return pattern ? faceAt(fcMatch(pattern)) : undefined;
};

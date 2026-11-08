import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxFont } from './blankface.ts';
import { MISSING, PROBE_FAMILIES } from './coverage.fonts.page.test-util.ts';

/**
 * The fontconfig environments of coverage.fonts.browser.test.ts (node side): the computer's fonts without
 * any face for the test's characters (bare), and the same with generated CJK and Thai faces that the generic
 * families and the system fallback resolve to (cjk-thai). Written under a directory of the test's own and
 * passed to Chromium as FONTCONFIG_FILE: nothing is installed on the computer.
 */

/** The computer's fontconfig, which both environments start from. */
export const SYSTEM_CONF = '/etc/fonts/fonts.conf';

/** Every character the environments take away from the computer's fonts (the generated faces have them). */
const CODE_POINTS = [...new Set([...MISSING].map((c) => c.codePointAt(0)!))].sort((a, b) => a - b);
const hex = (cp: number) => `0x${cp.toString(16)}`;

/** A generated face: a box of its own for each character, so two faces never measure alike. */
function probeFace(family: string, advance: number, k: number): Uint8Array {
  return boxFont({
    family,
    glyphs: [
      { advance: 500, box: [50, 0, 450, 700] },
      ...CODE_POINTS.map((_, i) => ({
        advance,
        box: [40 + 10 * k + 5 * i, -120 + 20 * k, advance - 40 - 5 * i, 780 - 30 * k - 10 * i] as const,
      })),
    ],
    ranges: CODE_POINTS.map((cp, i) => [cp, cp, i + 1] as const),
  });
}

/**
 * Faces covering any of the characters are left out; the generated ones (`keep`) are always in, by file and
 * by family (fontconfig checks files and patterns apart: a file accepted is still refused by a pattern).
 */
function selection(keep?: string): string {
  const reject = CODE_POINTS.map(
    (cp) => `<pattern><patelt name="charset"><charset><int>${hex(cp)}</int></charset></patelt></pattern>`,
  ).join('\n      ');
  const families = PROBE_FAMILIES.map(
    (f) => `<pattern><patelt name="family"><string>${f}</string></patelt></pattern>`,
  );
  const accept = keep ? `\n    <acceptfont><glob>${keep}/*</glob>${families.join('')}</acceptfont>` : '';
  return `<selectfont>${accept}
    <rejectfont>
      ${reject}
    </rejectfont>
  </selectfont>`;
}

/** A generic family whose stack resolves to `face` first (before the system's rules, which prefer theirs). */
const generic = (family: string, face: string) =>
  `<match target="pattern"><test qual="first" name="family"><string>${family}</string></test><edit name="family" mode="prepend_first" binding="strong"><string>${face}</string></edit></match>`;

/** The system fallback for one character (its pattern holds only that character): `face` first. */
const fallback = (cp: number, face: string) =>
  `<match target="pattern"><test name="charset" compare="contains"><charset><int>${hex(cp)}</int></charset></test><edit name="family" mode="prepend_first" binding="strong"><string>${face}</string></edit></match>`;

/** The generated faces' advances (font units, 1000 per em): 中 measures a tenth of it at 100 px. */
export const ADVANCES = [1000, 920, 600];

/** The two environments' fontconfig files, written under `dir`. */
export function fontEnvironments(dir: string): { name: string; conf: string }[] {
  const fonts = join(dir, 'fonts');
  mkdirSync(fonts, { recursive: true });
  PROBE_FAMILIES.forEach((family, k) => {
    writeFileSync(join(fonts, `${family.replace(/ /g, '')}.ttf`), probeFace(family, ADVANCES[k]!, k));
  });
  // The serif's bold face has Latin capitals only, as where a CJK serif comes in one weight: bold text in
  // the serif falls back, and Chromium's answer depends on the stack's first family (measured with Chromium
  // 153: `700 100px serif` draws an empty box of 0.78 em for 中, a shipped face before `serif` a generated
  // face's glyph), as other systems' fallbacks do in general.
  writeFileSync(
    join(fonts, 'OrdoProbeSerif-Bold.ttf'),
    boxFont({
      family: PROBE_FAMILIES[0]!,
      weight: 700,
      glyphs: [
        { advance: 500, box: [50, 0, 450, 700] },
        { advance: 700, box: [60, 0, 640, 700] },
      ],
      ranges: [[0x41, 0x5a, 1]],
    }),
  );
  const head = (cache: string) =>
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n  <cachedir>${join(dir, cache)}</cachedir>`;
  const bare = `${head('cache-bare')}
  <include ignore_missing="no">${SYSTEM_CONF}</include>
  ${selection()}
</fontconfig>
`;
  const [serif, sans, mono] = PROBE_FAMILIES as [string, string, string];
  const cjk = `${head('cache-cjk')}
  ${generic('serif', serif)}
  ${generic('sans-serif', sans)}
  ${generic('monospace', mono)}
  <include ignore_missing="no">${SYSTEM_CONF}</include>
  <dir>${fonts}</dir>
  ${CODE_POINTS.map((cp) => fallback(cp, sans)).join('\n  ')}
  ${selection(fonts)}
</fontconfig>
`;
  writeFileSync(join(dir, 'bare.conf'), bare);
  writeFileSync(join(dir, 'cjk-thai.conf'), cjk);
  return [
    { name: 'bare', conf: join(dir, 'bare.conf') },
    { name: 'cjk-thai', conf: join(dir, 'cjk-thai.conf') },
  ];
}

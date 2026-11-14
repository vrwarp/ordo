/*
 * The baseline-0 probe (design/27 §4 "Baseline 0", `--lo-compat` rule `escZero`): one text box per slide, two
 * lines of 60 pt Liberation Sans 'HHHH' with no insets, its runs' `baseline` set (or not) on the run, in the
 * shape's list style, and in the presentation's `defaultTextStyle`. LibreOffice's drawing of the four decks
 * (`LO_ESC_ZERO`, LibreOffice 24.2.7, 96 dpi pages) shows that it reads `baseline="0"` as unset at every level
 * of the chain: with no other baseline the run is drawn in place at full size, as PowerPoint draws it; under a
 * non-zero one (a presentation default of -25000) it is drawn shifted by that one at 58 % of its size, where
 * PowerPoint draws it in place at full size. A shift of 1 (1/100,000) is honoured: 58 % on the line's
 * baseline. The converter marks such runs `RunStyle.escZero`, and `EmitOptions.loCompat` writes the shift.
 *
 * `npx tsx src/esczero-probe.ts <dir>` writes the decks. To measure them again: `soffice --headless
 * --convert-to pdf`, `pdftoppm -r 96 -png`, and per page the rows of dark ink: the two lines' cap height and
 * their pitch. LibreOffice 7.4 (the Docker image's) has not been probed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { body, buildDeck, para, run, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { zipStore } from './table-probe.ts';

const IN = 914_400;
/** The probe's size: 60 pt is 80 px on a 96 dpi page. */
export const PROBE_PT = 60;

/** One probe slide: the runs' own `baseline` attributes, the shape's list style's and the deck default's. */
export interface EscCase {
  readonly name: string;
  readonly run?: string;
  readonly list?: string;
  readonly deflt?: string;
}

/** The four decks, by the default they set (a deck's default applies to all its slides). */
export const ESC_DECKS: readonly { readonly file: string; readonly cases: readonly EscCase[] }[] = [
  {
    file: 'esc-a.pptx',
    cases: [
      { name: 'none' },
      { name: 'run 0', run: '0' },
      { name: 'list 0', list: '0' },
      { name: 'run +30000', run: '30000' },
    ],
  },
  {
    file: 'esc-b.pptx',
    cases: [
      { name: 'run 0 under default -25000', run: '0', deflt: '-25000' },
      { name: 'default -25000', deflt: '-25000' },
      { name: 'list 0 under default -25000', list: '0', deflt: '-25000' },
    ],
  },
  {
    file: 'esc-c.pptx',
    cases: [
      { name: 'run 0 under list -25000', run: '0', list: '-25000' },
      { name: 'list -25000', list: '-25000' },
      { name: 'run 1 under list -25000', run: '1', list: '-25000' },
    ],
  },
  {
    file: 'esc-d.pptx',
    cases: [
      { name: 'run 0 under default +30000', run: '0', deflt: '30000' },
      { name: 'default +30000', deflt: '30000' },
      { name: 'run -1 under default +30000', run: '-1', deflt: '30000' },
    ],
  },
];

/**
 * LibreOffice 24.2.7's drawing of each case (`ESC_DECKS` order): the size it draws the run at (1 or 0.58) and
 * how far up its glyphs sit from where an unshifted line's are, in px at 96 dpi (80 px a font size). An
 * unshifted full-size line: cap height 55 px, pitch 96 px; a lowered one grows the line (pitch 110 px).
 */
export const LO_ESC_ZERO: readonly { readonly scale: number; readonly upPx: number }[] = [
  { scale: 1, upPx: 0 },
  { scale: 1, upPx: 0 },
  { scale: 1, upPx: 0 },
  { scale: 0.58, upPx: 24 },
  { scale: 0.58, upPx: -20 },
  { scale: 0.58, upPx: -20 },
  { scale: 0.58, upPx: -20 },
  { scale: 0.58, upPx: -20 },
  { scale: 0.58, upPx: -20 },
  { scale: 0.58, upPx: 0 },
  { scale: 0.58, upPx: 24 },
  { scale: 0.58, upPx: 24 },
  { scale: 0.58, upPx: 0 },
];

/** A probe deck's parts. */
export function escDeck(cases: readonly EscCase[]): Map<string, Uint8Array> {
  const attr = (v: string | undefined) => (v === undefined ? '' : ` baseline="${v}"`);
  const deflt = cases[0]?.deflt;
  const rPr = (c: EscCase) => `sz="${PROBE_PT * 100}"${attr(c.run)}`;
  const kids = `${solid('000000')}<a:latin typeface="Liberation Sans"/>`;
  return buildDeck({
    ...(deflt === undefined
      ? {}
      : {
          defaultTextStyle: `<a:defPPr><a:defRPr${attr(deflt)}/></a:defPPr><a:lvl1pPr><a:defRPr${attr(deflt)}/></a:lvl1pPr>`,
        }),
    slides: cases.map((c) => ({
      shapes: sp({
        id: 2,
        x: IN,
        y: IN,
        cx: 8 * IN,
        cy: 4 * IN,
        txBox: true,
        txBody: body(
          para(run('HHHH', rPr(c), kids)) + para(run('HHHH', rPr(c), kids)),
          'wrap="none" lIns="0" tIns="0" rIns="0" bIns="0"',
          c.list === undefined ? '' : `<a:lvl1pPr><a:defRPr${attr(c.list)}/></a:lvl1pPr>`,
        ),
      }),
    })),
  });
}

/** A deck's bytes: its parts stored, dated 1980-01-01. */
export function escDeckBytes(cases: readonly EscCase[]): Uint8Array {
  return zipStore([...escDeck(cases)].sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: esczero-probe.ts <dir>');
  mkdirSync(dir, { recursive: true });
  for (const d of ESC_DECKS) writeFileSync(join(dir, d.file), escDeckBytes(d.cases));
}

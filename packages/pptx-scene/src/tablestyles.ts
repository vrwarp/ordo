/*
 * This file is part of ordo. It is a port of a file of the LibreOffice project.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Ported from LibreOffice core, oox/source/drawingml/table/predefined-table-styles.cxx (revision
 * 9a5457bb95489987b50f2196922a0e6e72032bbb, 2026-11-06), which is subject to the same licence. This file
 * stays under the MPL 2.0 and on its own: it is the only code of ordo that comes from it.
 */

/**
 * PowerPoint's built-in table styles, for decks whose tables name a style by id (`a:tableStyleId`) that
 * `ppt/tableStyles.xml` does not define (LibreOffice tdf#107604; design/27 §15 M6 tables).
 *
 * The 74 styles are the groups Themed-Style-1/2, Light-Style-1/2/3, Medium-Style-1/2/3/4 and Dark-Style-1/2,
 * each plain and with each accent colour, by the ids Microsoft lists. `predefinedTableStyle(id)` returns the
 * style as the `a:tblStyle` element PowerPoint would have written into `ppt/tableStyles.xml`, so `tables.ts`
 * reads a built-in style and a deck's own with the same code: parts (`a:wholeTbl`, `a:firstRow`, ...) with
 * their text (`a:tcTxStyle`: bold, colour) and cell style (`a:tcStyle`: `a:tcBdr` lines and `a:fill`), and
 * the table background (`a:tblBg`). Colours are scheme colours with LibreOffice's modifiers (alpha, tint,
 * shade), resolved later through the slide's colour map.
 *
 * Changes from LibreOffice's table, both where its values differ from PowerPoint's own definitions of the
 * same styles (as PowerPoint writes them into decks):
 * - every border line is 1 pt (`w="12700"`). LibreOffice sets the width only on the whole table's six lines
 *   and the first row's bottom line; the others it leaves at 0, which draws no line (Light Style 2's band
 *   rows, for instance, lose their rules);
 * - the first row, last row, first column and last column are bold in every style but the two "No Style"
 *   ones (Themed-Style-1 and Themed-Style-2 without an accent), as PowerPoint writes them. LibreOffice makes
 *   them bold in Light-Style-1 only.
 */
import type { XNode } from './xml.ts';

/** A style id → [style group, accent ('' for none)]: LibreOffice's `mStyleIdMap`. */
const STYLE_IDS: ReadonlyMap<string, readonly [string, string]> = new Map<string, readonly [string, string]>([
  ['{2D5ABB26-0587-4C30-8999-92F81FD0307C}', ['Themed-Style-1', '']],
  ['{3C2FFA5D-87B4-456A-9821-1D502468CF0F}', ['Themed-Style-1', 'Accent1']],
  ['{284E427A-3D55-4303-BF80-6455036E1DE7}', ['Themed-Style-1', 'Accent2']],
  ['{69C7853C-536D-4A76-A0AE-DD22124D55A5}', ['Themed-Style-1', 'Accent3']],
  ['{775DCB02-9BB8-47FD-8907-85C794F793BA}', ['Themed-Style-1', 'Accent4']],
  ['{35758FB7-9AC5-4552-8A53-C91805E547FA}', ['Themed-Style-1', 'Accent5']],
  ['{08FB837D-C827-4EFA-A057-4D05807E0F7C}', ['Themed-Style-1', 'Accent6']],

  ['{5940675A-B579-460E-94D1-54222C63F5DA}', ['Themed-Style-2', '']],
  ['{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}', ['Themed-Style-2', 'Accent1']],
  ['{18603FDC-E32A-4AB5-989C-0864C3EAD2B8}', ['Themed-Style-2', 'Accent2']],
  ['{306799F8-075E-4A3A-A7F6-7FBC6576F1A4}', ['Themed-Style-2', 'Accent3']],
  ['{E269D01E-BC32-4049-B463-5C60D7B0CCD2}', ['Themed-Style-2', 'Accent4']],
  ['{327F97BB-C833-4FB7-BDE5-3F7075034690}', ['Themed-Style-2', 'Accent5']],
  ['{638B1855-1B75-4FBE-930C-398BA8C253C6}', ['Themed-Style-2', 'Accent6']],

  ['{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}', ['Light-Style-1', '']],
  ['{3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5}', ['Light-Style-1', 'Accent1']],
  ['{0E3FDE45-AF77-4B5C-9715-49D594BDF05E}', ['Light-Style-1', 'Accent2']],
  ['{C083E6E3-FA7D-4D7B-A595-EF9225AFEA82}', ['Light-Style-1', 'Accent3']],
  ['{D27102A9-8310-4765-A935-A1911B00CA55}', ['Light-Style-1', 'Accent4']],
  ['{5FD0F851-EC5A-4D38-B0AD-8093EC10F338}', ['Light-Style-1', 'Accent5']],
  ['{68D230F3-CF80-4859-8CE7-A43EE81993B5}', ['Light-Style-1', 'Accent6']],

  ['{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}', ['Light-Style-2', '']],
  ['{69012ECD-51FC-41F1-AA8D-1B2483CD663E}', ['Light-Style-2', 'Accent1']],
  ['{72833802-FEF1-4C79-8D5D-14CF1EAF98D9}', ['Light-Style-2', 'Accent2']],
  ['{F2DE63D5-997A-4646-A377-4702673A728D}', ['Light-Style-2', 'Accent3']],
  ['{17292A2E-F333-43FB-9621-5CBBE7FDCDCB}', ['Light-Style-2', 'Accent4']],
  ['{5A111915-BE36-4E01-A7E5-04B1672EAD32}', ['Light-Style-2', 'Accent5']],
  ['{912C8C85-51F0-491E-9774-3900AFEF0FD7}', ['Light-Style-2', 'Accent6']],

  ['{616DA210-FB5B-4158-B5E0-FEB733F419BA}', ['Light-Style-3', '']],
  ['{BC89EF96-8CEA-46FF-86C4-4CE0E7609802}', ['Light-Style-3', 'Accent1']],
  ['{5DA37D80-6434-44D0-A028-1B22A696006F}', ['Light-Style-3', 'Accent2']],
  ['{8799B23B-EC83-4686-B30A-512413B5E67A}', ['Light-Style-3', 'Accent3']],
  ['{ED083AE6-46FA-4A59-8FB0-9F97EB10719F}', ['Light-Style-3', 'Accent4']],
  ['{BDBED569-4797-4DF1-A0F4-6AAB3CD982D8}', ['Light-Style-3', 'Accent5']],
  ['{E8B1032C-EA38-4F05-BA0D-38AFFFC7BED3}', ['Light-Style-3', 'Accent6']],

  ['{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}', ['Medium-Style-1', '']],
  ['{B301B821-A1FF-4177-AEE7-76D212191A09}', ['Medium-Style-1', 'Accent1']],
  ['{9DCAF9ED-07DC-4A11-8D7F-57B35C25682E}', ['Medium-Style-1', 'Accent2']],
  ['{1FECB4D8-DB02-4DC6-A0A2-4F2EBAE1DC90}', ['Medium-Style-1', 'Accent3']],
  ['{1E171933-4619-4E11-9A3F-F7608DF75F80}', ['Medium-Style-1', 'Accent4']],
  ['{FABFCF23-3B69-468F-B69F-88F6DE6A72F2}', ['Medium-Style-1', 'Accent5']],
  ['{10A1B5D5-9B99-4C35-A422-299274C87663}', ['Medium-Style-1', 'Accent6']],

  ['{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}', ['Medium-Style-2', '']],
  ['{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}', ['Medium-Style-2', 'Accent1']],
  ['{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}', ['Medium-Style-2', 'Accent2']],
  ['{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}', ['Medium-Style-2', 'Accent3']],
  ['{00A15C55-8517-42AA-B614-E9B94910E393}', ['Medium-Style-2', 'Accent4']],
  ['{7DF18680-E054-41AD-8BC1-D1AEF772440D}', ['Medium-Style-2', 'Accent5']],
  ['{93296810-A885-4BE3-A3E7-6D5BEEA58F35}', ['Medium-Style-2', 'Accent6']],

  ['{8EC20E35-A176-4012-BC5E-935CFFF8708E}', ['Medium-Style-3', '']],
  ['{6E25E649-3F16-4E02-A733-19D2CDBF48F0}', ['Medium-Style-3', 'Accent1']],
  ['{85BE263C-DBD7-4A20-BB59-AAB30ACAA65A}', ['Medium-Style-3', 'Accent2']],
  ['{EB344D84-9AFB-497E-A393-DC336BA19D2E}', ['Medium-Style-3', 'Accent3']],
  ['{EB9631B5-78F2-41C9-869B-9F39066F8104}', ['Medium-Style-3', 'Accent4']],
  ['{74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6}', ['Medium-Style-3', 'Accent5']],
  ['{2A488322-F2BA-4B5B-9748-0D474271808F}', ['Medium-Style-3', 'Accent6']],

  ['{D7AC3CCA-C797-4891-BE02-D94E43425B78}', ['Medium-Style-4', '']],
  ['{69CF1AB2-1976-4502-BF36-3FF5EA218861}', ['Medium-Style-4', 'Accent1']],
  ['{8A107856-5554-42FB-B03E-39F5DBC370BA}', ['Medium-Style-4', 'Accent2']],
  ['{0505E3EF-67EA-436B-97B2-0124C06EBD24}', ['Medium-Style-4', 'Accent3']],
  ['{C4B1156A-380E-4F78-BDF5-A606A8083BF9}', ['Medium-Style-4', 'Accent4']],
  ['{22838BEF-8BB2-4498-84A7-C5851F593DF1}', ['Medium-Style-4', 'Accent5']],
  ['{16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4}', ['Medium-Style-4', 'Accent6']],

  ['{E8034E78-7F5D-4C2E-B375-FC64B27BC917}', ['Dark-Style-1', '']],
  ['{125E5076-3810-47DD-B79F-674D7AD40C01}', ['Dark-Style-1', 'Accent1']],
  ['{37CE84F3-28C3-443E-9E96-99CF82512B78}', ['Dark-Style-1', 'Accent2']],
  ['{D03447BB-5D67-496B-8E87-E561075AD55C}', ['Dark-Style-1', 'Accent3']],
  ['{E929F9F4-4A8F-4326-A1B4-22849713DDAB}', ['Dark-Style-1', 'Accent4']],
  ['{8FD4443E-F989-4FC4-A0C8-D5A2AF1F390B}', ['Dark-Style-1', 'Accent5']],
  ['{AF606853-7671-496A-8E4F-DF71F8EC918B}', ['Dark-Style-1', 'Accent6']],

  ['{5202B0CA-FC54-4496-8BCA-5EF66A818D29}', ['Dark-Style-2', '']],
  ['{0660B408-B3CF-4A94-85FC-2B1E0A45F4A2}', ['Dark-Style-2', 'Accent1']],
  ['{91EBBBCC-DAD2-459C-BE2E-F6DE35CF9A28}', ['Dark-Style-2', 'Accent3']],
  ['{46F890A9-2807-4EBB-B81D-B2AA78EC7F39}', ['Dark-Style-2', 'Accent5']],
]);

/** The ids of every built-in style (tests). */
export const PREDEFINED_TABLE_STYLE_IDS: readonly string[] = [...STYLE_IDS.keys()];

/** An accent name of the id map as its scheme colour (LibreOffice's `resolveToken`; anything else is dk1). */
function resolveToken(accent: string): string {
  return /^Accent[1-6]$/.test(accent) ? `accent${accent.slice(6)}` : 'dk1';
}

/** A scheme colour with LibreOffice's colour transformations (`addTransformation`), in order. */
interface Color {
  scheme: string;
  mods: [string, number][];
}

type Part = 'wholeTbl' | 'firstRow' | 'firstCol' | 'lastRow' | 'lastCol' | 'band1H' | 'band1V' | 'band2V';
type Border = 'left' | 'right' | 'top' | 'bottom' | 'insideH' | 'insideV';

/** One style as LibreOffice builds it: what each part sets. Unset colours are not written. */
class Def {
  readonly text = new Map<Part, Color>();
  readonly fill = new Map<Part, Color>();
  bg?: Color;
  /** The borders LibreOffice turns on (`setBorderLineType`), with their colour once it is set. */
  readonly borders = new Map<Part, Map<Border, Color | undefined>>();

  line(part: Part, ...sides: Border[]): void {
    let m = this.borders.get(part);
    if (!m) this.borders.set(part, (m = new Map()));
    for (const s of sides) if (!m.has(s)) m.set(s, undefined);
  }
  /** The colour of a border LibreOffice turned on; a colour for one it did not is not used (as there). */
  lineColor(part: Part, scheme: string, ...sides: Border[]): void {
    const m = this.borders.get(part);
    for (const s of sides) if (m?.has(s)) m.set(s, { scheme, mods: [] });
  }
  lineMod(part: Part, mod: string, val: number, ...sides: Border[]): void {
    for (const s of sides) this.borders.get(part)?.get(s)?.mods.push([mod, val]);
  }
  setText(part: Part, scheme: string): void {
    this.text.set(part, { scheme, mods: [] });
  }
  setFill(part: Part, scheme: string): void {
    this.fill.set(part, { scheme, mods: [] });
  }
  fillMod(part: Part, mod: string, val: number): void {
    this.fill.get(part)?.mods.push([mod, val]);
  }
}

const OUTER: Border[] = ['left', 'right', 'top', 'bottom'];
const ALL: Border[] = [...OUTER, 'insideH', 'insideV'];

/** LibreOffice's `CreateTableStyle` body: the properties of each style group. */
function define(group: string, accent: string): Def {
  const d = new Def();
  const a = accent ? resolveToken(accent) : '';
  switch (group) {
    case 'Themed-Style-1': {
      if (a) {
        d.line('wholeTbl', ...ALL);
        d.line('firstRow', ...OUTER);
        d.line('lastRow', ...OUTER);
        d.line('firstCol', ...OUTER, 'insideH');
        d.line('lastCol', ...OUTER, 'insideH');
        d.setText('wholeTbl', 'dk1');
        d.setText('firstRow', 'lt1');
        d.lineColor('wholeTbl', a, ...ALL);
        d.lineColor('firstRow', a, 'left', 'right', 'top');
        d.lineColor('firstRow', 'lt1', 'bottom');
        d.setFill('firstRow', a);
        d.lineColor('lastRow', a, ...OUTER);
        d.lineColor('firstCol', a, ...OUTER, 'insideH');
        d.lineColor('lastCol', a, ...OUTER, 'insideH');
        d.setFill('band1H', a);
        d.setFill('band1V', a);
      } else d.setText('wholeTbl', 'tx1');
      d.fillMod('band1H', 'alpha', 40_000);
      d.fillMod('band1V', 'alpha', 40_000);
      break;
    }
    case 'Themed-Style-2': {
      d.line('wholeTbl', ...OUTER);
      let accentVal: string;
      if (a) {
        d.line('firstRow', 'bottom');
        d.line('lastRow', 'top');
        d.line('firstCol', 'right');
        d.line('lastCol', 'left');
        d.setText('wholeTbl', 'lt1');
        d.setText('firstRow', 'lt1');
        accentVal = a;
        d.bg = { scheme: a, mods: [] };
        d.lineColor('firstRow', 'lt1', 'bottom');
        d.lineColor('lastRow', 'lt1', 'top');
        d.lineColor('firstCol', 'lt1', 'right');
        d.lineColor('lastCol', 'lt1', 'left');
        d.setFill('band1H', 'lt1');
        d.setFill('band1V', 'lt1');
      } else {
        d.line('wholeTbl', 'insideV', 'insideH');
        accentVal = 'tx1';
        d.lineColor('wholeTbl', 'tx1', 'insideV', 'insideH');
      }
      d.lineColor('wholeTbl', accentVal, ...OUTER);
      d.fillMod('band1H', 'alpha', 20_000);
      d.fillMod('band1V', 'alpha', 20_000);
      d.lineMod('wholeTbl', 'tint', 50_000, ...OUTER);
      break;
    }
    case 'Light-Style-1': {
      d.line('wholeTbl', 'top', 'bottom');
      d.line('firstRow', 'bottom');
      d.line('lastRow', 'top');
      d.setText('wholeTbl', 'tx1');
      d.setText('firstRow', 'tx1');
      d.setText('lastCol', 'tx1');
      const v = a || 'tx1';
      d.lineColor('wholeTbl', v, 'top', 'bottom');
      d.lineColor('firstRow', v, 'bottom');
      d.lineColor('lastRow', v, 'top');
      d.setFill('band1H', v);
      d.setFill('band1V', v);
      d.fillMod('band1H', 'alpha', 20_000);
      d.fillMod('band1V', 'alpha', 20_000);
      break;
    }
    case 'Light-Style-2': {
      d.line('wholeTbl', ...OUTER);
      d.line('lastRow', 'top');
      d.line('band1H', 'top', 'bottom');
      d.line('band1V', 'left', 'right');
      d.line('band2V', 'left', 'right');
      d.setText('wholeTbl', 'tx1');
      d.setText('firstRow', 'bg1');
      const v = a || 'tx1';
      d.lineColor('wholeTbl', v, ...OUTER);
      d.setFill('firstRow', v);
      d.lineColor('lastRow', v, 'top');
      d.lineColor('band1H', v, 'top', 'bottom');
      d.lineColor('band1V', v, 'left', 'right');
      d.lineColor('band2V', v, 'left', 'right');
      break;
    }
    case 'Light-Style-3': {
      d.line('wholeTbl', ...ALL);
      d.line('firstRow', 'bottom');
      d.line('lastRow', 'top');
      d.setText('wholeTbl', 'tx1');
      const v = a || 'tx1';
      d.lineColor('wholeTbl', v, ...ALL);
      d.setText('firstRow', v);
      d.lineColor('firstRow', v, 'bottom');
      d.lineColor('lastRow', v, 'top');
      d.setFill('band1H', v);
      d.setFill('band1V', v);
      d.fillMod('band1H', 'alpha', 20_000);
      d.fillMod('band1V', 'alpha', 20_000);
      break;
    }
    case 'Medium-Style-1': {
      d.line('wholeTbl', ...OUTER, 'insideH');
      d.line('lastRow', 'top');
      d.setText('wholeTbl', 'dk1');
      d.setText('firstRow', 'lt1');
      d.setFill('wholeTbl', 'lt1');
      d.setFill('lastRow', 'lt1');
      const v = a || 'dk1';
      d.lineColor('wholeTbl', v, ...OUTER, 'insideH');
      d.setFill('firstRow', v);
      d.setFill('band1H', v);
      d.setFill('band1V', v);
      d.lineColor('lastRow', v, 'top');
      d.fillMod('band1H', 'tint', 20_000);
      d.fillMod('band1V', 'tint', 20_000);
      break;
    }
    case 'Medium-Style-2': {
      d.line('firstRow', 'bottom');
      d.line('lastRow', 'top');
      d.line('wholeTbl', ...ALL);
      d.setText('wholeTbl', 'dk1');
      d.setText('firstRow', 'lt1');
      d.setText('lastRow', 'lt1');
      d.setText('firstCol', 'lt1');
      d.setText('lastCol', 'lt1');
      d.lineColor('firstRow', 'lt1', 'bottom');
      d.lineColor('lastRow', 'lt1', 'top');
      d.lineColor('wholeTbl', 'lt1', ...ALL);
      const v = a || 'dk1';
      for (const p of ['wholeTbl', 'firstRow', 'lastRow', 'firstCol', 'lastCol', 'band1H', 'band1V'] as const)
        d.setFill(p, v);
      d.fillMod('wholeTbl', 'tint', 20_000);
      d.fillMod('band1H', 'tint', 40_000);
      d.fillMod('band1V', 'tint', 40_000);
      break;
    }
    case 'Medium-Style-3': {
      d.line('wholeTbl', 'top', 'bottom');
      d.line('firstRow', 'bottom');
      d.line('lastRow', 'top');
      d.setText('wholeTbl', 'dk1');
      d.setText('firstCol', 'lt1');
      d.setText('lastCol', 'lt1');
      d.lineColor('wholeTbl', 'dk1', 'top', 'bottom');
      d.setFill('wholeTbl', 'lt1');
      d.setFill('lastRow', 'lt1');
      d.setFill('band1H', 'dk1');
      d.setFill('band1V', 'dk1');
      d.setText('firstRow', 'lt1');
      d.lineColor('firstRow', 'dk1', 'bottom');
      d.lineColor('lastRow', 'dk1', 'top');
      const v = a || 'dk1';
      d.setFill('firstRow', v);
      d.setFill('firstCol', v);
      d.setFill('lastCol', v);
      d.fillMod('band1H', 'tint', 20_000);
      d.fillMod('band1V', 'tint', 20_000);
      break;
    }
    case 'Medium-Style-4': {
      d.line('wholeTbl', ...ALL);
      d.setText('wholeTbl', 'dk1');
      // LibreOffice colours the last row's top line but never turns it on.
      d.setFill('lastRow', 'dk1');
      const v = a || 'dk1';
      d.lineColor('wholeTbl', v, ...ALL);
      d.setFill('wholeTbl', v);
      d.setText('firstRow', v);
      d.setFill('firstRow', v);
      d.setFill('band1H', v);
      d.setFill('band1V', v);
      d.fillMod('firstRow', 'tint', 20_000);
      d.fillMod('lastRow', 'tint', 20_000);
      d.fillMod('wholeTbl', 'tint', 20_000);
      d.fillMod('band1H', 'tint', 40_000);
      d.fillMod('band1V', 'tint', 40_000);
      break;
    }
    case 'Dark-Style-1': {
      d.line('firstRow', 'bottom');
      d.line('firstCol', 'right');
      d.line('lastCol', 'left');
      d.line('lastRow', 'top');
      d.setText('wholeTbl', 'dk1');
      d.setText('firstRow', 'lt1');
      d.lineColor('firstRow', 'lt1', 'bottom');
      d.lineColor('firstCol', 'lt1', 'right');
      d.lineColor('lastCol', 'lt1', 'left');
      d.setFill('firstRow', 'dk1');
      d.lineColor('lastRow', 'lt1', 'top');
      const v = a || 'dk1';
      const mod = a ? 'shade' : 'tint';
      for (const p of ['wholeTbl', 'lastRow', 'firstCol', 'lastCol', 'band1H', 'band1V'] as const)
        d.setFill(p, v);
      d.fillMod('wholeTbl', mod, 20_000);
      d.fillMod('band1H', mod, 40_000);
      d.fillMod('band1V', mod, 40_000);
      d.fillMod('lastCol', mod, 60_000);
      d.fillMod('firstCol', mod, 60_000);
      break;
    }
    case 'Dark-Style-2': {
      d.line('lastRow', 'top');
      d.setText('wholeTbl', 'dk1');
      d.setText('firstRow', 'lt1');
      d.lineColor('lastRow', 'dk1', 'top');
      if (!accent) d.setFill('firstRow', 'dk1');
      else if (accent === 'Accent1') d.setFill('firstRow', 'accent2');
      else if (accent === 'Accent3') d.setFill('firstRow', 'accent4');
      else if (accent === 'Accent5') d.setFill('firstRow', 'accent6');
      const v = a || 'dk1';
      for (const p of ['wholeTbl', 'lastRow', 'band1H', 'band1V'] as const) d.setFill(p, v);
      d.fillMod('wholeTbl', 'tint', 20_000);
      d.fillMod('band1H', 'tint', 40_000);
      d.fillMod('band1V', 'tint', 40_000);
      d.fillMod('lastRow', 'tint', 20_000);
      break;
    }
  }
  return d;
}

// ── As an `a:tblStyle` element ──────────────────────────────────────────────────────────────────────────

function el(name: string, attrs: Record<string, string> = {}, children: XNode[] = []): XNode {
  return { name, attrs: Object.assign(Object.create(null), attrs), children, text: '' };
}

function color(c: Color): XNode {
  return el(
    'a:schemeClr',
    { val: c.scheme },
    c.mods.map(([m, v]) => el(`a:${m}`, { val: String(v) })),
  );
}

const solid = (c: Color) => el('a:solidFill', {}, [color(c)]);

/** Every border line: 1 pt (see the header). */
const LINE_WIDTH = '12700';

/** The parts written, in `CT_TableStyle` order. */
const PARTS: readonly Part[] = [
  'wholeTbl',
  'band1H',
  'band1V',
  'band2V',
  'lastCol',
  'firstCol',
  'lastRow',
  'firstRow',
];
/** Parts made bold (see the header). */
const BOLD: ReadonlySet<Part> = new Set(['firstRow', 'lastRow', 'firstCol', 'lastCol']);

const cache = new Map<string, XNode | undefined>();

/**
 * A built-in style as the `a:tblStyle` PowerPoint writes into `ppt/tableStyles.xml`, or undefined for an id
 * that is not one. The tree is shared: callers only read it.
 */
export function predefinedTableStyle(styleId: string): XNode | undefined {
  const key = styleId.trim().toUpperCase();
  if (cache.has(key)) return cache.get(key);
  const found = STYLE_IDS.get(key);
  let out: XNode | undefined;
  if (found) {
    const [group, accent] = found;
    const d = define(group, accent);
    const plain = !accent && (group === 'Themed-Style-1' || group === 'Themed-Style-2');
    const children: XNode[] = [];
    if (d.bg) children.push(el('a:tblBg', {}, [el('a:fill', {}, [solid(d.bg)])]));
    for (const p of PARTS) {
      const kids: XNode[] = [];
      const text = d.text.get(p);
      const bold = !plain && BOLD.has(p);
      if (text || bold) kids.push(el('a:tcTxStyle', bold ? { b: 'on' } : {}, text ? [color(text)] : []));
      const lines: XNode[] = [];
      for (const [side, c] of d.borders.get(p) ?? [])
        if (c) lines.push(el(`a:${side}`, {}, [el('a:ln', { w: LINE_WIDTH }, [solid(c)])]));
      const fill = d.fill.get(p);
      const style: XNode[] = [];
      if (lines.length) style.push(el('a:tcBdr', {}, lines));
      if (fill) style.push(el('a:fill', {}, [solid(fill)]));
      if (style.length) kids.push(el('a:tcStyle', {}, style));
      if (kids.length) children.push(el(`a:${p}`, {}, kids));
    }
    out = el('a:tblStyle', { styleId: key, styleName: `${group}${accent ? ` ${accent}` : ''}` }, children);
  }
  cache.set(key, out);
  return out;
}

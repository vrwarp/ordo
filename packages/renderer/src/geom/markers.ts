/*
 * This file is part of ordo. It is a port of code of the LibreOffice project.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Ported from LibreOffice core, oox/source/drawingml/lineproperties.cxx, `lclPushMarkerProperties`
 * (revision 9a5457bb95489987b50f2196922a0e6e72032bbb, 2026-11-06), which is subject to the same licence: the
 * marker polygons (OOX_ARROW_POINT lists), the size factors of each marker size, the open arrow's polygon
 * built from the line's half width (tdf#100491) and the smallest marker base (70, in 1/100 mm). This file
 * stays under the MPL 2.0 and on its own; `ends.ts`, which places and draws the markers, is ordo's own.
 */

/** OOXML line end types ordo draws (a:headEnd / a:tailEnd `type`). */
export type ArrowKind = 'triangle' | 'stealth' | 'arrow' | 'oval' | 'diamond';
/** OOXML line end sizes (`w`, `len`). */
export type ArrowSize = 'sm' | 'med' | 'lg';

/**
 * 0.7 mm in logical px (144 px per inch on both standard deck sizes): LibreOffice's smallest marker base
 * (`nBaseLineWidth = max(nLineWidth, 70)`, in 1/100 mm).
 */
export const ARROW_MIN_BASE = (0.7 / 25.4) * 144;

/** Width and length factors of the closed markers per size (sm, med, lg: 2, 3, 5). */
export const FACTOR: Readonly<Record<ArrowSize, number>> = { sm: 2, med: 3, lg: 5 };
/** Width factors of the open arrow per size. */
export const OPEN_WIDTH: Readonly<Record<ArrowSize, number>> = { sm: 2.5, med: 3.5, lg: 5.5 };
/**
 * Length factors of the open arrow per size. lg is 6 as ordo has drawn it since M6 (the revision above
 * reads 5.5).
 */
export const OPEN_LENGTH: Readonly<Record<ArrowSize, number>> = { sm: 2.5, med: 3.5, lg: 6 };

/**
 * The marker polygon in percent: x across the width (0..100), y back from the tip (0..100). `width` is the
 * marker's width and `line` the line width it is drawn on, in the same units (the open arrow's arms and stem
 * are as thick as the line).
 */
export function markerPercent(kind: ArrowKind, width: number, line: number): number[] {
  switch (kind) {
    case 'triangle':
      return [50, 0, 100, 100, 0, 100];
    case 'stealth':
      return [50, 0, 100, 100, 50, 60, 0, 100];
    case 'diamond':
      return [50, 0, 100, 50, 50, 100, 0, 50];
    case 'oval':
      return [50, 0, 75, 7, 93, 25, 100, 50, 93, 75, 75, 93, 50, 100, 25, 93, 7, 75, 0, 50, 7, 25, 25, 7];
    default: {
      // tdf#100491: the open arrow's arms and stem are as thick as the line.
      const h = Math.max((100 * 0.5 * line) / width, 1);
      return [
        50,
        0,
        100,
        100 - h * 1.5,
        100 - h * 1.5,
        100,
        50 + h,
        5.5 * h,
        50 + h,
        100,
        50 - h,
        100,
        50 - h,
        5.5 * h,
        h * 1.5,
        100,
        0,
        100 - h * 1.5,
      ];
    }
  }
}

import type { TextObject } from '@ordo/domain';
import { readZip } from '@ordo/importers/zip.ts';
import { emitSlides, parseDeck } from '@ordo/pptx-scene';
import { describe, expect, it } from 'vitest';
import { ESC_DECKS, type EscCase, escDeckBytes, LO_ESC_ZERO, PROBE_PT } from './esczero-probe.ts';

/** 60 pt at 96 dpi. */
const FONT_PX = (PROBE_PT * 96) / 72;

/** Each probe slide's text as the converter writes it, with ordo's policies or LibreOffice's. */
async function drawn(lo: boolean): Promise<TextObject[]> {
  const out: TextObject[] = [];
  for (const d of ESC_DECKS) {
    const scene = parseDeck(await readZip(escDeckBytes(d.cases)));
    for (const s of emitSlides(scene, lo ? { loCompat: true } : {}).slides)
      out.push(s.slide.objects.find((o): o is TextObject => o.type === 'text')!);
  }
  return out;
}

/** The shift a slide's runs are written with (0: in place, drawn at full size; else at 58 %). */
const shiftOf = (t: TextObject) => {
  const b = new Set((t.runs ?? []).map((r) => r.baseline ?? 0));
  expect(b.size).toBeLessThanOrEqual(1);
  return [...b][0] ?? 0;
};

/** PowerPoint's reading: the nearest baseline of the chain, 0 included. */
const powerPoint = (c: EscCase) => Number(c.run ?? c.list ?? c.deflt ?? 0) / 100_000;

describe('the baseline-0 probe (LibreOffice 24.2)', () => {
  const cases = ESC_DECKS.flatMap((d) => d.cases);

  it("writes each case as LibreOffice drew it under loCompat: the 0 unset, the chain's next baseline at 58 %", async () => {
    expect(LO_ESC_ZERO).toHaveLength(cases.length);
    const lo = await drawn(true);
    lo.forEach((t, i) => {
      const want = LO_ESC_ZERO[i]!;
      const shift = shiftOf(t);
      expect(shift !== 0, cases[i]!.name).toBe(want.scale < 1);
      expect(Math.abs(shift * FONT_PX - want.upPx), cases[i]!.name).toBeLessThanOrEqual(1);
      expect(t.style.fontSizePx).toBe(PROBE_PT * 2); // the size stays PowerPoint's: 2 logical px a point
    });
  });

  it("keeps PowerPoint's reading with ordo's policies: baseline 0 in place at full size", async () => {
    const ordo = await drawn(false);
    for (const [i, t] of ordo.entries())
      expect(shiftOf(t), cases[i]!.name).toBeCloseTo(powerPoint(cases[i]!), 9);
  });
});

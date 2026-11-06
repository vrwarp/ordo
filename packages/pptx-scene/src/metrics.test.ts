import { describe, expect, it } from 'vitest';
import { metricsOfTables, SFNT_LIMITS, sfntMetrics } from './metrics.ts';
import { sfntFont } from './test-util.ts';

describe('sfnt metrics', () => {
  it('reads advances through a format 4 cmap as shares of the em', () => {
    const m = sfntMetrics(sfntFont({ A: 600, b: 450, ' ': 250 }))!;
    expect(m.advance(0x41)).toBe(0.6);
    expect(m.advance(0x62)).toBe(0.45);
    expect(m.advance(0x20)).toBe(0.25);
    expect(m.advance(0x5a)).toBeUndefined(); // no glyph: not .notdef's width
  });

  it('reads a format 12 cmap, astral characters included', () => {
    const m = sfntMetrics(sfntFont({ '\u{1F600}': 2048, x: 1024 }, { upm: 2048, format: 12 }))!;
    expect(m.advance(0x1f600)).toBe(1);
    expect(m.advance(0x78)).toBe(0.5);
    expect(m.advance(0x79)).toBeUndefined();
  });

  it('refuses what it cannot read instead of throwing', () => {
    const good = sfntFont({ A: 600 });
    expect(sfntMetrics(new Uint8Array(0))).toBeUndefined();
    expect(sfntMetrics(new TextEncoder().encode('wOF2 not a font at all'))).toBeUndefined();
    // Truncated anywhere: undefined, never an exception.
    for (let n = 0; n < good.length; n += 7) expect(() => sfntMetrics(good.subarray(0, n))).not.toThrow();
    // A table directory claiming more tables than any font has.
    const many = good.slice();
    many[4] = 0xff;
    many[5] = 0xff;
    expect(sfntMetrics(many)).toBeUndefined();
    expect(SFNT_LIMITS.faces).toBeGreaterThan(1);
  });

  it('reads a face of a collection by its index', () => {
    const face = sfntFont({ A: 600 });
    // A collection of one face 16 bytes in: its table offsets move with it.
    const ttc = new Uint8Array(16 + face.length);
    ttc.set([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 16]);
    ttc.set(face, 16);
    const view = new DataView(ttc.buffer);
    for (let i = 0; i < view.getUint16(16 + 4); i++) {
      const at = 16 + 12 + i * 16 + 8;
      view.setUint32(at, view.getUint32(at) + 16);
    }
    expect(sfntMetrics(ttc, 0)?.advance(0x41)).toBe(0.6);
    expect(sfntMetrics(ttc, 1)).toBeUndefined();
  });

  it('reads decoded tables (WOFF and WOFF2 callers) and needs every one of them', () => {
    const bytes = sfntFont({ A: 600 });
    const view = new DataView(bytes.buffer);
    const n = view.getUint16(4);
    const tables = new Map<string, Uint8Array>();
    for (let i = 0; i < n; i++) {
      const e = 12 + i * 16;
      const tag = String.fromCharCode(...bytes.subarray(e, e + 4));
      tables.set(tag, bytes.subarray(view.getUint32(e + 8), view.getUint32(e + 8) + view.getUint32(e + 12)));
    }
    expect(metricsOfTables((t) => tables.get(t))?.advance(0x41)).toBe(0.6);
    for (const t of ['head', 'hhea', 'hmtx', 'cmap'])
      expect(metricsOfTables((x) => (x === t ? undefined : tables.get(x)))).toBeUndefined();
  });

  it('reads pair kerning from GPOS PairPos format 1, format 2 and Extension lookups', () => {
    const adv = { A: 600, V: 600, o: 500, T: 550 };
    const pairs: [string, string, number][] = [
      ['A', 'V', -80],
      ['T', 'o', -60],
      ['V', 'A', -70],
    ];
    for (const table of ['pairs', 'classes', 'extension'] as const) {
      const m = sfntMetrics(sfntFont(adv, { kern: { pairs, table } }))!;
      expect(m.kern?.(0x41, 0x56)).toBeCloseTo(-0.08, 9);
      expect(m.kern?.(0x56, 0x41)).toBeCloseTo(-0.07, 9);
      expect(m.kern?.(0x54, 0x6f)).toBeCloseTo(-0.06, 9);
      // Order matters, and characters the face lacks or pairs it does not list are 0.
      expect(m.kern?.(0x6f, 0x54)).toBe(0);
      expect(m.kern?.(0x41, 0x41)).toBe(0);
      expect(m.kern?.(0x41, 0x5a)).toBe(0);
      expect(m.kern?.(-1, 0x41)).toBe(0);
    }
  });

  it("takes the 'kern' feature of the Latin or default script only, as the browser's shaper does", () => {
    const adv = { A: 600, V: 600 };
    const pairs: [string, string, number][] = [['A', 'V', -80]];
    expect(sfntMetrics(sfntFont(adv, { kern: { pairs, script: 'DFLT' } }))!.kern?.(0x41, 0x56)).toBeCloseTo(
      -0.08,
      9,
    );
    // Another feature (a 'dist' lookup, say) is no kerning; neither is a script this text is not in.
    expect(sfntMetrics(sfntFont(adv, { kern: { pairs, feature: 'dist' } }))!.kern).toBeUndefined();
    expect(sfntMetrics(sfntFont(adv, { kern: { pairs, script: 'arab' } }))!.kern).toBeUndefined();
  });

  it('reads the legacy kern table when the font has no GPOS', () => {
    const m = sfntMetrics(
      sfntFont(
        { A: 600, V: 600, W: 700 },
        {
          kern: {
            pairs: [
              ['A', 'V', -100],
              ['W', 'A', -40],
            ],
            table: 'legacy',
          },
        },
      ),
    )!;
    expect(m.kern?.(0x41, 0x56)).toBeCloseTo(-0.1, 9);
    expect(m.kern?.(0x57, 0x41)).toBeCloseTo(-0.04, 9);
    expect(m.kern?.(0x56, 0x41)).toBe(0);
    expect(sfntMetrics(sfntFont({ A: 600 }))!.kern).toBeUndefined();
  });

  it('reads the ascent and descent LibreOffice sizes lines by: hhea, else OS/2 win, typo when the font asks', () => {
    const hhea = sfntMetrics(
      sfntFont({ A: 600 }, { upm: 2048, vertical: { ascender: 1950, descender: -550 } }),
    )!;
    expect(hhea.ascent).toBeCloseTo(1950 / 2048, 9);
    expect(hhea.descent).toBeCloseTo(550 / 2048, 9);
    expect(hhea.lineHeight).toBeCloseTo(2500 / 2048, 9);
    const win = sfntMetrics(sfntFont({ A: 600 }, { os2: { typo: [750, -250], win: [900, 300] } }))!;
    expect([win.ascent, win.descent]).toEqual([0.9, 0.3]);
    const typo = sfntMetrics(
      sfntFont(
        { A: 600 },
        {
          vertical: { ascender: 900, descender: -300 },
          os2: { typo: [750, -250], win: [900, 300], useTypo: true },
        },
      ),
    )!;
    expect([typo.ascent, typo.descent]).toEqual([0.75, 0.25]);
    expect(sfntMetrics(sfntFont({ A: 600 }))!.ascent).toBeUndefined();
  });

  it('reads hostile kerning tables without throwing, and bounded', () => {
    const font = sfntFont(
      { A: 600, V: 600, o: 500 },
      {
        kern: {
          pairs: [
            ['A', 'V', -80],
            ['V', 'o', -20],
          ],
          table: 'classes',
        },
      },
    );
    const view = new DataView(font.buffer);
    const n = view.getUint16(4);
    let gposAt = 0;
    let gposLen = 0;
    for (let i = 0; i < n; i++) {
      const e = 12 + i * 16;
      if (String.fromCharCode(...font.subarray(e, e + 4)) === 'GPOS') {
        gposAt = view.getUint32(e + 8);
        gposLen = view.getUint32(e + 12);
      }
    }
    expect(gposLen).toBeGreaterThan(0);
    // Every byte of GPOS set to 0xFF in turn, and the table cut short: the face reads, kerning is a number.
    for (let k = 0; k < gposLen; k++) {
      const bad = font.slice();
      bad[gposAt + k] = 0xff;
      const m = sfntMetrics(bad);
      expect(m?.advance(0x41)).toBe(0.6);
      const v = m?.kern?.(0x41, 0x56) ?? 0;
      expect(Number.isFinite(v) && Math.abs(v) <= 1).toBe(true);
    }
    for (let cut = 0; cut < gposLen; cut += 3) {
      const short = font.slice();
      new DataView(short.buffer).setUint32(
        12 +
          [...Array(n).keys()].find(
            (i) => String.fromCharCode(...font.subarray(12 + i * 16, 16 + i * 16)) === 'GPOS',
          )! *
            16 +
          12,
        cut,
      );
      expect(() => sfntMetrics(short)?.kern?.(0x41, 0x56)).not.toThrow();
    }
    expect(SFNT_LIMITS.lookups).toBeGreaterThan(0);
    expect(SFNT_LIMITS.subtables).toBeGreaterThan(0);
  });
});

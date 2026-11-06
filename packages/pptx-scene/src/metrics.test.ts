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
});

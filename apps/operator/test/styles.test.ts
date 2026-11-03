import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found`);
  return m[1]!;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('operator styles (prd/02 usability)', () => {
  it('.muted text reaches 4.5:1 on every background it sits on', () => {
    const muted = token('fg3');
    for (const bg of ['bg', 'bg2', 'bg3', 'bg4'])
      expect(contrast(muted, token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('live-view controls are at least 36 px high', () => {
    const rule = css.match(/\.op button,[\s\S]*?\{([\s\S]*?)\}/);
    expect(rule?.[1]).toMatch(/min-height:\s*36px/);
    expect(css).toMatch(/\.section-head button \{\s*min-height: 36px;/);
  });

  it('contrast helper agrees with known values', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#6f7886', '#0e1013')).toBeLessThan(4.5);
  });
});

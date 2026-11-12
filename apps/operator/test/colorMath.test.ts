import { describe, expect, it } from 'vitest';
import {
  clearRecentColors,
  getRecentColors,
  hsvToRgba,
  parseHexInput,
  recordRecentColor,
  rgbaCssString,
  rgbaToHsv,
} from '../src/components/colorMath.ts';

describe('colorMath', () => {
  it('round-trips RGBA <-> HSV for primary and mixed colors', () => {
    const samples = [
      { r: 255, g: 0, b: 0, a: 1 },
      { r: 0, g: 255, b: 0, a: 0.5 },
      { r: 0, g: 0, b: 255, a: 0.25 },
      { r: 59, g: 130, b: 246, a: 0.85 },
      { r: 255, g: 255, b: 255, a: 1 },
      { r: 0, g: 0, b: 0, a: 0 },
    ];
    for (const c of samples) {
      const hsv = rgbaToHsv(c);
      const back = hsvToRgba(hsv.h, hsv.s, hsv.v, hsv.a);
      expect(back).toEqual(c);
    }
  });

  it('parses #RGB, RGB, #RRGGBB, and rejects invalid hex strings', () => {
    expect(parseHexInput('#f0a')).toEqual({ r: 255, g: 0, b: 170 });
    expect(parseHexInput('3b82f6')).toEqual({ r: 59, g: 130, b: 246 });
    expect(parseHexInput(' #C82828 ')).toEqual({ r: 200, g: 40, b: 40 });
    expect(parseHexInput('#12')).toBeNull();
    expect(parseHexInput('not-hex')).toBeNull();
    expect(parseHexInput('')).toBeNull();
  });

  it('deduplicates recent colors and caps at 8 entries', () => {
    clearRecentColors();
    for (let i = 0; i < 10; i++) {
      recordRecentColor({ r: i * 20, g: 100, b: 200, a: 1 });
    }
    expect(getRecentColors()).toHaveLength(8);
    expect(getRecentColors()[0]).toEqual({ r: 180, g: 100, b: 200, a: 1 });

    // Recording an existing color moves it to the front without increasing length
    recordRecentColor({ r: 40, g: 100, b: 200, a: 1 });
    expect(getRecentColors()).toHaveLength(8);
    expect(getRecentColors()[0]).toEqual({ r: 40, g: 100, b: 200, a: 1 });
    clearRecentColors();
  });

  it('formats CSS rgba string', () => {
    expect(rgbaCssString({ r: 59, g: 130, b: 246, a: 0.5 })).toBe('rgba(59, 130, 246, 0.5)');
  });
});

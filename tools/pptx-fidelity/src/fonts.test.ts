import { existsSync } from 'node:fs';
import type { Slide, TextObject } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  fcFamily,
  fcMatch,
  hostFamilies,
  hostFonts,
  SCRIPT_LANG,
  SCRIPT_RANGE,
  scriptFallbackPlan,
  scriptsOf,
} from './fonts.ts';

const text = (t: string, style: Partial<TextObject['style']> = {}): TextObject => ({
  id: 't',
  type: 'text',
  box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
  text: t,
  style: {
    fontFamily: 'Calibri',
    fontWeight: 400,
    fontStyle: 'normal',
    fontSizePx: 40,
    color: { r: 0, g: 0, b: 0, a: 1 },
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
    letterSpacing: 0,
    padding: 0,
    transform: 'none',
    ...style,
  },
  opacity: 1,
});
const slide = (...objects: TextObject[]): Slide => ({ id: 's', objects });

describe('script fallbacks', () => {
  it("plans the fallbacks of the text's scripts, the installed family first", () => {
    expect(scriptFallbackPlan(new Set(), new Set()).size).toBe(0);
    const plan = scriptFallbackPlan(new Set(['Cyrl', 'Grek', 'Hebr', 'Latn']), new Set());
    expect([...plan.values()].map((p) => [p.family, p.scripts, p.installed])).toEqual([
      ['Noto Sans', ['Grek', 'Cyrl'], false],
      ['Noto Sans Hebrew', ['Hebr'], false],
    ]);
    const cjk = scriptFallbackPlan(new Set(['Hani', 'Kana']), new Set(['noto sans tc']));
    expect(cjk.get('noto sans tc')).toEqual({ family: 'Noto Sans TC', scripts: ['Hani'], installed: true });
    expect(cjk.get('noto sans jp')).toEqual({ family: 'Noto Sans JP', scripts: ['Kana'], installed: false });
    expect(cjk.has('noto sans kr')).toBe(false);
  });

  it('knows a language and a range for every script it plans', () => {
    const all = new Set(Object.keys(SCRIPT_LANG));
    expect(new Set(Object.keys(SCRIPT_RANGE))).toEqual(all);
    for (const p of scriptFallbackPlan(all, new Set()).values())
      for (const s of p.scripts) {
        expect(SCRIPT_LANG[s], s).toBeTruthy();
        expect(SCRIPT_RANGE[s], s).toMatch(/^U\+[0-9A-F]+(-[0-9A-F]+)?(, U\+[0-9A-F]+(-[0-9A-F]+)?)*$/);
      }
  });

  it('reads the scripts of text objects, bullet labels included', () => {
    expect([...scriptsOf([slide(text('Amazing grace'), text('שלום'), text('神愛世人'))])].sort()).toEqual([
      'Hani',
      'Hebr',
    ]);
    const thai = { ...text('one\ntwo'), paras: [{ bullet: { auto: 'thaiNumPeriod' } }, null] };
    expect([...scriptsOf([slide(thai)])]).toEqual(['Thai']);
  });

  it('escapes what fontconfig parses in a family', () => {
    expect(fcFamily('Segoe UI')).toBe('Segoe UI');
    expect(fcFamily('A-B:C,D\\E')).toBe('A\\-B\\:C\\,D\\\\E');
  });
});

const fontconfig = existsSync('/usr/bin/fc-match') && (await fcMatch('sans')) !== undefined;

describe.skipIf(!fontconfig)("hostFonts (this machine's fontconfig)", () => {
  const slides = [
    slide(
      text('Amazing grace', { fallbackFonts: ['Carlito', 'Noto Sans Hebrew'] }),
      text('שלום', { fontFamily: 'Arial' }),
    ),
  ];

  it('gives every asked family and the default face a face, hashed, one per variant', async () => {
    const got = await hostFonts(slides);
    const families = new Set(got.fonts.map((f) => f.family));
    for (const f of ['Calibri', 'Carlito', 'Arial']) expect(families.has(f), f).toBe(true);
    for (const f of got.fonts) {
      expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(f.file)).toBe(true);
    }
    // Asked families draw every character.
    expect(got.fonts.find((f) => f.family === 'Calibri')!.unicodeRange).toBeUndefined();
    const keys = got.fonts.map((f) => `${f.family}|${f.weight}|${f.style}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("registers the text's script fallbacks when installed, stand-ins only when asked", async () => {
    const installed = (await hostFamilies()).has('noto sans hebrew');
    const plain = await hostFonts(slides);
    const hebrew = plain.scripts.find((s) => s.family === 'Noto Sans Hebrew')!;
    expect(hebrew.scripts).toEqual(['Hebr']);
    expect(hebrew.served).toBe(installed ? 'installed' : 'missing');
    expect(plain.fonts.some((f) => f.family === 'Noto Sans Hebrew')).toBe(installed);
    // No Arabic or CJK text: their fallbacks would never be asked for.
    expect(plain.scripts.map((s) => s.family)).toEqual(['Noto Sans Hebrew']);

    const stood = await hostFonts(slides, { standIns: true });
    const face = stood.fonts.find((f) => f.family === 'Noto Sans Hebrew')!;
    expect(face.unicodeRange).toBe(SCRIPT_RANGE.Hebr);
    const served = stood.scripts.find((s) => s.family === 'Noto Sans Hebrew')!;
    expect(served.served).toBe(installed ? 'installed' : 'stand-in');
    expect(served.file).toBe(face.file);
  });

  it('adds the CJK fallbacks when the text has CJK', async () => {
    const got = await hostFonts([slide(text('神愛世人'))], { standIns: true });
    expect(got.fonts.some((f) => f.family === 'Noto Sans SC' && f.unicodeRange === SCRIPT_RANGE.Hani)).toBe(
      true,
    );
  });
});

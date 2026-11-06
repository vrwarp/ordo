import { existsSync } from 'node:fs';
import type { Slide, TextObject } from '@ordo/domain';
import { substituteOf } from '@ordo/pptx-scene/fontmap.ts';
import { metricCompatible } from '@ordo/renderer/text/fonts.ts';
import { describe, expect, it } from 'vitest';
import {
  familyNames,
  fcFamily,
  fcMatch,
  hostFamilies,
  hostFonts,
  isStandIn,
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

describe('stand-in faces', () => {
  it("reads fontconfig's family lists", () => {
    expect(familyNames('Inter,Inter Medium')).toEqual(['Inter', 'Inter Medium']);
    expect(familyNames('A\\,B, C,')).toEqual(['A,B', 'C']);
    expect(familyNames('')).toEqual([]);
  });

  it('flags a face of another family unless one of its names is the family or a metric-compatible one', () => {
    const host = (...names: string[]) => ({ family: names[0] ?? '', names });
    expect(isStandIn('Aptos', host('Inter'))).toBe(true);
    expect(isStandIn('Calibri Light', host('Carlito'))).toBe(true);
    expect(isStandIn('Calibri', host('Carlito'))).toBe(false);
    expect(isStandIn('Times New Roman', host('Liberation Serif'))).toBe(false);
    expect(isStandIn('Inter Medium', host('Inter', 'Inter Medium'))).toBe(false);
    expect(isStandIn('aptos', { family: 'Aptos', names: [] })).toBe(false);
  });

  it("agrees with the converter's substitutes: all metric-compatible but Calibri Light's", () => {
    const families = ['Calibri', 'Cambria', 'Arial', 'Helvetica', 'Arial Narrow', 'Times New Roman', 'Times'];
    for (const f of [...families, 'Courier New', 'Courier', 'Georgia']) {
      const sub = substituteOf(f);
      expect(sub, f).toBeTruthy();
      expect(metricCompatible(f, sub!), f).toBe(true);
    }
    expect(substituteOf('Calibri Light')).toBe('Carlito');
    expect(metricCompatible('Calibri Light', 'Carlito')).toBe(false);
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

  it("flags fontconfig's face for a family it lacks, unless it is a metric clone", async () => {
    const got = await hostFonts([slide(text('Amazing grace', { fontFamily: 'Aptos' }), text('Grace'))]);
    for (const family of ['Aptos', 'Calibri']) {
      const host = (await fcMatch(fcFamily(family)))!;
      const faces = got.fonts.filter((f) => f.family === family);
      expect(faces.length, family).toBeGreaterThan(0);
      const flagged = !host.names.some((n) => metricCompatible(family, n));
      for (const f of faces)
        expect(f.substitute === true, `${family} drawn with ${host.family}`).toBe(flagged);
    }
    // ordo's default face is its own.
    expect(got.fonts.filter((f) => f.family === 'Inter').every((f) => f.substitute === undefined)).toBe(true);
  });

  it('adds the CJK fallbacks when the text has CJK', async () => {
    const got = await hostFonts([slide(text('神愛世人'))], { standIns: true });
    expect(got.fonts.some((f) => f.family === 'Noto Sans SC' && f.unicodeRange === SCRIPT_RANGE.Hani)).toBe(
      true,
    );
  });
});

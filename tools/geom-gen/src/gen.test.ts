import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEXT_WARPS } from '../../../packages/domain/src/schemas.ts';
import {
  applyFixes,
  compilePresets,
  FIXES,
  generate,
  generateTextWarps,
  POI_SHA256,
  readPresets,
  TEXTWARPS_SHA256,
} from './gen.ts';
import { parseXml } from './xml.ts';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const XML = read('../../../third_party/poi-presets/presetShapeDefinitions.xml');

describe('geom-gen', () => {
  it('vendors POI 5.2.5 presetShapeDefinitions.xml byte for byte (the fixes are applied by the generator)', () => {
    expect(
      createHash('sha256')
        .update(
          readFileSync(
            new URL('../../../third_party/poi-presets/presetShapeDefinitions.xml', import.meta.url),
          ),
        )
        .digest('hex'),
    ).toBe(POI_SHA256);
  });

  it('matches the committed presets.gen.ts (run `pnpm --filter @ordo/geom-gen gen` after a change)', () => {
    expect(generate(XML) === read('../../../packages/renderer/src/geom/presets.gen.ts')).toBe(true);
  });

  it('is deterministic', () => {
    expect(generate(XML)).toBe(generate(XML));
  });

  it('reads all 187 presets with every part', () => {
    const defs = readPresets(XML);
    expect(defs.size).toBe(187);
    const gear9 = defs.get('gear9')!;
    expect(gear9.av.length + gear9.gd.length).toBe(244);
    const pie = defs.get('pie')!;
    expect(pie.av).toEqual([
      ['adj1', 'val 0'],
      ['adj2', 'val 16200000'],
    ]);
    expect(pie.paths[0]!.cmds.map((c) => c.op)).toEqual(['moveTo', 'arcTo', 'lnTo', 'close']);
    expect(pie.paths[0]!.cmds[1]!.args).toEqual(['wd2', 'hd2', 'stAng', 'swAng']);
    expect(pie.handles[0]).toEqual({
      kind: 'polar',
      gdRefAng: 'adj1',
      minAng: '0',
      maxAng: '21599999',
      x: 'x1',
      y: 'y1',
    });
    expect(pie.sites.length).toBe(4);
    // Five presets have no text rect (the text then takes the whole box).
    expect([...defs.values()].filter((d) => d.rect === undefined).length).toBe(5);
  });

  it('applies the two fixes verified against LibreOffice', () => {
    const defs = readPresets(XML);
    expect(defs.get('pie')!.rect).toEqual({ l: 'il', t: 'ir', r: 'it', b: 'ib' });
    expect(defs.get('star24')!.handles[0]).toMatchObject({ gdRefY: 'adj', minY: '0', maxY: 'ssd2' });
    applyFixes(defs);
    expect(defs.get('pie')!.rect).toEqual({ l: 'il', t: 'it', r: 'ir', b: 'ib' });
    for (const n of ['star24', 'star32'])
      expect(defs.get(n)!.handles[0]).toMatchObject({ gdRefY: 'adj', minY: '0', maxY: '50000' });
    expect(FIXES.map((f) => f.preset)).toEqual(['pie', 'star24', 'star32']);
  });

  it('refuses a fix whose original text has changed', () => {
    const defs = readPresets(XML);
    applyFixes(defs);
    expect(() => applyFixes(defs)).toThrow(/pie: the text rect to fix/);
    const fixedPie = XML.replace('<rect l="il" t="ir" r="it" b="ib"', '<rect l="il" t="it" r="ir" b="ib"');
    expect(fixedPie).not.toBe(XML);
    expect(() => generate(fixedPie)).toThrow(/pie/);
  });

  it('refuses parts it would not compile', () => {
    const extra = XML.replace('<pie>', '<pie>\n    <frobnicate/>');
    expect(() => readPresets(extra)).toThrow(/pie: unexpected <frobnicate>/);
    const attr = XML.replace(
      '<arcTo wR="wd2" hR="hd2" stAng="stAng" swAng="swAng" />',
      '<arcTo wR="wd2" hR="hd2" stAng="stAng" swAng="swAng" spin="1" />',
    );
    expect(() => readPresets(attr)).toThrow(/unexpected attribute spin/);
    const unknownName = XML.replace(
      '<gd name="wt1" fmla="sin wd2 stAng" />',
      '<gd name="wt1" fmla="sin wd7 stAng" />',
    );
    expect(() => generate(unknownName)).toThrow(/: unknown name 'wd7' in guide 'wt1'/);
  });
});

describe('text warps', () => {
  // ECMA-376 Part 1 20.1.9.19 presetTextWarpDefinitions, docx4j-core 11.4.11's copy (third_party/ooxml-textwarps).
  const WARPS_URL = '../../../third_party/ooxml-textwarps/presetTextWarpDefinitions.xml';
  // Read inside each test, so a missing file fails the warp tests only and the preset tests above still run.
  const warps = (): string => read(WARPS_URL);
  const ROOT = 'presetTextWarpDefinitions';

  it('vendors the 40 warps byte for byte (61,386 bytes, the jar entry)', () => {
    const bytes = readFileSync(new URL(WARPS_URL, import.meta.url));
    expect(bytes.length).toBe(61_386);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(TEXTWARPS_SHA256);
    expect(TEXTWARPS_SHA256).toBe('665b2e494d853d1e776d5b59322926a089ba7933236a9458e49389545c621fd1');
  });

  it('matches the committed textwarps.gen.ts and is deterministic', () => {
    const out = generateTextWarps(warps());
    expect(out === read('../../../packages/renderer/src/geom/textwarps.gen.ts')).toBe(true);
    expect(generateTextWarps(warps())).toBe(out);
    expect(out).toContain(TEXTWARPS_SHA256);
    expect(out).toContain('export const TEXT_WARP_GEOMS: ReadonlyMap<string, CompiledGeom>');
  });

  it('reads the 40 presets of the domain schema, each with its parts and no text rectangle', () => {
    const defs = readPresets(warps(), ROOT);
    expect(defs.size).toBe(40);
    expect([...defs.keys()].sort()).toEqual([...TEXT_WARPS].sort());
    const names = new Set<string>();
    const two: string[] = [];
    for (const [name, d] of defs) {
      expect(d.gd.length, name).toBeGreaterThan(0);
      expect(d.handles.length, name).toBeGreaterThan(0);
      expect(d.paths.length, name).toBeGreaterThan(0);
      expect(d.rect, name).toBeUndefined();
      expect(d.sites, name).toEqual([]);
      for (const [a] of d.av) names.add(a);
      if (d.av.length === 2) two.push(name);
    }
    expect([...names].sort()).toEqual(['adj', 'adj1', 'adj2']);
    expect([...defs.values()].filter((d) => d.av.length === 1).length).toBe(32);
    expect(two.sort()).toEqual([
      'textArchDownPour',
      'textArchUpPour',
      'textButtonPour',
      'textCirclePour',
      'textDoubleWave1',
      'textWave1',
      'textWave2',
      'textWave4',
    ]);
  });

  it('compiles every preset with no note, to the path counts the geometry builder reads', () => {
    const compiled = compilePresets(readPresets(warps(), ROOT));
    expect(compiled.size).toBe(40);
    const counts = new Map<number, string[]>();
    for (const [name, g] of compiled) counts.set(g.p.length, [...(counts.get(g.p.length) ?? []), name]);
    expect(counts.get(2)!.length).toBe(33);
    expect(counts.get(1)!.sort()).toEqual(['textArchDown', 'textArchUp', 'textCircle']);
    expect(counts.get(3)).toEqual(['textButton']);
    expect(counts.get(4)).toEqual(['textDeflateInflate']);
    expect(counts.get(6)!.sort()).toEqual(['textButtonPour', 'textDeflateInflateDeflate']);
    // The file has no text rectangle (slots 2..5 are the box's own l, t, r, b) and no connection sites.
    for (const [name, g] of compiled) {
      expect(g.r, name).toEqual([2, 3, 4, 5]);
      expect(g.c, name).toBeUndefined();
    }
  });

  it('refuses what the compiler would not read, naming the preset', () => {
    const WARPS_XML = warps();
    const unknownElement = WARPS_XML.replace('<textPlain>', '<textPlain>\n<frobnicate/>');
    expect(unknownElement).not.toBe(WARPS_XML);
    expect(() => readPresets(unknownElement, ROOT)).toThrow(/textPlain: unexpected <frobnicate>/);
    const pathAttr = WARPS_XML.replace(/(<textPlain>[\s\S]*?)<path>/, '$1<path spin="1">');
    expect(pathAttr).not.toBe(WARPS_XML);
    expect(() => readPresets(pathAttr, ROOT)).toThrow(/textPlain: unexpected path attribute spin/);
    const unknownName = WARPS_XML.replace(
      /(<textPlain>[\s\S]*?)fmla="\*\/ a w 100000"/,
      '$1fmla="*/ a wz 100000"',
    );
    expect(unknownName).not.toBe(WARPS_XML);
    expect(() => generateTextWarps(unknownName)).toThrow(/textPlain: unknown name 'wz' in guide 'mid'/);
    const root = WARPS_XML.replace(/presetTextWarpDefinitions>/g, 'presetTextWarpDefinitionz>');
    expect(root).not.toBe(WARPS_XML);
    expect(() => generateTextWarps(root)).toThrow(/unexpected root <presetTextWarpDefinitionz>/);
  });

  it('keeps the two files apart: each generator refuses the other input', () => {
    expect(() => generateTextWarps(XML)).toThrow(/unexpected root <presetShapeDefinitons>/);
    expect(() => generate(warps())).toThrow(/unexpected root <presetTextWarpDefinitions>/);
    expect(() => readPresets(warps())).toThrow(/unexpected root/);
  });

  it('leaves the 187-preset table as it was (the existing test, restated: no byte moved)', () => {
    expect(generate(XML) === read('../../../packages/renderer/src/geom/presets.gen.ts')).toBe(true);
  });
});

describe('xml', () => {
  it('reads elements, attributes, comments and entities', () => {
    const root = parseXml(
      '<?xml version="1.0"?>\r\n<!-- c --><a x="1" y=\'&lt;&#65;&#x42;&amp;\'><b/><!-- d --><c z="&quot;"></c>text</a>\n',
    );
    expect(root.name).toBe('a');
    expect([...root.attrs]).toEqual([
      ['x', '1'],
      ['y', '<AB&'],
    ]);
    expect(root.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(root.children[1]!.attrs.get('z')).toBe('"');
  });

  it('refuses declarations, unknown entities and malformed markup', () => {
    for (const bad of [
      '<!DOCTYPE a [<!ENTITY e "x">]><a/>',
      '<a x="&e;"/>',
      '<a><b></a>',
      '<a x="1" x="2"/>',
      '<a/><b/>',
      '<a',
      '<a x=1/>',
      'text<a/>',
      '<a><![CDATA[x]]></a>',
    ]) {
      expect(() => parseXml(bad), bad).toThrow();
    }
  });
});

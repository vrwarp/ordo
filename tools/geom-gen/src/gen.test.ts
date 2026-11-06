import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyFixes, FIXES, generate, POI_SHA256, readPresets } from './gen.ts';
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

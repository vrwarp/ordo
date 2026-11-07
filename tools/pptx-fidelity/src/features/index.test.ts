import { body, para, run, sp } from '@ordo/pptx-scene/test-util.ts';
import { describe, expect, it } from 'vitest';
import {
  deckFeatures,
  FEATURE_FAMILIES,
  type FeatureFamily,
  featureFamily,
  featureSource,
  partFeatures,
  textFeatures,
  xmlFeatureOrder,
} from './index.ts';
import { relatedTargets, resolveTarget } from './xml.ts';

const shape = (txBody: string) => sp({ id: 2, x: 0, y: 0, cx: 100, cy: 100, txBody });
const parts = (m: Record<string, string>) => (name: string) => m[name] ?? '';

/** A family as an M9 track would add one: open-ended names, features of the parts the slide names. */
const charts: FeatureFamily = featureFamily({
  key: 'chart',
  features: ['chart:bar', 'chart:pie'],
  detect: (src) =>
    src
      .related('/chart')
      .flatMap((xml) => [
        ...(xml.includes('<c:barChart') ? ['chart:bar'] : []),
        ...(xml.includes('<c:pieChart') ? ['chart:pie'] : []),
        ...(xml.includes('<c:radarChart') ? ['chart:radar'] : []),
      ]),
});

describe('the feature registry', () => {
  it('registers the text family, whose features are those of M2', () => {
    expect(FEATURE_FAMILIES.map((f) => f.key)).toEqual(['text']);
    const xml = shape(body(para(run('16', 'baseline="30000"') + run(' For God'))));
    const got = partFeatures(featureSource('ppt/slides/slide1.xml', parts({ 'ppt/slides/slide1.xml': xml })));
    expect(got).toEqual({ textFeatures: textFeatures(xml), xmlFeatures: [] });
    expect(got.textFeatures).toEqual(['superSub', 'mixedRuns']);
  });

  it('gives another family the parts a slide names, in report order', () => {
    const rels =
      '<Relationships><Relationship Id="rId2" Type="http://x/relationships/chart" Target="../charts/chart2.xml"/>' +
      '<Relationship Id="rId3" Type="http://x/relationships/chart" Target="../charts/chart1.xml"/>' +
      '<Relationship Id="rId4" Type="http://x/relationships/chart" Target="https://example.com/c.xml" TargetMode="External"/>' +
      '<Relationship Id="rId5" Type="http://x/relationships/image" Target="../media/image1.png"/></Relationships>';
    const read = parts({
      'ppt/slides/slide1.xml': '<p:sld/>',
      'ppt/slides/_rels/slide1.xml.rels': rels,
      'ppt/charts/chart1.xml': '<c:radarChart/>',
      'ppt/charts/chart2.xml': '<c:pieChart/><c:barChart/>',
    });
    const families = [...FEATURE_FAMILIES, charts];
    const got = partFeatures(featureSource('ppt/slides/slide1.xml', read), families);
    expect(got).toEqual({ textFeatures: [], xmlFeatures: ['chart:bar', 'chart:pie', 'chart:radar'] });
    const deck = deckFeatures(
      [got, { textFeatures: ['rtl'], xmlFeatures: ['chart:pie'] }],
      { textFeatures: ['superSub'], xmlFeatures: [] },
      families,
    );
    expect(deck).toEqual({
      textFeatures: ['superSub', 'rtl'],
      xmlFeatures: ['chart:bar', 'chart:pie', 'chart:radar'],
    });
    expect(xmlFeatureOrder(['chart:zz', 'chart:pie', 'chart:aa'], families)).toEqual([
      'chart:pie',
      'chart:aa',
      'chart:zz',
    ]);
  });

  it('reports nothing for a family that throws, and keeps the others', () => {
    const bad = featureFamily({
      key: 'bad',
      features: [],
      detect: () => {
        throw new Error('hostile');
      },
    });
    const xml = '<a:pPr rtl="1"/>';
    expect(
      partFeatures(featureSource('ppt/slides/slide1.xml', parts({ 'ppt/slides/slide1.xml': xml })), [
        ...FEATURE_FAMILIES,
        bad,
      ]),
    ).toEqual({
      textFeatures: ['rtl'],
      xmlFeatures: [],
    });
  });

  it('resolves relationship targets inside the package only', () => {
    expect(resolveTarget('ppt/slides/slide1.xml', '../charts/chart1.xml')).toBe('ppt/charts/chart1.xml');
    expect(resolveTarget('ppt/slides/slide1.xml', '/ppt/media/a.png')).toBe('ppt/media/a.png');
    expect(resolveTarget('ppt/slides/slide1.xml', '../../../etc/passwd')).toBeUndefined();
    expect(resolveTarget('ppt/slides/slide1.xml', 'file:///etc/passwd')).toBeUndefined();
    expect(resolveTarget('ppt/slides/slide1.xml', '')).toBeUndefined();
  });

  it('reads relationships linearly on a hostile .rels part', () => {
    const hostile = '<Relationship Type="/chart" Target="a.xml" '.repeat(100_000);
    const t0 = performance.now();
    expect(relatedTargets('ppt/slides/slide1.xml', hostile, '/chart')).toEqual([]);
    const many = '<Relationship Type="x/chart" Target="c.xml"/>'.repeat(50_000);
    expect(relatedTargets('ppt/slides/slide1.xml', many, '/chart')).toEqual(['ppt/slides/c.xml']);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

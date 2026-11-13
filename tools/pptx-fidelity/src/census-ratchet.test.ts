import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type Baseline,
  baselineJson,
  type CensusLine,
  compareCensus,
  parseRatchetArgs,
  recordBaseline,
} from './census-ratchet.ts';

const here = dirname(fileURLToPath(import.meta.url));

const line = (name: string, slides: [number, string, string, string[]][], extra: Partial<CensusLine> = {}) =>
  ({
    name,
    slides: slides.map(([n, c, hub, reasons]) => ({ n, class: c, hub, reasons })),
    ...extra,
  }) as CensusLine;

const census = (): CensusLine[] => [
  line('sermons__a.pptx', [
    [1, 'native', 'native', ['mixedRuns', 'custGeom']],
    [2, 'hybrid', 'hybrid', ['chart']],
  ]),
  line('worship__b.pptx', [[1, 'native', 'native', []]]),
];

describe('golden-pptx census ratchet', () => {
  const baseline = recordBaseline(census(), 'test');

  it('records each shown slide with its class, hub class and sorted reasons', () => {
    expect(baseline.decks['sermons__a.pptx']).toEqual([
      [1, 'native', 'native', ['custGeom', 'mixedRuns']],
      [2, 'hybrid', 'hybrid', ['chart']],
    ]);
    // The written file is the same baseline, one slide a line.
    const json = baselineJson(baseline);
    expect(JSON.parse(json)).toEqual(baseline);
    expect(json).toContain('\n      [1,"native","native",["custGeom","mixedRuns"]],\n');
  });

  it('passes the census it was recorded from', () => {
    const r = compareCensus(baseline, census());
    expect(r).toMatchObject({ failures: [], improved: [], notes: [], decks: 2, slides: 3 });
  });

  it('fails a slide whose class or hub class gets worse, a slide that is gone, a missing or unreadable deck', () => {
    const worse = [
      line('sermons__a.pptx', [
        [1, 'hybrid', 'hybrid', ['custGeom', 'mixedRuns', 'smartart']],
        [2, 'hybrid', 'picture', ['chart']],
      ]),
    ];
    expect(compareCensus(baseline, worse).failures).toEqual([
      'sermons__a.pptx slide 1: native -> hybrid (custGeom, mixedRuns, smartart)',
      'sermons__a.pptx slide 2: in the hub hybrid -> picture (chart)',
      'worship__b.pptx: missing from the corpus',
    ]);
    const gone = [census()[0]!, line('worship__b.pptx', [])];
    expect(compareCensus(baseline, gone).failures).toEqual([
      'worship__b.pptx slide 1: no longer a shown slide',
    ]);
    const broken = [census()[0]!, line('worship__b.pptx', [], { error: 'bad zip' })];
    expect(compareCensus(baseline, broken).failures).toEqual([
      'worship__b.pptx: the converter cannot read it any more (bad zip)',
    ]);
    const unreadable = [census()[0]!, line('worship__b.pptx', [], { unreadable: 'missing target' })];
    expect(compareCensus(baseline, unreadable).failures).toEqual([
      'worship__b.pptx: missing from the corpus',
    ]);
  });

  it('passes and reports a better class, other reasons, and decks or slides the baseline lacks', () => {
    const better = [
      line('sermons__a.pptx', [
        [1, 'native', 'native', ['custGeom']],
        [2, 'native', 'native', ['chart']],
        [3, 'native', 'native', []],
      ]),
      census()[1]!,
      line('new__c.pptx', [[1, 'native', 'native', []]]),
    ];
    const r = compareCensus(baseline, better);
    expect(r.failures).toEqual([]);
    expect(r.improved).toEqual(['sermons__a.pptx slide 2: hybrid/hybrid -> native/native']);
    expect(r.notes).toEqual([
      'sermons__a.pptx slide 1: reasons custGeom, mixedRuns -> custGeom',
      'sermons__a.pptx slide 3: new shown slide (not in the baseline)',
      'new__c.pptx: new deck (not in the baseline)',
    ]);
  });

  it('reads its options', () => {
    expect(parseRatchetArgs(['--write', '--corpus', 'x'])).toMatchObject({ write: true });
    expect(() => parseRatchetArgs(['--out'])).toThrow(/needs a value/);
    expect(() => parseRatchetArgs(['--nope'])).toThrow(/unknown option/);
  });

  it('the committed baseline covers the whole corpus manifest', () => {
    const b = JSON.parse(readFileSync(join(here, '..', 'golden-census-baseline.json'), 'utf8')) as Baseline;
    const manifest = JSON.parse(readFileSync(join(here, '../../../golden-pptx/manifest.json'), 'utf8')) as
      | { rel_path?: string }[]
      | Record<string, { rel_path?: string }>;
    const entries = Array.isArray(manifest) ? manifest : Object.values(manifest);
    const decks = entries.map((e) => (e.rel_path ?? '').replace(/^golden-pptx\//, '').replaceAll('/', '__'));
    expect(decks.length).toBeGreaterThan(100);
    for (const d of decks) expect(b.decks, d).toHaveProperty([d]);
  });
});

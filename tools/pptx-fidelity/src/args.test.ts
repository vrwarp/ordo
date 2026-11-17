import { describe, expect, it } from 'vitest';
import { parseArgs, parseSlideSpec, slidesFor } from './args.ts';

describe('parseArgs', () => {
  it('keeps the defaults and the existing options', () => {
    const a = parseArgs(['--engine', 'both', '--no-ppv', '--out', 'o', 'a.pptx', '--', 'dir']);
    expect([...a.engines]).toEqual(['native']);
    expect(a).toMatchObject({ out: 'o', loCompat: false, slides: [], decks: ['a.pptx', 'dir'] });
    expect(() => parseArgs(['--engine', 'x'])).toThrow(/--engine/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/);
  });

  it('reads --lo-compat, --script-stand-ins and repeated --slides', () => {
    const a = parseArgs(['--lo-compat', '--slides', '2,4-6', '--slides', 'Hymns_2:1', 'decks']);
    expect(a.loCompat).toBe(true);
    expect(a.scriptStandIns).toBe(false);
    expect(parseArgs(['--script-stand-ins']).scriptStandIns).toBe(true);
    expect(a.slides.map((s) => [s.deck, [...s.slides]])).toEqual([
      [undefined, [2, 4, 5, 6]],
      ['Hymns_2', [1]],
    ]);
    expect(a.decks).toEqual(['decks']);
    expect(() => parseArgs(['--slides'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--slides', '--lo-compat'])).toThrow(/needs a value/);
  });

  it('reads repeated --ask-hub lists as --slides reads its own, and names the flag in its errors', () => {
    expect(parseArgs(['decks']).askHub).toEqual([]);
    const a = parseArgs([
      '--before',
      'hub',
      '--ask-hub',
      'Colossians:1',
      '--ask-hub',
      'Boletim:2,3',
      'decks',
    ]);
    expect(a.askHub.map((s) => [s.deck, [...s.slides]])).toEqual([
      ['Colossians', [1]],
      ['Boletim', [2, 3]],
    ]);
    expect(a.slides).toEqual([]);
    expect([...slidesFor(a.askHub, 'Boletim_Fev-17')!]).toEqual([2, 3]);
    expect(slidesFor(a.askHub, 'other')!.size).toBe(0);
    expect(() => parseArgs(['--ask-hub'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--ask-hub', 'x:0'])).toThrow(/^--ask-hub x:0: '0' is not a slide number/);
    expect(() => parseArgs(['--slides', 'x:0'])).toThrow(/^--slides x:0: '0' is not a slide number/);
  });

  it('reads --ask-hub-nolo as --ask-hub, and all-tables for every table slide (sub-wave 1c)', () => {
    expect(parseArgs(['decks'])).toMatchObject({ askHubNoLo: [], askHubNoLoTables: false });
    const a = parseArgs(['--ask-hub-nolo', 'Korean:18-20', '--ask-hub-nolo', '2', 'decks']);
    expect(a.askHubNoLo.map((s) => [s.deck, [...s.slides]])).toEqual([
      ['Korean', [18, 19, 20]],
      [undefined, [2]],
    ]);
    expect(a.askHubNoLoTables).toBe(false);
    expect(a.askHub).toEqual([]);
    expect(parseArgs(['--ask-hub-nolo', 'all-tables', 'd'])).toMatchObject({
      askHubNoLo: [],
      askHubNoLoTables: true,
      decks: ['d'],
    });
    expect(() => parseArgs(['--ask-hub-nolo'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--ask-hub-nolo', 'x:0'])).toThrow(
      /^--ask-hub-nolo x:0: '0' is not a slide number/,
    );
  });

  it('reads --before hub or paste and refuses anything else', () => {
    expect(parseArgs(['decks']).before).toBeUndefined();
    expect(parseArgs(['--before', 'hub', 'decks'])).toMatchObject({ before: 'hub', decks: ['decks'] });
    expect(parseArgs(['--before', 'paste', 'decks'])).toMatchObject({ before: 'paste', decks: ['decks'] });
    expect(() => parseArgs(['--before', 'harness'])).toThrow(/--before takes hub or paste/);
    expect(() => parseArgs(['--before'])).toThrow(/needs a value/);
  });

  it('refuses slide lists that are not numbers or ranges', () => {
    for (const bad of ['', '0', '3-1', 'a', '1,,2', ':3', '1-200000', '2.5', '-1'])
      expect(() => parseSlideSpec(bad), bad).toThrow();
    expect([...parseSlideSpec(' 7 , 9 - 10 ').slides]).toEqual([7, 9, 10]);
  });
});

describe('slidesFor', () => {
  const specs = [parseSlideSpec('1'), parseSlideSpec('hymn:5-6'), parseSlideSpec('TALK:9')];

  it('scores every slide without --slides', () => {
    expect(slidesFor([], 'any')).toBeUndefined();
  });

  it('joins the lists for every deck with those naming the deck, case-insensitively', () => {
    expect([...slidesFor(specs, 'Easter_Hymns')!].sort()).toEqual([1, 5, 6]);
    expect([...slidesFor(specs, 'a_talk_deck')!].sort()).toEqual([1, 9]);
    expect([...slidesFor(specs, 'other')!]).toEqual([1]);
  });

  it('leaves out decks no list names when every list names a deck', () => {
    expect(slidesFor([parseSlideSpec('hymn:2')], 'other')!.size).toBe(0);
  });

  it('reads the M9 flags: --no-libreoffice, --hub-budget and the hub to import through', () => {
    expect(parseArgs(['d'])).toMatchObject({ noLibreOffice: false, hubBudget: false });
    expect(parseArgs(['--no-libreoffice', '--hub-budget', '--hub', 'dist', 'd'])).toMatchObject({
      noLibreOffice: true,
      hubBudget: true,
      hub: 'dist',
      decks: ['d'],
    });
    expect(() => parseArgs(['--hub', 'docker'])).toThrow(/dist or source/);
  });
});

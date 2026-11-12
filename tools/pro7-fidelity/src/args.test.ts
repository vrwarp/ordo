import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.ts';

describe('parseArgs', () => {
  it('provides default values when no flags or env provided', () => {
    const args = parseArgs([], {});
    expect(args).toEqual({
      sampleDir: undefined,
      corpus: true,
      outDir: '/tmp/pro7-fidelity',
      decks: undefined,
      slides: undefined,
      exportCompat: true,
      baselinePath: undefined,
      writeBaselinePath: undefined,
      ratchet: false,
      requireGain: false,
      maxSlideDrop: 0.005,
      maxDeckDrop: 0.002,
      worstCount: 12,
    });
  });

  it('reads sampleDir from environment and sets corpus to false by default', () => {
    const args = parseArgs([], { ORDO_PRO7_SAMPLE_DIR: '/path/to/samples' });
    expect(args.sampleDir).toBe('/path/to/samples');
    expect(args.corpus).toBe(false);
  });

  it('allows explicit --corpus and --no-corpus overriding automatic default', () => {
    expect(parseArgs(['--corpus'], { ORDO_PRO7_SAMPLE_DIR: '/path' }).corpus).toBe(true);
    expect(parseArgs(['--no-corpus'], {}).corpus).toBe(false);
  });

  it('parses --sample-dir, --out, --baseline, --write-baseline', () => {
    const args = parseArgs([
      '--sample-dir',
      '/custom/samples',
      '--out',
      '/custom/out',
      '--baseline',
      '/custom/baseline.json',
      '--write-baseline',
      '/custom/new-baseline.json',
    ]);
    expect(args.sampleDir).toBe('/custom/samples');
    expect(args.outDir).toBe('/custom/out');
    expect(args.baselinePath).toBe('/custom/baseline.json');
    expect(args.writeBaselinePath).toBe('/custom/new-baseline.json');
  });

  it('parses --decks with trimming and lowercase', () => {
    const args = parseArgs(['--decks', ' Deck A , Deck B ']);
    expect(args.decks).toEqual(new Set(['deck a', 'deck b']));

    const args2 = parseArgs(['--decks=Deck1', '--decks=Deck2,Deck3']);
    expect(args2.decks).toEqual(new Set(['deck1', 'deck2', 'deck3']));
  });

  it('parses --slides with single numbers, ranges, and repeatable / semicolon formats', () => {
    const args = parseArgs(['--slides', 'Deck A:1,3-5;Deck B:2', '--slides=Deck A:7-8,10']);
    expect(args.slides).toBeDefined();
    expect(args.slides?.get('deck a')).toEqual(new Set([1, 3, 4, 5, 7, 8, 10]));
    expect(args.slides?.get('deck b')).toEqual(new Set([2]));
  });

  it('parses boolean and numeric flags', () => {
    const args = parseArgs([
      '--no-export-compat',
      '--ratchet',
      '--require-gain',
      '--max-slide-drop',
      '0.01',
      '--max-deck-drop',
      '0.004',
      '--worst',
      '20',
    ]);
    expect(args.exportCompat).toBe(false);
    expect(args.ratchet).toBe(true);
    expect(args.requireGain).toBe(true);
    expect(args.maxSlideDrop).toBe(0.01);
    expect(args.maxDeckDrop).toBe(0.004);
    expect(args.worstCount).toBe(20);
  });

  it('supports = syntax for all flags', () => {
    const args = parseArgs([
      '--sample-dir=/s',
      '--out=/o',
      '--export-compat=false',
      '--max-slide-drop=0.02',
      '--max-deck-drop=0.01',
      '--worst=5',
    ]);
    expect(args.sampleDir).toBe('/s');
    expect(args.outDir).toBe('/o');
    expect(args.exportCompat).toBe(false);
    expect(args.maxSlideDrop).toBe(0.02);
    expect(args.maxDeckDrop).toBe(0.01);
    expect(args.worstCount).toBe(5);
  });
});

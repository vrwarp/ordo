import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkExceptions,
  deckHash,
  EXCEPTIONS,
  exceptionFor,
  exceptionMarks,
  exceptionProblems,
} from './exceptions.ts';

const ok = { deck: 'a3f09c1d2e4b', slide: 16, reason: 'the cold draw of 349 ms is not fixed yet' };

describe('named exceptions', () => {
  it('an entry needs a deck hash, a slide and a reason', () => {
    expect(exceptionProblems(ok)).toEqual([]);
    expect(exceptionProblems({ ...ok, gate: 'all' })).toEqual([]);
    expect(exceptionProblems({ slide: 1, reason: 'x' })[0]).toMatch(/deck/);
    // A name, a short prefix or upper-case hex is not a deck hash.
    for (const deck of ['Gospel Songs.pptx', 'a3f09c', 'A3F09C1D2E4B', `${'a'.repeat(64)}0`])
      expect(exceptionProblems({ ...ok, deck })[0], deck).toMatch(/deck/);
    for (const slide of [0, -1, 1.5, '3', undefined])
      expect(exceptionProblems({ ...ok, slide }), String(slide)).toEqual([
        'slide must be a 1-based shown slide number',
      ]);
    for (const reason of ['', '   ', undefined])
      expect(exceptionProblems({ ...ok, reason })).toEqual(['reason must say why']);
    expect(exceptionProblems({ ...ok, reason: 'x'.repeat(301) })[0]).toMatch(/longer/);
    expect(exceptionProblems({ ...ok, gate: 'none' })).toEqual(["gate must be 'hub' or 'all'"]);
    expect(exceptionProblems(null)).toHaveLength(3);
  });

  it('refuses a list that names a slide twice, and finds an entry by hash prefix', () => {
    expect(() => checkExceptions([ok, { ...ok, deck: `${ok.deck}00` }])).toThrow(/named twice/);
    expect(() => checkExceptions([ok, { ...ok, slide: 2 }])).not.toThrow();
    expect(() => checkExceptions([{ ...ok, reason: '' }])).toThrow(/exception 1/);
    const list = checkExceptions([ok]);
    expect(exceptionFor(`${ok.deck}${'0'.repeat(52)}`, 16, list)).toEqual(ok);
    expect(exceptionFor(`${ok.deck.toUpperCase()}${'0'.repeat(52)}`, 16, list)).toEqual(ok);
    expect(exceptionFor(`${ok.deck}${'0'.repeat(52)}`, 15, list)).toBeUndefined();
    expect(exceptionFor('b'.repeat(64), 16, list)).toBeUndefined();
  });

  it('marks the slide an entry names with its reason, and with its gate only when it lifts both', () => {
    const hash = `${ok.deck}${'0'.repeat(52)}`;
    const list = checkExceptions([ok, { ...ok, slide: 3, gate: 'all' }]);
    expect(exceptionMarks(hash, 16, list)).toEqual({ exception: ok.reason });
    expect(exceptionMarks(hash, 3, list)).toEqual({ exception: ok.reason, exceptionGate: 'all' });
    expect(exceptionMarks(hash, 4, list)).toEqual({});
  });

  it('keeps the list in force well formed', () => {
    expect(() => checkExceptions(EXCEPTIONS)).not.toThrow();
  });

  it("hashes a deck's file", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordo-exc-'));
    try {
      writeFileSync(join(dir, 'a.pptx'), 'abc');
      expect(await deckHash(join(dir, 'a.pptx'))).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Robustness of the control-surface parsers (design/25 "Fuzzing"): MIDI bytes, keyboard events and Stream
 * Deck pages loaded from stored JSON are untrusted input. None of them may throw; outputs stay well-formed.
 */
import type { MidiMapping, StreamDeckPage } from '@ordo/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type DeckView,
  faceKey,
  isModifierOnly,
  keyFace,
  learnFrom,
  lcdText,
  matchMidi,
  normalizeCombo,
  pageTarget,
  parseMidi,
  resolvePageTarget,
  sanitizeDeckPages,
} from './index.ts';

const anyJson = fc.jsonValue({ maxDepth: 4 });
const looseMapping = fc.record(
  {
    id: fc.string(),
    deviceName: fc.oneof(fc.string(), fc.constant(undefined)),
    kind: fc.constantFrom('note', 'cc', 'other'),
    number: fc.oneof(fc.integer({ min: -5, max: 200 }), fc.constant(Number.NaN)),
    channel: fc.oneof(fc.integer({ min: 0, max: 20 }), fc.constant(undefined)),
    threshold: fc.oneof(fc.integer({ min: -5, max: 200 }), fc.constant(Number.NaN), fc.constant(undefined)),
    action: fc.record({
      id: fc.constantFrom('go', 'next', 'clearAll'),
      arg: fc.option(fc.nat(), { nil: undefined }),
    }),
  },
  { requiredKeys: ['kind', 'number', 'action'] },
);

describe('MIDI parsing (fuzz)', () => {
  it('parseMidi / matchMidi / learnFrom never throw on random bytes and loose mappings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ maxLength: 6 }), { maxLength: 20 }),
        fc.array(looseMapping, { maxLength: 6 }),
        fc.string({ maxLength: 10 }),
        (msgs, mappings, device) => {
          const last = new Map<string, number>();
          const last2 = new Map<string, number>();
          for (const m of msgs) {
            const p = parseMidi(m);
            if (p) {
              expect(p.channel).toBeGreaterThanOrEqual(1);
              expect(p.channel).toBeLessThanOrEqual(16);
              expect(p.number).toBeLessThanOrEqual(127);
              expect(p.value).toBeLessThanOrEqual(127);
            }
            const actions = matchMidi(mappings as unknown as MidiMapping[], device, m, last);
            for (const a of actions) expect(['go', 'next', 'clearAll']).toContain(a.id);
            expect(actions.length).toBeLessThanOrEqual(mappings.length);
            const learned = learnFrom({ id: 'go' }, device, m, last2);
            if (learned) {
              expect(learned.number).toBeLessThanOrEqual(127);
              expect(learned.channel).toBeGreaterThanOrEqual(1);
            }
          }
          expect(last.size).toBeLessThanOrEqual(16 * 128);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('a CC mapping fires once per upward crossing however the bytes arrive', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 127 }), { maxLength: 40 }), (values) => {
        const last = new Map<string, number>();
        const m: MidiMapping = { id: 'm', kind: 'cc', number: 7, threshold: 64, action: { id: 'go' } };
        let fired = 0;
        let prev = 0;
        let expected = 0;
        for (const v of values) {
          fired += matchMidi([m], 'dev', new Uint8Array([0xb0, 7, v]), last).length;
          if (prev < 64 && v >= 64) expected++;
          prev = v;
        }
        expect(fired).toBe(expected);
      }),
    );
  });
});

describe('keyboard normalisation (fuzz)', () => {
  it('normalizeCombo / isModifierOnly never throw and are stable', () => {
    fc.assert(
      fc.property(
        fc.record({
          code: fc.oneof(
            fc.string({ maxLength: 12 }),
            fc.constantFrom('KeyA', 'Space', 'ArrowRight', 'ShiftLeft', ''),
            fc.constant(undefined),
          ),
          key: fc.oneof(
            fc.string({ unit: 'binary', maxLength: 4 }),
            fc.constantFrom(' ', 'a', 'Spacebar', 'Unidentified', ''),
            fc.constant(undefined),
          ),
          ctrlKey: fc.boolean(),
          metaKey: fc.boolean(),
          altKey: fc.boolean(),
          shiftKey: fc.boolean(),
        }),
        (e) => {
          const ev = e as unknown as KeyboardEvent;
          const c = normalizeCombo(ev);
          expect(typeof c).toBe('string');
          expect(c.length).toBeGreaterThan(0);
          expect(c.length).toBeLessThanOrEqual(64);
          expect(normalizeCombo(ev)).toBe(c);
          expect(c.split('+').at(-1)!.length).toBeGreaterThan(0);
          expect(typeof isModifierOnly(ev)).toBe('boolean');
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('regression: an event with neither code nor key does not throw', () => {
    expect(normalizeCombo({ ctrlKey: true } as unknown as KeyboardEvent)).toBe('Ctrl+Unidentified');
    expect(normalizeCombo({ code: '', key: '+', ctrlKey: true } as unknown as KeyboardEvent)).toBe(
      'Ctrl+Plus',
    );
  });
});

const view: fc.Arbitrary<DeckView> = fc.record({
  sections: fc.array(
    fc.record({ short: fc.string({ maxLength: 4 }), label: fc.string({ maxLength: 10 }), pos: fc.nat(10) }),
    {
      maxLength: 5,
    },
  ),
  liveSectionPos: fc.option(fc.nat(10), { nil: undefined }),
  nextItems: fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
  black: fc.boolean(),
  logo: fc.boolean(),
  mediaPlaying: fc.boolean(),
  liveLabel: fc.option(fc.string(), { nil: undefined }),
  connected: fc.boolean(),
  masterDb: fc.option(fc.oneof(fc.double(), fc.constant(Number.NaN)), { nil: undefined }),
});

const keyish = fc.oneof(
  anyJson,
  fc.record(
    {
      action: fc.oneof(anyJson, fc.record({ id: fc.constantFrom('go', 'clearAll', 'logo', 'nope') })),
      dynamic: fc.oneof(fc.constantFrom('section', 'nextItem'), anyJson),
      dynamicIndex: fc.oneof(fc.integer({ min: -3, max: 20 }), anyJson),
      label: fc.oneof(
        fc.string({ maxLength: 12 }),
        fc.constantFrom('Page:next', 'Page:prev', 'Page:Audio', 'Page:'),
        anyJson,
      ),
      color: fc.oneof(fc.string({ maxLength: 8 }), anyJson),
    },
    { requiredKeys: [] },
  ),
);
const storedPages = fc.oneof(
  anyJson,
  fc.array(
    fc.oneof(
      anyJson,
      fc.record(
        {
          name: fc.oneof(fc.string({ maxLength: 10 }), anyJson),
          keys: fc.oneof(fc.dictionary(fc.string({ maxLength: 3 }), keyish), anyJson),
        },
        { requiredKeys: [] },
      ),
    ),
    { maxLength: 6 },
  ),
);

describe('Stream Deck pages from stored JSON (fuzz)', () => {
  it('sanitizeDeckPages accepts any JSON; key faces and page navigation never throw', () => {
    fc.assert(
      fc.property(storedPages, view, fc.integer({ min: -3, max: 10 }), (raw, v, cur) => {
        const pages: StreamDeckPage[] = sanitizeDeckPages(raw);
        expect(Array.isArray(pages)).toBe(true);
        for (const p of pages) {
          expect(typeof p.name).toBe('string');
          expect(typeof p.keys).toBe('object');
          for (const [slot, k] of Object.entries(p.keys)) {
            expect(slot).toMatch(/^\d{1,3}$/);
            const f = keyFace(k, v, { pages, pageIndex: cur });
            expect(typeof f.label).toBe('string');
            expect(typeof faceKey(f)).toBe('string');
            const t = pageTarget(k);
            if (t !== undefined) {
              const i = resolvePageTarget(pages, Math.max(0, cur), t);
              expect(i).toBeGreaterThanOrEqual(0);
              expect(i).toBeLessThan(Math.max(1, pages.length));
            }
          }
        }
        expect(typeof lcdText(v, pages[0]?.name).title).toBe('string');
      }),
      { numRuns: 2000 },
    );
  });

  it('regressions: missing keys object, non-string labels and names', () => {
    const pages = sanitizeDeckPages([
      { name: 'A' },
      { name: 5, keys: { 0: { label: 7 } } },
      null,
      {
        name: 'B',
        keys: {
          0: { label: 'Page:next' },
          1: { action: { id: 'go' }, dynamicIndex: -1 },
          x: { label: 'bad slot' },
        },
      },
    ]);
    expect(pages.map((p) => p.name)).toEqual(['A', 'Page 2', 'B']);
    expect(pages[0]!.keys).toEqual({});
    expect(pages[1]!.keys).toEqual({});
    expect(Object.keys(pages[2]!.keys)).toEqual(['0', '1']);
    expect(pages[2]!.keys['1']).toEqual({ action: { id: 'go' } });
    expect(resolvePageTarget(pages, 0, 'next')).toBe(1);
    expect(sanitizeDeckPages('nonsense')).toEqual([]);
    // A stale page index from a longer list stays in range.
    expect(resolvePageTarget(pages, 7, 'Unknown')).toBe(2);
  });
});

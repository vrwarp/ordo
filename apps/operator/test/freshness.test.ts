/**
 * The compact layout's freshness line (design/28 §2.2, §2.12; src/lib/freshness.ts): hidden while connected,
 * offline or unreachable with the copy's time, the 5 s grace on a drop, and the stored last contact read
 * defensively.
 */
import { describe, expect, it } from 'vitest';
import {
  FRESHNESS_GRACE_MS,
  freshnessShown,
  freshnessText,
  LAST_CONTACT_KEY,
  parseLastContact,
  readLastContact,
  writeLastContact,
} from '../src/lib/freshness.ts';

const fmt = { locale: 'en-GB', timeZone: 'Europe/London' };
const thu = Date.UTC(2026, 10, 19, 21, 14);

describe('freshnessText', () => {
  it('is hidden while connected', () => {
    expect(freshnessText({ offline: false, hubDown: false, lastContact: thu }, fmt)).toBeUndefined();
  });
  it('offline, with the time of the copy or without one', () => {
    expect(freshnessText({ offline: true, hubDown: false, lastContact: thu }, fmt)).toBe(
      'Offline · copy from Thu 21:14',
    );
    expect(freshnessText({ offline: true, hubDown: true, lastContact: undefined }, fmt)).toBe(
      'Offline · copy on this phone',
    );
  });
  it("can't reach ordo while online", () => {
    expect(freshnessText({ offline: false, hubDown: true, lastContact: thu }, fmt)).toBe(
      "Can't reach ordo · copy from Thu 21:14",
    );
    expect(freshnessText({ offline: false, hubDown: true, lastContact: undefined }, fmt)).toBe(
      "Can't reach ordo · copy on this phone",
    );
  });
});

describe('freshnessShown', () => {
  it('waits the grace on a drop, not on an offline start', () => {
    expect(freshnessShown(undefined, 10_000, false)).toBe(false);
    expect(freshnessShown(1000, 1000 + FRESHNESS_GRACE_MS - 1, false)).toBe(false);
    expect(freshnessShown(1000, 1000 + FRESHNESS_GRACE_MS, false)).toBe(true);
    expect(freshnessShown(1000, 1000, true)).toBe(true);
  });
});

describe('the last contact', () => {
  const now = thu + 3_600_000;
  it('parses only a plausible whole number of ms', () => {
    expect(parseLastContact(String(thu), now)).toBe(thu);
    for (const bad of [
      null,
      undefined,
      '',
      'abc',
      '12.5',
      '-5',
      '1',
      String(now + 2 * 86_400_000),
      '9'.repeat(25),
    ])
      expect(parseLastContact(bad as string | null | undefined, now), String(bad)).toBeUndefined();
  });

  it('is read and written through the storage, and never throws', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    expect(readLastContact(now, storage)).toBeUndefined();
    writeLastContact(thu, storage);
    expect(map.get(LAST_CONTACT_KEY)).toBe(String(thu));
    expect(readLastContact(now, storage)).toBe(thu);
    writeLastContact(Number.NaN, storage);
    expect(map.get(LAST_CONTACT_KEY)).toBe(String(thu));
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readLastContact(now, blocked)).toBeUndefined();
    expect(() => writeLastContact(thu, blocked)).not.toThrow();
    expect(readLastContact(now, undefined)).toBeUndefined();
  });
});

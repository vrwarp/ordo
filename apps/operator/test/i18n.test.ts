/**
 * The compact layout's strings (design/28 §6 "UI language", src/i18n): parameters, one/other plurals through
 * Intl.PluralRules, the UI language (English in P0) and dates and times through Intl.DateTimeFormat.
 */
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.ts';
import { formatDate, formatDayTime, formatTime, t, uiLanguage } from '../src/i18n/index.ts';

describe('t', () => {
  it('fills parameters and leaves unknown ones as they are', () => {
    expect(t('signin.host', { host: 'op.church.example' })).toBe('ordo at op.church.example');
    expect(t('signin.host')).toBe('ordo at {host}');
  });

  it('picks one or other by the count', () => {
    expect(t('plans.items', { n: 1 })).toBe('1 item');
    expect(t('plans.items', { n: 6 })).toBe('6 items');
    expect(t('plans.items', { n: 0 })).toBe('0 items');
    expect(t('live.sheet', { name: 'Sunday Service', n: 1 })).toContain('its 1 presentation are locked');
    expect(t('live.sheet', { name: 'Sunday Service', n: 6 })).toContain('its 6 presentations are locked');
  });

  it('never throws on a count that is not a number', () => {
    expect(t('plans.items', { n: 'x' })).toBe('x items');
  });

  it('every entry is a string or a plural with one and other', () => {
    for (const [k, v] of Object.entries(en)) {
      if (typeof v === 'string') continue;
      expect(Object.keys(v).sort(), k).toEqual(['one', 'other']);
    }
  });
});

describe('uiLanguage', () => {
  it('is English in P0, whatever the device prefers', () => {
    expect(uiLanguage(['en-GB', 'en'])).toBe('en');
    expect(uiLanguage(['ar-EG', 'he'])).toBe('en');
    expect(uiLanguage([])).toBe('en');
    expect(uiLanguage(undefined)).toBe('en');
    expect(uiLanguage([42, 'x'.repeat(100)])).toBe('en');
  });
});

describe('formats', () => {
  // Thursday 19 November 2026, 21:14 in London (GMT).
  const at = Date.UTC(2026, 10, 19, 21, 14);

  it('a weekday and a time: "Thu 21:14" in en-GB with Europe/London', () => {
    expect(formatDayTime(at, { locale: 'en-GB', timeZone: 'Europe/London' })).toBe('Thu 21:14');
  });

  it('a time of day in the device locale', () => {
    expect(formatTime(at, { locale: 'en-GB', timeZone: 'Europe/London' })).toBe('21:14');
    expect(formatTime(at, { locale: 'en-US', timeZone: 'Europe/London' })).toMatch(/^9:14\sPM$/);
  });

  it('an unknown locale or zone falls back to English, an invalid time to nothing', () => {
    expect(formatTime(at, { locale: 'not a locale!', timeZone: 'Nowhere/Else' })).not.toBe('');
    expect(formatDayTime(Number.NaN)).toBe('');
  });

  it("a plan's service date", () => {
    expect(formatDate('2026-11-22', { locale: 'en-GB' })).toBe('Sun 22 Nov');
    expect(formatDate('next Sunday')).toBe('next Sunday');
    expect(formatDate('x'.repeat(100))).toHaveLength(40);
  });
});

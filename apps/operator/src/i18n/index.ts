import { en } from './en.ts';
import type { enCompact } from './enCompact.ts';

/**
 * The compact layout's strings and formats (design/28 §6 "UI language"; P0: English only). `t(key, params)`
 * reads the catalog of the UI language, fills `{name}` parameters and picks a plural form (`{ one, other }`)
 * with Intl.PluralRules from `params.n`; dates and times go through Intl.DateTimeFormat in the device's
 * locale. The seam P1 builds on: more catalogs beside en.ts, chosen by uiLanguage from navigator.languages
 * (and an override in More), with `<html lang dir>` following it.
 */
export type Plural = { readonly one: string; readonly other: string };
/** Every key: the entry's (en.ts) and the compact chunk's (enCompact.ts, a type import: not bundled here). */
export type MessageKey = keyof typeof en | keyof typeof enCompact;
export type UiLanguage = 'en';
export type Params = Readonly<Record<string, string | number>>;
type Entry = string | Plural;

/**
 * The catalogs: the entry's strings at once; the compact chunk adds its own when it loads (addStrings, from
 * compactStrings.ts), so the venue PC never downloads them.
 */
const CATALOGS: Record<UiLanguage, Partial<Record<MessageKey, Entry>>> = { en: { ...en } };

/** Add strings to a language's catalog (the compact chunk's, at its load). */
export function addStrings(lang: UiLanguage, strings: Readonly<Partial<Record<MessageKey, Entry>>>): void {
  Object.assign(CATALOGS[lang], strings);
}

/**
 * The UI language for a device's preferred languages (navigator.languages): the first one with a catalog,
 * else English. P0 has the English catalog only, so this is always 'en'.
 */
export function uiLanguage(languages: readonly unknown[] | undefined | null): UiLanguage {
  for (const l of languages ?? []) {
    if (typeof l !== 'string' || l.length > 35) continue;
    const base = l.toLowerCase().split('-')[0] as UiLanguage;
    if (Object.hasOwn(CATALOGS, base)) return base;
  }
  return 'en';
}

const plurals = new Map<string, Intl.PluralRules>();
function pluralRules(lang: string): Intl.PluralRules {
  let r = plurals.get(lang);
  if (!r) {
    r = new Intl.PluralRules(lang);
    plurals.set(lang, r);
  }
  return r;
}

function fill(text: string, params: Params): string {
  return text.replace(/\{(\w+)\}/g, (all, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : all,
  );
}

/**
 * A string of the catalog, its parameters filled and its plural form chosen by `params.n`. A key whose catalog
 * has not loaded reads as the key itself (never thrown: the page keeps working).
 */
export function t(key: MessageKey, params: Params = {}, lang: UiLanguage = 'en'): string {
  const entry = CATALOGS[lang][key] ?? CATALOGS.en[key];
  if (entry === undefined) return key;
  if (typeof entry === 'string') return fill(entry, params);
  const n = Number(params.n ?? 0);
  const form = pluralRules(lang).select(Number.isFinite(n) ? n : 0);
  return fill(form === 'one' ? entry.one : entry.other, params);
}

/** The device's locale for dates and times (navigator.language), or English outside a browser. */
function deviceLocale(): string {
  return typeof navigator !== 'undefined' && typeof navigator.language === 'string'
    ? navigator.language
    : 'en';
}

export type FormatOptions = { locale?: string; timeZone?: string };

function format(at: number | Date, o: Intl.DateTimeFormatOptions, opts: FormatOptions): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const options = { ...o, ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) };
  try {
    return new Intl.DateTimeFormat(opts.locale ?? deviceLocale(), options).format(d);
  } catch {
    // An unknown locale or time zone: English in the device's zone.
    return new Intl.DateTimeFormat('en', o).format(d);
  }
}

/** A time of day ("21:40" in en-GB, "9:40 PM" in en-US). */
export function formatTime(at: number | Date, opts: FormatOptions = {}): string {
  return format(at, { hour: 'numeric', minute: '2-digit' }, opts);
}

/** A weekday and a time ("Thu 21:14" in en-GB). */
export function formatDayTime(at: number | Date, opts: FormatOptions = {}): string {
  return format(at, { weekday: 'short', hour: 'numeric', minute: '2-digit' }, opts);
}

/**
 * A plan's service date (`YYYY-MM-DD`, a calendar date with no zone) as "Sun 22 Nov" in en-GB. Anything else
 * is shown as it is, cut to 40 characters (hub data).
 */
export function formatDate(day: string, opts: Omit<FormatOptions, 'timeZone'> = {}): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day.slice(0, 40);
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return format(at, { weekday: 'short', day: 'numeric', month: 'short' }, { ...opts, timeZone: 'UTC' });
}

/**
 * The compact layout's tab model (design/28 decision 4, §2.2; src/views/compact/tabs.ts): which tab a route
 * belongs to, detail screens, where Back leads and when it is the browser's own back.
 */
import { describe, expect, it } from 'vitest';
import { parseRoute, type Route } from '../src/lib/route.ts';
import {
  backTarget,
  isDetail,
  nextTrail,
  parentOf,
  sameScreen,
  tabOf,
  type Trail,
} from '../src/views/compact/tabs.ts';

const r = (hash: string): Route => parseRoute(hash)!;

describe('tabOf and isDetail', () => {
  it('maps the compact routes to their tabs', () => {
    expect(tabOf(r('#/playlists'))).toBe('plans');
    expect(tabOf(r('#/playlists/p1'))).toBe('plans');
    expect(tabOf(r('#/library'))).toBe('library');
    expect(tabOf(r('#/previews/s1'))).toBe('library');
    expect(tabOf(r('#/previews/s1/sl2'))).toBe('library');
    expect(tabOf(r('#/library/media'))).toBe('media');
    expect(tabOf(r('#/library/themes'))).toBeUndefined();
    expect(tabOf(r('#/settings/general'))).toBeUndefined();
  });

  it('a plan and a presentation’s previews are detail screens', () => {
    expect(isDetail(r('#/playlists/p1'))).toBe(true);
    expect(isDetail(r('#/previews/s1'))).toBe(true);
    expect(isDetail(r('#/playlists'))).toBe(false);
    expect(isDetail(r('#/library'))).toBe(false);
    expect(isDetail(r('#/library/media'))).toBe(false);
  });
});

describe('Back', () => {
  it('leads to the list of the tab', () => {
    expect(parentOf(r('#/playlists/p1'))).toEqual({ name: 'playlists' });
    expect(parentOf(r('#/previews/s1/sl2'))).toEqual({ name: 'library', tab: 'presentations' });
  });

  it('is the browser’s back when the previous screen was the parent (or the plan a preview came from)', () => {
    expect(backTarget(r('#/previews/s1'), r('#/library'))).toBe('history');
    expect(backTarget(r('#/playlists/p1'), r('#/playlists'))).toBe('history');
    expect(backTarget(r('#/previews/s1'), r('#/playlists/p1'))).toBe('history');
  });

  it('replaces with the parent after a deep link, a reload or another tab', () => {
    expect(backTarget(r('#/previews/s1'), undefined)).toEqual({ name: 'library', tab: 'presentations' });
    expect(backTarget(r('#/previews/s1'), r('#/library/media'))).toEqual({
      name: 'library',
      tab: 'presentations',
    });
    expect(backTarget(r('#/playlists/p1'), r('#/library'))).toEqual({ name: 'playlists' });
  });

  it('the trail keeps the previous screen across slides of the same previews', () => {
    let trail: Trail = {};
    for (const h of ['#/library', '#/previews/s1', '#/previews/s1/sl2', '#/previews/s1/sl3'])
      trail = nextTrail(trail, r(h));
    expect(trail.previous).toEqual(r('#/library'));
    expect(backTarget(trail.current!, trail.previous)).toBe('history');
    expect(sameScreen(r('#/previews/s1/a'), r('#/previews/s2/a'))).toBe(false);
    expect(sameScreen(r('#/library'), r('#/library/media'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '@ordo/live-state';
import type { OutputHealthEntry } from '@ordo/protocol';
import { parseLyrics, songFromParsed } from '@ordo/domain';
import { DoublePressGuard } from '../src/lib/confirm.ts';
import { allowedForRole, parseRoute, routeHash } from '../src/lib/route.ts';
import { armDot, cacheSummary, outputDot } from '../src/lib/health.ts';
import { deckView } from '../src/lib/deckView.ts';
import { applyLibraryDelta, type LibraryData } from '../src/lib/libraryData.ts';
import { swSource } from '../src/sw/template.ts';

function entry(p: Partial<OutputHealthEntry> = {}): OutputHealthEntry {
  return {
    outputId: 'o',
    connected: true,
    lastSeen: Date.now(),
    presented: 1,
    missed: 0,
    longTasks: 0,
    lateFlips: 0,
    cache: { ready: 1, total: 1 },
    gpuLost: 0,
    videoDropped: 0,
    ...p,
  };
}

describe('clear-all double press', () => {
  it('fires on the second press within 2 s only', () => {
    const g = new DoublePressGuard();
    expect(g.press(0)).toBe(false);
    expect(g.pendingUntil(500)).toBe(2000);
    expect(g.press(1500)).toBe(true);
    expect(g.pendingUntil(1600)).toBeUndefined();
    expect(g.press(5000)).toBe(false);
    expect(g.press(7500)).toBe(false);
    expect(g.press(8000)).toBe(true);
  });
});

describe('routes', () => {
  it('parses and formats hash routes', () => {
    expect(parseRoute('')).toEqual({ name: 'live' });
    expect(parseRoute('#/edit/abc')).toEqual({ name: 'edit', id: 'abc' });
    expect(parseRoute('#/settings/midi')).toEqual({ name: 'settings', page: 'midi' });
    expect(parseRoute('#/settings/bogus')).toEqual({ name: 'settings', page: 'outputs' });
    expect(parseRoute('#/library/media')).toEqual({ name: 'library', tab: 'media' });
    expect(parseRoute('#/nope')).toBeNull();
    expect(routeHash({ name: 'playlists', id: 'x y' })).toBe('#/playlists/x%20y');
    expect(allowedForRole({ name: 'live' }, 'edit')).toBe(false);
    expect(allowedForRole({ name: 'edit', id: 'a' }, 'edit')).toBe(true);
  });
});

describe('health dots', () => {
  it('derives output and arm colours', () => {
    expect(outputDot(undefined)).toBe('red');
    expect(outputDot(entry())).toBe('green');
    expect(outputDot(entry({ cache: { ready: 1, total: 3 } }))).toBe('amber');
    const s = { ...initialState(), armed: 2 };
    expect(armDot(entry({ armed: 2, armedOk: true }), 2, s)).toBe('green');
    expect(armDot(entry({ armed: 2, armedOk: false }), 2, s)).toBe('red');
    expect(armDot(entry({ armed: 1 }), 2, s)).toBe('amber');
    expect(armDot(entry({ connected: false }), 2, s)).toBe('grey');
    expect(cacheSummary([entry({ cache: { ready: 2, total: 4 } })], { ready: 3, total: 4 }).frac).toBe(0.5);
  });
});

describe('deck view', () => {
  it('lists sections and highlights the live one', () => {
    const p = songFromParsed(parseLyrics('Verse 1\na\n\nChorus\nb'));
    let s = reduce(initialState(), {
      k: 'goLive',
      resolved: {
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'x',
          items: [{ id: 'i', kind: 'presentation', presentationId: p.id }],
        },
        presentations: { [p.id]: p },
        media: {},
        fonts: [],
        looks: [],
        files: [],
        manifestId: 'm',
      },
    });
    s = reduce(s, { k: 'go', cueIndex: 1, at: 1 });
    const v = deckView(s, true);
    expect(v.sections.map((x) => x.short)).toEqual(['V1', 'C']);
    expect(v.liveSectionPos).toBe(1);
  });
});

describe('library deltas', () => {
  it('upserts, deletes and updates settings keys', () => {
    const d = {
      seq: 1,
      presentations: [],
      playlists: [{ id: 'a', rev: 1, name: 'A', items: [] }],
      media: [],
      fonts: [],
      themes: [],
      folders: [],
      settings: { general: { venueName: 'x' } } as unknown as LibraryData['settings'],
      jobs: {},
    } as LibraryData;
    const r = applyLibraryDelta(d, [
      { kind: 'playlist', id: 'a', deleted: true },
      { kind: 'playlist', id: 'b', entity: { id: 'b', rev: 1, name: 'B', items: [] } },
      { kind: 'settings', id: 'general', entity: { venueName: 'y' } },
      { kind: 'settings', id: 'weird' },
    ]);
    expect(r.data.playlists.map((p) => p.id)).toEqual(['b']);
    expect(r.data.settings.general.venueName).toBe('y');
    expect(r.refetchSettings).toBe(true);
    expect(d.playlists).toHaveLength(1);
  });
});

describe('service worker', () => {
  it('never caches /api or /ws', () => {
    const src = swSource(['index.html', 'assets/a.js'], 'v1');
    expect(src).toContain("url.pathname.includes('/api/')");
    expect(src).toContain('"assets/a.js"');
    expect(() => new Function(src)).not.toThrow();
  });
});

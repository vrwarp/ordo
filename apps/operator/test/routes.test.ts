/**
 * Route decisions (design/28 §2.1, §3.1 "Routes"; lib/route.ts pageFor, compactRedirect): on the regular
 * layout and not restricted, exactly the rules App applied before the registry; on the compact layout or a
 * phone (restricted), never the editor, the live view, the settings, Setup, Themes, Fonts or Import, and every
 * redirect replaces the history entry.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedForRole,
  compactRedirect,
  type PageDecision,
  pageFor,
  parseRoute,
  type Route,
  routeHash,
  SETTINGS_PAGES,
} from '../src/lib/route.ts';

const ROUTES: Route[] = [
  { name: 'live' },
  ...(['presentations', 'media', 'themes', 'fonts', 'import'] as const).map(
    (tab): Route => ({ name: 'library', tab }),
  ),
  { name: 'edit', id: 'song-1' },
  { name: 'playlists' },
  { name: 'playlists', id: 'pl-1' },
  ...SETTINGS_PAGES.map((page): Route => ({ name: 'settings', page })),
  { name: 'setup' },
  { name: 'checklist' },
  { name: 'previews' },
  { name: 'previews', id: 'song-1' },
  { name: 'previews', id: 'song-1', slideId: 's2' },
];
const ROLES = ['operate', 'edit'] as const;
const PROFILES = ['full', 'edit'] as const;
const LIBRARY: Route = { name: 'library', tab: 'presentations' };

/** App.tsx at d0f49cb: the redirect effect (allowedForRole) and the body switch, with the body skipped. */
function before(r: Route, role: 'operate' | 'edit', profile: 'full' | 'edit'): PageDecision {
  if (!allowedForRole(r, role, profile)) return { page: null, redirect: LIBRARY, replace: false };
  switch (r.name) {
    case 'live':
      return role === 'operate' && profile === 'full' ? { page: 'live', props: {} } : { page: null };
    case 'library':
      return { page: 'library', props: { tab: r.tab } };
    case 'edit':
      return { page: 'edit', props: { id: r.id } };
    case 'playlists':
      return { page: 'playlists', props: { id: r.id } };
    case 'settings':
      return role === 'operate' ? { page: 'settings', props: { page: r.page } } : { page: null };
    case 'setup':
    case 'checklist':
      return { page: 'setup', props: {} };
    case 'previews':
      return { page: 'previews', props: { id: r.id, slideId: r.slideId } };
  }
}

const NEVER_COMPACT = new Set(['edit', 'live', 'settings', 'setup']);

describe('pageFor', () => {
  it('regular and not restricted: today’s rules for every route, role and profile', () => {
    for (const r of ROUTES)
      for (const role of ROLES)
        for (const profile of PROFILES)
          expect(
            pageFor(r, { role, profile, layout: 'regular', restricted: false }),
            JSON.stringify(r),
          ).toEqual(before(r, role, profile));
  });

  it('compact or restricted: no editor, live view, settings, Setup, Themes, Fonts or Import; redirects replace', () => {
    for (const r of ROUTES)
      for (const role of ROLES)
        for (const profile of PROFILES)
          for (const [layout, restricted] of [
            ['compact', false],
            ['compact', true],
            ['regular', true],
          ] as const) {
            const d = pageFor(r, { role, profile, layout, restricted });
            const at = `${routeHash(r)} ${role} ${profile} ${layout} ${restricted}`;
            if (d.page) {
              expect(NEVER_COMPACT.has(d.page), at).toBe(false);
              if (d.page === 'library') expect(['presentations', 'media'], at).toContain(d.props.tab);
              if (d.page === 'previews') expect(d.props.id, at).toBeTruthy();
            } else if ('redirect' in d) {
              expect(d.replace, at).toBe(true);
              expect(d.redirect, at).toEqual(compactRedirect(r));
            } else throw new Error(`${at}: renders nothing without a redirect`);
          }
  });

  it('the canvas editor goes to the presentation’s previews; refused pages to the Library', () => {
    const ctx = { role: 'operate', profile: 'edit', layout: 'compact', restricted: true } as const;
    expect(pageFor({ name: 'edit', id: 'a/b' }, ctx)).toEqual({
      page: null,
      redirect: { name: 'previews', id: 'a/b' },
      replace: true,
    });
    for (const hash of [
      '#/settings/general',
      '#/settings/pins',
      '#/setup',
      '#/checklist',
      '#/live',
      '#/library/themes',
      '#/library/fonts',
      '#/library/import',
      '#/previews',
      '#/settings/themes',
    ])
      expect(compactRedirect(parseRoute(hash)!), hash).toEqual(LIBRARY);
    for (const hash of ['#/library', '#/library/media', '#/playlists', '#/playlists/x', '#/previews/x/y'])
      expect(compactRedirect(parseRoute(hash)!), hash).toBeNull();
  });

  it('the venue PC is never restricted by the layout of its window (decided by layoutFor)', () => {
    // A full-profile route set on the regular layout keeps the live view and Setup.
    const ctx = { role: 'operate', profile: 'full', layout: 'regular', restricted: false } as const;
    expect(pageFor({ name: 'live' }, ctx).page).toBe('live');
    expect(pageFor({ name: 'setup' }, ctx).page).toBe('setup');
    expect(pageFor({ name: 'settings', page: 'outputs' }, ctx).page).toBe('settings');
  });
});

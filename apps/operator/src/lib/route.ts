export type Route =
  | { name: 'live' }
  | { name: 'library'; tab: 'presentations' | 'media' | 'themes' | 'fonts' | 'import' }
  | { name: 'edit'; id: string }
  | { name: 'playlists'; id?: string }
  | { name: 'settings'; page: string }
  | { name: 'setup' }
  | { name: 'checklist' }
  | { name: 'previews'; id?: string; slideId?: string };

export const SETTINGS_PAGES = [
  'outputs',
  'looks',
  'audio',
  'keys',
  'streamdeck',
  'midi',
  'messages',
  'general',
  'pins',
  'backups',
  'diagnostics',
] as const;

/** Parse a location hash like `#/edit/01H...` into a route. Unknown hashes yield null. */
export function parseRoute(hash: string): Route | null {
  const parts = hash
    .replace(/^#\/?/, '')
    .split('?')[0]!
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  const [head, a] = parts;
  switch (head) {
    case undefined:
    case 'live':
      return { name: 'live' };
    case 'library': {
      const tab = a === 'media' || a === 'themes' || a === 'fonts' || a === 'import' ? a : 'presentations';
      return { name: 'library', tab };
    }
    case 'edit':
      return a ? { name: 'edit', id: a } : null;
    case 'playlists':
      return { name: 'playlists', id: a };
    case 'settings':
      if (a === 'themes') return { name: 'library', tab: 'themes' };
      return {
        name: 'settings',
        page: a && (SETTINGS_PAGES as readonly string[]).includes(a) ? a : 'outputs',
      };
    case 'setup':
    case 'checklist':
      return { name: 'setup' };
    case 'previews':
      return { name: 'previews', id: a, slideId: parts[2] };
    default:
      return null;
  }
}

export function routeHash(r: Route): string {
  switch (r.name) {
    case 'live':
      return '#/live';
    case 'library':
      return r.tab === 'presentations' ? '#/library' : `#/library/${r.tab}`;
    case 'edit':
      return `#/edit/${encodeURIComponent(r.id)}`;
    case 'playlists':
      return r.id ? `#/playlists/${encodeURIComponent(r.id)}` : '#/playlists';
    case 'settings':
      return `#/settings/${r.page}`;
    case 'setup':
      return '#/setup';
    case 'checklist':
      return '#/setup';
    case 'previews':
      return `#/previews${r.id ? `/${encodeURIComponent(r.id)}` : ''}${r.id && r.slideId ? `/${encodeURIComponent(r.slideId)}` : ''}`;
  }
}

/** Settings pages that make sense on an edit-profile device (no outputs, audio devices, keys or backups). */
export const EDIT_PROFILE_SETTINGS: readonly string[] = ['looks', 'messages', 'general', 'pins'];

/**
 * Routes a role may open on a device of this profile; everything else redirects to the library. An
 * edit-profile device (an iPad) never opens the live view or the checklist, and only the settings pages
 * in EDIT_PROFILE_SETTINGS.
 */
export function allowedForRole(
  r: Route,
  role: 'operate' | 'edit',
  profile: 'full' | 'edit' = 'full',
): boolean {
  if (r.name === 'library' || r.name === 'edit' || r.name === 'playlists' || r.name === 'previews')
    return true;
  if (role !== 'operate') return false;
  if (profile === 'full') return true;
  return r.name === 'settings' && EDIT_PROFILE_SETTINGS.includes(r.page);
}

/** What a page key names: the regular bodies App renders (lib/route.ts is pure; src/pages.ts loads them). */
export type PageKey = 'library' | 'live' | 'edit' | 'playlists' | 'previews' | 'settings' | 'setup';

type LibraryTab = Extract<Route, { name: 'library' }>['tab'];

/** The page a route shows, with the props its body takes. */
export type PageChoice =
  | { page: 'library'; props: { tab: LibraryTab } }
  | { page: 'live'; props: Record<string, never> }
  | { page: 'edit'; props: { id: string } }
  | { page: 'playlists'; props: { id?: string } }
  | { page: 'previews'; props: { id?: string; slideId?: string } }
  | { page: 'settings'; props: { page: string } }
  | { page: 'setup'; props: Record<string, never> };

/**
 * pageFor's answer: a page to render, a redirect (with `replace`: no history entry, decided during render so
 * the refused page's chunk is never requested), or nothing.
 */
export type PageDecision = PageChoice | { page: null; redirect: Route; replace: boolean } | { page: null };

const LIBRARY: Route = { name: 'library', tab: 'presentations' };

/**
 * Where a route goes on the compact layout or on a phone (design/28 §2.1, §3.1): Setup and the checklist,
 * every settings page, the live view, the Themes, Fonts and Import tabs and the Previews page without a
 * presentation go to the Library; the canvas editor goes to the presentation's previews (owner question 6;
 * P1 moves it to #/view, P2 to the words editor). Null: the route opens as it is.
 */
export function compactRedirect(r: Route): Route | null {
  switch (r.name) {
    case 'settings':
    case 'setup':
    case 'checklist':
    case 'live':
      return LIBRARY;
    case 'library':
      return r.tab === 'themes' || r.tab === 'fonts' || r.tab === 'import' ? LIBRARY : null;
    case 'previews':
      return r.id ? null : LIBRARY;
    case 'edit':
      return { name: 'previews', id: r.id };
    case 'playlists':
      return null;
  }
}

/**
 * The page for a route (App renders it; design/28 §3.1 "Routes"). On the compact layout, or when `restricted`
 * (a phone on either layout, Safari's "Request Desktop Website" included; the shell adds a capped session),
 * compactRedirect wins and its redirect replaces the history entry; what stays is the Library (Presentations
 * and Media), the playlists and a presentation's previews. Otherwise today's rules, unchanged: allowedForRole
 * (a refused route renders nothing and is pushed to the Library), the settings for the operate role only,
 * the live view for the operate role on the full profile only.
 */
export function pageFor(
  r: Route,
  ctx: {
    role: 'operate' | 'edit';
    profile: 'full' | 'edit';
    layout: 'compact' | 'regular';
    restricted: boolean;
  },
): PageDecision {
  if (ctx.layout === 'compact' || ctx.restricted) {
    const target = compactRedirect(r);
    if (target) return { page: null, redirect: target, replace: true };
  } else if (!allowedForRole(r, ctx.role, ctx.profile))
    return { page: null, redirect: LIBRARY, replace: false };
  switch (r.name) {
    case 'live':
      return ctx.role === 'operate' && ctx.profile === 'full' ? { page: 'live', props: {} } : { page: null };
    case 'library':
      return { page: 'library', props: { tab: r.tab } };
    case 'edit':
      return { page: 'edit', props: { id: r.id } };
    case 'playlists':
      return { page: 'playlists', props: { id: r.id } };
    case 'settings':
      return ctx.role === 'operate' ? { page: 'settings', props: { page: r.page } } : { page: null };
    case 'setup':
    case 'checklist':
      return { page: 'setup', props: {} };
    case 'previews':
      return { page: 'previews', props: { id: r.id, slideId: r.slideId } };
  }
}

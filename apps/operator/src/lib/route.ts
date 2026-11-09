export type Route =
  | { name: 'live' }
  | { name: 'library'; tab: 'presentations' | 'media' | 'fonts' | 'import' }
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
  'themes',
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
      const tab = a === 'media' || a === 'fonts' || a === 'import' ? a : 'presentations';
      return { name: 'library', tab };
    }
    case 'edit':
      return a ? { name: 'edit', id: a } : null;
    case 'playlists':
      return { name: 'playlists', id: a };
    case 'settings':
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
export const EDIT_PROFILE_SETTINGS: readonly string[] = ['looks', 'messages', 'general', 'themes', 'pins'];

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

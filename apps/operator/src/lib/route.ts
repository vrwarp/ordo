export type Route =
  | { name: 'live' }
  | { name: 'library'; tab: 'presentations' | 'media' | 'fonts' | 'import' }
  | { name: 'edit'; id: string }
  | { name: 'playlists'; id?: string }
  | { name: 'settings'; page: string }
  | { name: 'checklist' };

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
    case 'checklist':
      return { name: 'checklist' };
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
    case 'checklist':
      return '#/checklist';
  }
}

/** Routes the edit role may open; everything else redirects to the library. */
export function allowedForRole(r: Route, role: 'operate' | 'edit'): boolean {
  if (role === 'operate') return true;
  return r.name === 'library' || r.name === 'edit' || r.name === 'playlists';
}

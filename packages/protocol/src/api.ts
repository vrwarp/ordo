/**
 * HTTP API contract between the browser apps and the hub. Every role host (op, outN, stage, hub, or
 * localhost in dev) serves `/api/v1/*` and `/ws`, so apps always call their own origin.
 * Output and stage windows authenticate with the `x-ordo-token` header (or `?token=` on /ws and /files);
 * operate and edit roles use the `ordo_session` cookie obtained from POST /auth/pin.
 * Errors: non-2xx with `{ error: { code: string, message: string } }`.
 */
import type {
  AudioSettings,
  Font,
  GeneralSettings,
  KeyMap,
  Look,
  Media,
  Output,
  Playlist,
  Presentation,
  SurfaceSettings,
  Theme,
  ResolvedPlaylist,
  LiveState,
} from '@ordo/domain';
import type { Role } from './index.ts';

export const API_PREFIX = '/api/v1';

export type ApiError = { error: { code: string; message: string } };

export type AuthPinReq = { pin: string; remember?: boolean };
export type AuthPinRes = { role: 'operate' | 'edit' };
export type AuthMeRes = { role: Role | null; setupRequired: boolean; version: string; domain: string };
export type SetupReq = { operatePin: string; editPin: string };

export type Folder = { id: string; name: string; parentId?: string };
export type Job = {
  id: string;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  log: string[];
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

/** GET /library/snapshot */
export type LibrarySnapshot = {
  seq: number;
  presentations: Presentation[];
  playlists: Playlist[];
  media: Media[];
  fonts: Font[];
  themes: Theme[];
  folders: Folder[];
  settings: Settings;
};

/** All settings documents. GET /settings returns this; PUT /settings/:key replaces one key. */
export type Settings = {
  general: GeneralSettings;
  looks: Look[];
  outputs: Output[];
  audio: AudioSettings;
  keymap: KeyMap;
  surfaces: SurfaceSettings;
};
export type SettingsKey = keyof Settings;

export type RevisionInfo = { rev: number; savedAt: string; savedBy?: string; title: string };

/** GET /live returns the full state; outputs use it on start. */
export type LiveRes = { seq: number; state: LiveState };

/** GET /cache/manifest */
export type ManifestRes = {
  manifestId: string;
  files: { hash: string; bytes: number; mime: string }[];
  resolved: ResolvedPlaylist;
} | null;

/** GET /fonts/google/search?q= */
export type GoogleFontFamily = { family: string; category?: string; variants?: string[] };

/** POST /media (multipart field "file", optional fields name, isBackground) -> Media */
/** POST /fonts/upload (multipart "file") -> Font[] */
/** POST /fonts/google { family } -> Job */
/** POST /import/pro7 (multipart zip "file", or JSON { path }) -> Job */
/** POST /import/songselect (multipart "file" or JSON { text, title? }) -> Presentation */
/** POST /import/document (multipart pptx/pdf "file") -> Job whose result is { presentationId } */
/** POST /presentations/:id/slides/:slideId/make-editable -> Presentation */
/** GET /files/:hash -> bytes (range supported). Output/stage need ?token= or header. */
/** POST /outputs/:id/token/rotate -> Output (with token) */
/** POST /actions { id, arg? } (operate) -> LiveAck-like { seq } ; the HTTP bridge for surfaces and tests. */
/** POST /backup/run -> { file } ; GET /backup/list -> { files: string[] } */
/** GET /diagnostics/export -> application/zip */
/** GET /health -> { ok: true, version, uptimeS, seq, mode } */

export const ROUTES = {
  me: '/auth/me',
  pin: '/auth/pin',
  logout: '/auth/logout',
  setup: '/auth/setup',
  snapshot: '/library/snapshot',
  presentations: '/presentations',
  playlists: '/playlists',
  media: '/media',
  fonts: '/fonts',
  themes: '/themes',
  folders: '/folders',
  settings: '/settings',
  live: '/live',
  manifest: '/cache/manifest',
  jobs: '/jobs',
  actions: '/actions',
  health: '/health',
} as const;

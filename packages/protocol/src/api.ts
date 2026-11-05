/**
 * HTTP API contract between the browser apps and the hub. Every role host (op, outN, stage, hub, or
 * localhost in dev) serves `/api/v1/*` and `/ws`, so apps always call their own origin.
 * Output and stage windows authenticate with the `x-ordo-token` header (or `?token=` on /ws and /files);
 * operate and edit roles use the `ordo_session` cookie obtained from POST /auth/pin.
 * Errors: non-2xx with `{ error: { code: string, message: string } }`.
 */
import {
  AudioSettings,
  type Font,
  GeneralSettings,
  KeyMap,
  Look,
  type Media,
  Output,
  type Playlist,
  type Presentation,
  SurfaceSettings,
  type Theme,
  type ResolvedPlaylist,
  type LiveState,
  type GeneralSettings as General,
} from '@ordo/domain';
import type { Role } from './index.ts';
import { z } from 'zod';

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

/**
 * GET /library/snapshot?since=<seq>: the changes after `since`, when the hub still has them. Entities are
 * carried in full (deleted ones have `deleted: true`); `job` changes are not library content and are left
 * out. When `since` is absent, ahead of the hub or older than the retained change log, the hub answers with
 * a full LibrarySnapshot instead (distinguish by the `changes` key).
 */
export type LibrarySnapshotDelta = {
  seq: number;
  since: number;
  changes: {
    kind: 'presentation' | 'playlist' | 'media' | 'font' | 'theme' | 'settings' | 'folder';
    id: string;
    rev?: number;
    entity?: unknown;
    deleted?: boolean;
  }[];
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

/**
 * PUT /settings/:key bodies (design/25): strict at the top level (unknown keys are refused); list settings
 * are strict per element. Shared by the hub and the browser demo (apps/demo) so both accept the same.
 */
export const SETTINGS_BODY: Record<SettingsKey, z.ZodType> = {
  general: GeneralSettings.strict(),
  looks: z.array(Look.strict()).max(100),
  // A new output arrives with an empty id; the hub assigns one.
  outputs: z.array(Output.extend({ id: z.string().max(200) }).strict()).max(32),
  audio: AudioSettings.strict(),
  keymap: KeyMap,
  surfaces: SurfaceSettings.strict(),
};

export type RevisionInfo = { rev: number; savedAt: string; savedBy?: string; title: string };

/** GET /live returns the full state; outputs use it on start. */
export type LiveRes = { seq: number; state: LiveState };

/**
 * GET /live/summary (edit or operate session): what an edit-profile device (an iPad) needs to know about
 * the service running at the venue, without the full live state or any token: the live playlist, the
 * label of the live cue and the presentations the hub locks (it refuses saves to them with 423).
 */
export const LiveSummaryRes = z
  .object({
    seq: z.number().int(),
    mode: z.enum(['idle', 'live']),
    playlistId: z.string().max(200).optional(),
    playlistName: z.string().max(1000).optional(),
    liveLabel: z.string().max(1000).optional(),
    lockedPresentationIds: z.array(z.string().max(200)).max(10_000),
  })
  .strict();
export type LiveSummaryRes = z.infer<typeof LiveSummaryRes>;

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

/**
 * GET /output/config (output or stage token): what a role window needs that is not live state.
 * The token's Output record (without its token), all looks, audio and general settings, and the logo media.
 * Hub broadcasts `library.delta` with kind 'settings' when any of these change; windows refetch.
 */
export type OutputConfigRes = {
  output: Output;
  looks: Look[];
  audio: AudioSettings;
  general: General;
  logo?: Media;
  fonts: Font[];
};

export const ROUTES = {
  outputConfig: '/output/config',
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
  liveSummary: '/live/summary',
  manifest: '/cache/manifest',
  jobs: '/jobs',
  actions: '/actions',
  health: '/health',
} as const;

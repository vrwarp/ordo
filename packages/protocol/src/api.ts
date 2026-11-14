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
/** POST /import/pro7 (multipart "file" .pro/.probundle/.proplaylist/.zip, or JSON { path }) -> Job */
/** POST /import/songselect (multipart "file" or JSON { text, title? }) -> Presentation */
/**
 * POST /import/document (multipart pptx/pdf "file"; optional fields "renderer" native|libreoffice|pptx-preview,
 * native by default, and the native import's "extendBackgrounds", "transitionSounds" 1|0) -> Job: 'pptx-native'
 * (editable slides, design/27) or 'document' (page pictures), whose result has { presentationId }.
 */
/**
 * POST /presentations/:id/slides/:slideId/make-editable -> Presentation (text boxes over the page picture), or
 * 202 Job 'pptx-reimport' for a legacy PowerPoint page whose deck is stored (rebuilt natively, design/27 §11)
 */
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

/**
 * 'Re-import from PowerPoint' (design/27 §11 "Round trip and migration", M4 item F; the hub's
 * `pptx/reimport.ts`): the native import is run again on the presentation's stored deck and merged into it as
 * a new revision. Refused while the presentation is live-locked (423) and when it has no stored deck (400
 * `no_pptx`).
 *
 * POST /presentations/:id/pptx-reimport  PptxReimportReq -> 202 Job (kind 'pptx-reimport', light; its result
 *   is a PptxReimportResult)
 * GET  /presentations/:id/pptx-reimport  -> PptxReimportPlan (what a re-import would do; nothing is written)
 */
export type PptxReimportReq = {
  /** Only these slides (ids): 'Make editable' or 'Reset slide' on one slide. Absent: every slide. */
  slideIds?: string[];
  /**
   * Slides regenerated even though they were edited ('Reset slide from PowerPoint'): their imported objects
   * are replaced; the operator's own objects (no `origin`) stay, on top.
   */
  reset?: string[];
  /** Made-editable slides the dialog was told to keep as they are. */
  keep?: string[];
};

/**
 * How a re-import treats a slide of the presentation (design/27 §11):
 * - 'native': a slide of a native import; regenerated while its objects still match `Slide.pptx.digest`;
 * - 'page': a legacy picture slide (`imported`); replaced by the native slide;
 * - 'made-editable': a legacy slide made editable (its bottom object the page picture); its page picture
 *   and the text boxes equal to extracted text are replaced, unless kept;
 * - 'other': any other slide (typed in ordo, or one the deck no longer has); kept as it is.
 */
export type PptxReimportKind = 'native' | 'page' | 'made-editable' | 'other';

/** What a re-import does to one slide. */
export type PptxReimportAction = 'regenerate' | 'keep-edited' | 'replace' | 'keep';

export type PptxReimportPlanSlide = {
  slideId: string;
  /** 1-based position in the presentation's authoring order (as the editor numbers slides). */
  number: number;
  kind: PptxReimportKind;
  action: PptxReimportAction;
  /** Objects the operator added in ordo (no `origin`, or on top of a legacy page), kept on top. */
  userObjects: number;
};

export type PptxReimportPlan = {
  presentationId: string;
  /** The stored deck (`Presentation.source.fileId`). */
  fileId: string;
  slides: PptxReimportPlanSlide[];
};

/** The `pptx-reimport` job's result (read defensively by the operator, as every job result is). */
export type PptxReimportResult = {
  presentationId: string;
  /** The revision the re-import saved; absent when it changed nothing (nothing is saved then). */
  rev?: number;
  regenerated: number;
  /** Edited native slides left as they are (their objects no longer match the digest). */
  keptEdited: number;
  /** Legacy page and made-editable slides replaced by native slides. */
  replaced: number;
  /** Objects the operator added, kept on top of their slides. */
  userObjects: number;
};

/** The states of a server tool the hub may use (design/27 M9, the hub's `tools.ts`). */
export const HUB_TOOL_STATES = ['checking', 'available', 'absent', 'off', 'broken'] as const;

/**
 * GET /capabilities (edit role, the library process; design/27 M9 "LibreOffice optional"): what this hub's
 * server tools allow, so the operator offers only what works. Parsed with `.catch` defaults everywhere, so an
 * operator reads whatever a newer or older hub sends; the tool's version is never in the public `/health`.
 * - `libreoffice`: 'available' (with its version), 'absent' (not installed), 'off' (`ORDO_LIBREOFFICE=off`),
 *   'broken' (installed but its version command fails), 'checking' (the hub is still asking, just after start).
 * - `pdf`: pdftoppm (poppler-utils) is there: PDF import.
 * - `documents`: the extensions `POST /import/document` accepts.
 * - `pptx.pictures`: 'Pictures (LibreOffice)'; `pptx.reference`: 'Show original' drawn by LibreOffice;
 *   `pptx.referencePdf`: reference pictures from PowerPoint's own PDF export (poppler-utils only);
 *   `pptx.art`: LibreOffice draws what ordo cannot (the `pptx-lo` follow-up). Without it the import lists
 *   what it could not draw (`Slide.pptx.missing`).
 *
 * POST /presentations/:id/pptx-reference with a JSON body needs `pptx.reference` (else 501
 * `libreoffice_unavailable`); as multipart with one PDF (field `file`, optional field `showPicture`: a JSON
 * array of slide ids) it needs `pptx.referencePdf` (else 501 `pdf_unavailable`). POST /import/document answers
 * 501 `libreoffice_unavailable` for `renderer=libreoffice` without LibreOffice, 501 `pdf_unavailable` for a
 * PDF without pdftoppm, and 415 `unsupported` with a save-as hint for .ppt, .pps, .odp and .key files. Both
 * answer 503 with `Retry-After` while LibreOffice is still being checked (`libreoffice_checking`) or does not
 * answer (`libreoffice_not_answering`, state 'broken'): it may be there in a minute.
 */
export const HubCapabilities = z.object({
  libreoffice: z
    .object({
      state: z.enum(HUB_TOOL_STATES).catch('absent'),
      version: z.string().max(100).optional().catch(undefined),
    })
    .catch({ state: 'absent' }),
  pdf: z.boolean().catch(false),
  documents: z.array(z.string().max(8)).max(16).catch(['pptx', 'pdf']),
  pptx: z
    .object({
      pictures: z.boolean().catch(false),
      reference: z.boolean().catch(false),
      referencePdf: z.boolean().catch(false),
      art: z.boolean().catch(false),
    })
    .catch({ pictures: false, reference: false, referencePdf: false, art: false }),
});
export type HubCapabilities = z.infer<typeof HubCapabilities>;

/** What a hub before M9 can do (it answers GET /capabilities with 404): it always had LibreOffice. */
export const LEGACY_CAPABILITIES: HubCapabilities = {
  libreoffice: { state: 'available' },
  pdf: true,
  documents: ['pptx', 'pdf'],
  pptx: { pictures: true, reference: true, referencePdf: false, art: true },
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
  capabilities: '/capabilities',
} as const;

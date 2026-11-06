import { createWriteStream } from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import {
  ActionId,
  DEFAULT_THEME,
  LiveCommand,
  type LiveState,
  type Media,
  newId,
  type Output,
  Playlist,
  Presentation,
  Theme,
} from '@ordo/domain';
import { actionToEvent } from '@ordo/live-state';
import {
  API_PREFIX,
  APP_VERSION,
  type AuthMeRes,
  COOKIE_SESSION,
  LiveSummaryRes,
  type ManifestRes,
  type OutputConfigRes,
  type OutputHealthEntry,
  SETTINGS_BODY,
  type Settings,
  type SettingsKey,
} from '@ordo/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods, RouteHandlerMethod } from 'fastify';
import JSZip from 'jszip';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Access, Auth, Principal } from './auth.ts';
import type { Backups } from './backup.ts';
import type { HubConfig } from './config.ts';
import { badRequest, conflict, HttpError, locked, notFound, unauthorized } from './errors.ts';
import type { FontService } from './fonts/service.ts';
import type { ImportService } from './imports.ts';
import type { JobQueue } from './jobs.ts';
import { FolderSchema, type Library, newToken, SETTINGS_KEYS, stripTokens } from './library.ts';
import { LiveRejection, type LiveService } from './live.ts';
import type { LogRing } from './log.ts';
import type { MediaService } from './media/service.ts';
import type { Store } from './store.ts';
import { searchGoogleFonts } from './fonts/google.ts';
import { PPTX_MIME } from './imports.ts';
import type { PptxImportOptions } from './pptx/shared.ts';
import { sendFile } from './send.ts';
import { extOf, MAX_UPLOAD_BYTES, readHead, sniff } from './store.ts';
import { validate } from './validate.ts';

export const DEVICE_COOKIE = 'ordo_device';

// ---- request bodies (design/25): strict at the top level (unknown keys are refused) and bounded ----
const PinBody = z.object({ pin: z.string().max(64), remember: z.boolean().optional() }).strict();
const SetupBody = z.object({ operatePin: z.string().max(64), editPin: z.string().max(64) }).strict();
const PinsBody = z
  .object({ operatePin: z.string().max(64).optional(), editPin: z.string().max(64).optional() })
  .strict();
const ActionBody = z
  .object({
    id: ActionId,
    arg: z.union([z.number().int().min(-1_000_000).max(1_000_000), z.string().max(500)]).optional(),
  })
  .strict();
const MediaPatch = z
  .object({
    rev: z.number().int().min(0).optional(),
    name: z.string().min(1).max(200).optional(),
    tags: z.array(z.string().max(50)).max(50).optional(),
    loop: z.boolean().optional(),
    isBackground: z.boolean().optional(),
    audio: z
      .object({ pairId: z.string().max(200).optional(), gainDb: z.number().min(-60).max(24).optional() })
      .strict()
      .optional(),
  })
  .strict();
const UploadCreate = z
  .object({
    name: z.string().min(1).max(300),
    size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    isBackground: z.boolean().optional(),
    tags: z.array(z.string().max(50)).max(50).optional(),
  })
  .strict();
/** Server-managed fields a client may echo back with an entity it read; their values are ignored. */
const Meta = {
  rev: z.number().int().min(0).optional(),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
};
const PresentationBody = Presentation.strict();
const PlaylistBody = Playlist.strict();
const ThemeBody = Theme.extend(Meta).strict();
const FolderBody = FolderSchema.extend(Meta).strict();
const SongselectBody = z
  .object({ text: z.string().max(1_000_000), title: z.string().max(300).optional() })
  .strict();
const LiveEventsBody = z.object({ id: z.string().max(200).optional(), event: z.unknown() }).strict();

/**
 * What `POST /import/document` does with a PowerPoint (design/27 §2, §3.2): 'native' (the default) imports
 * editable slides (`pptx-native`); 'libreoffice' and 'pptx-preview' (accepted until design/27 M8 retires it)
 * import one picture per slide (`document`). 'native' exists only in this form field and the job payload:
 * the stored `PptxRenderer` is not widened, and native imports record `source.native` instead.
 */
export const DocumentImportRenderer = z.enum(['native', 'libreoffice', 'pptx-preview']);
export type DocumentImportForm = {
  renderer: z.infer<typeof DocumentImportRenderer>;
  /** The native import's options; only the fields that were sent. */
  options: PptxImportOptions;
};

/** `POST /import/document`'s form fields; an unknown value is refused (400), absent fields are defaults. */
export function documentImportForm(fields: Readonly<Record<string, string>>): DocumentImportForm {
  const own = (k: string) => (Object.hasOwn(fields, k) ? fields[k] : undefined);
  const renderer = DocumentImportRenderer.safeParse(own('renderer') || 'native');
  if (!renderer.success) throw badRequest('renderer must be native, libreoffice or pptx-preview');
  const options: PptxImportOptions = {};
  for (const key of ['extendBackgrounds', 'transitionSounds'] as const) {
    const v = own(key);
    if (v === undefined || v === '') continue;
    if (v === '1' || v === 'true' || v === 'on') options[key] = true;
    else if (v === '0' || v === 'false' || v === 'off') options[key] = false;
    else throw badRequest(`${key} must be 1 or 0`);
  }
  return { renderer: renderer.data, options };
}

/** The live service as the library side sees it: edit locks and the mode (from IPC in the library process). */
export type LiveView = {
  locks(): { playlistId?: string; presentations: Set<string>; media: Set<string> };
  mode(): 'idle' | 'live';
};

/** What the diagnostics export collects from the live side. */
export type LiveDiag = {
  journal: unknown[];
  health: Record<string, OutputHealthEntry>;
  sockets: number;
  seq: number;
  mode: string;
  playlist?: string;
  /** The live process's log lines (two-process mode only). */
  log?: string[];
  extra?: Record<string, unknown>;
};

/** Everything the library API needs. In one process it is the Hub; in the library process, libproc.ts. */
export type LibraryApiCtx = {
  cfg: HubConfig;
  lib: Library;
  auth: Auth;
  store: Store;
  jobs: JobQueue;
  media: MediaService;
  fonts: FontService;
  imports: ImportService;
  backups: Backups;
  log: Logger;
  ring: LogRing;
  live: LiveView;
  /** Close the sockets of an output whose token changed (the live process also notices on its own). */
  disconnectOutput(outputId: string, reason: string): void;
  /** The live side's journal and health for the diagnostics export; undefined when unreachable. */
  liveDiag(): Promise<LiveDiag | undefined>;
  /** Extra fields for hub.json in the diagnostics export (process supervision state). */
  diagExtra?(): Record<string, unknown>;
};

/** Everything the live API needs. */
export type LiveApiCtx = {
  cfg: HubConfig;
  auth: Auth;
  live: LiveService;
  log: Logger;
  outputConfig(outputId: string): OutputConfigRes | undefined;
  /** Extra fields for GET /health (process supervision state). */
  healthExtra?(): Record<string, unknown>;
};

type Ctx = LibraryApiCtx;

type Received = { path: string; hash: string; bytes: number; filename: string };

/** Drain a multipart request: files go to uploads/ (hashed while streaming), fields are collected. */
async function readMultipart(
  hub: Ctx,
  req: FastifyRequest,
  opts: { maxFiles?: number; limit?: number } = {},
): Promise<{ files: Received[]; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw badRequest('Expected multipart/form-data');
  const files: Received[] = [];
  const fields: Record<string, string> = {};
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const f = part as MultipartFile;
        if (files.length >= (opts.maxFiles ?? 50)) {
          f.file.resume();
          throw badRequest('Too many files');
        }
        const r = await hub.store.receive(f.file as Readable, opts.limit ?? MAX_UPLOAD_BYTES);
        files.push({ ...r, filename: f.filename || 'upload' });
      } else {
        fields[part.fieldname] = String((part as { value: unknown }).value ?? '');
      }
    }
  } catch (e) {
    await Promise.all(files.map((f) => rm(f.path, { force: true })));
    const err = e as { code?: string; statusCode?: number };
    if (err.code === 'FST_REQ_FILE_TOO_LARGE')
      throw new HttpError(413, 'too_large', 'File exceeds the 4 GB upload limit');
    throw e;
  }
  return { files, fields };
}

function sessionRole(p: Principal | null): 'operate' | 'edit' | undefined {
  return p?.kind === 'session' ? p.role : undefined;
}

/**
 * GET /live/summary: the venue's service as an edit-profile device needs it (design/15 "iPad editing"): no
 * tokens, no full state. `locked` is what the hub refuses saves to with 423 (LiveService.locks). The output is
 * validated so a change to the live state can never leak more than the contract says.
 */
export function liveSummary(state: LiveState, locked: Iterable<string>): LiveSummaryRes {
  const r = state.mode === 'live' ? state.resolved : undefined;
  const cue = r && state.live !== undefined ? state.cues[state.live] : undefined;
  return LiveSummaryRes.parse({
    seq: state.seq,
    mode: r ? 'live' : 'idle',
    ...(r ? { playlistId: r.playlist.id, playlistName: r.playlist.name } : {}),
    ...(cue?.label ? { liveLabel: cue.label.slice(0, 1000) } : {}),
    lockedPresentationIds: r ? [...locked] : [],
  });
}

function routeFn(app: FastifyInstance) {
  return (method: HTTPMethods | HTTPMethods[], url: string, access: Access, handler: RouteHandlerMethod) =>
    app.route({ method, url: API_PREFIX + url, config: { access }, handler });
}

/**
 * The routes the service depends on at 10:00 on Sunday (design/25): served by the live process, so a
 * library-process failure cannot stop a GO, an output reconnect or a manifest fetch.
 */
export function registerLiveApi(app: FastifyInstance, ctx: LiveApiCtx): void {
  const { auth, live, cfg } = ctx;
  const route = routeFn(app);
  route('GET', '/auth/me', 'public', async (req): Promise<AuthMeRes> => {
    const p = req.principal;
    return {
      role: p?.role ?? null,
      setupRequired: auth.setupRequired(),
      version: APP_VERSION,
      domain: cfg.domain,
    };
  });
  route('GET', '/output/config', 'token', async (req): Promise<OutputConfigRes> => {
    const p = req.principal;
    if (p?.kind !== 'token') throw unauthorized();
    const res = ctx.outputConfig(p.outputId);
    if (!res) throw unauthorized();
    return res;
  });
  route('GET', '/live', 'live', async () => ({ seq: live.state.seq, state: live.state }));
  // `edit` admits both session roles (an operate session satisfies it too); never output tokens.
  route(
    'GET',
    '/live/summary',
    'edit',
    async (): Promise<LiveSummaryRes> => liveSummary(live.state, live.locks().presentations),
  );
  route('GET', '/cache/manifest', 'live', async (): Promise<ManifestRes> => {
    const r = live.state.mode === 'live' ? live.state.resolved : undefined;
    return r ? { manifestId: r.manifestId, files: r.files, resolved: r } : null;
  });
  const submit = async (cmd: unknown, id: string | undefined) => {
    const c = validate(LiveCommand, cmd, 'event');
    try {
      return { seq: await live.submitQueued(c as never, { role: 'operate', id }) };
    } catch (e) {
      if (e instanceof LiveRejection) throw new HttpError(409, 'rejected', e.message);
      throw e;
    }
  };
  route('POST', '/live/events', 'operate', async (req) => {
    const body = (req.body ?? {}) as { event?: unknown };
    if (body && typeof body === 'object' && 'event' in body) {
      const b = validate(LiveEventsBody, body);
      return submit(b.event, b.id);
    }
    return submit(body, undefined);
  });
  route('POST', '/actions', 'operate', async (req) => {
    const a = validate(ActionBody, req.body);
    const ev = actionToEvent(live.state, a, live.now() + 33, {
      messagePresets: live.messagePresets(),
      newId,
    });
    if (!ev) return { seq: live.state.seq, ignored: true };
    return submit(ev, `action:${a.id}`);
  });
  route('GET', '/health', 'public', async () => ({
    ok: true,
    version: APP_VERSION,
    uptimeS: Math.round(process.uptime()),
    seq: live.state.seq,
    mode: live.state.mode,
    ...ctx.healthExtra?.(),
  }));
}

/** Unknown API paths are JSON 404s, never the SPA. Registered once, by whichever process owns the API. */
export function registerApiNotFound(app: FastifyInstance): void {
  routeFn(app)(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], '/*', 'public', async () => {
    throw notFound('Unknown API route');
  });
}

/** The library API: everything except the live routes. Served by the library process. */
export function registerLibraryApi(app: FastifyInstance, hub: Ctx): void {
  const { lib, auth, live, cfg } = hub;
  const route = routeFn(app);

  const by = (req: FastifyRequest) => `${sessionRole(req.principal) ?? 'system'}@${req.ip}`;
  const cookieOpts = (req: FastifyRequest, maxAgeS: number) => ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: req.protocol === 'https',
    maxAge: maxAgeS,
  });
  const startSession = (
    req: FastifyRequest,
    reply: FastifyReply,
    role: 'operate' | 'edit',
    remember: boolean,
  ) => {
    const ua = req.headers['user-agent'] ?? '';
    const deviceOk = auth.deviceValid(req.cookies[DEVICE_COOKIE], ua);
    if (remember && !deviceOk)
      reply.setCookie(DEVICE_COOKIE, auth.createDevice(ua), cookieOpts(req, 365 * 86400));
    const remembered = remember || deviceOk;
    const token = auth.createSession(role, ua, remembered);
    reply.setCookie(COOKIE_SESSION, token, cookieOpts(req, (remembered ? 12 : 1) * 3600));
  };
  const assertPresentationUnlocked = (id: string) => {
    if (live.locks().presentations.has(id))
      throw locked('This presentation is in the live playlist and is locked until the service ends');
  };
  const assertPlaylistUnlocked = (id: string) => {
    if (live.locks().playlistId === id)
      throw locked('This playlist is live and is locked until the service ends');
  };
  const params = (req: FastifyRequest) => req.params as Record<string, string>;
  /** Heavy imports (zip inflate, LibreOffice, ffmpeg) are refused while a playlist is live. */
  const assertNotLive = () => {
    if (live.mode() === 'live')
      throw locked('Imports are disabled while a playlist is live; end the service first');
  };

  // ---------------- auth ----------------
  route('POST', '/auth/setup', 'public', async (req, reply) => {
    if (!auth.setupRequired()) throw new HttpError(409, 'already_setup', 'PINs are already set');
    auth.checkRate(req.ip);
    const b = validate(SetupBody, req.body);
    await auth.setPins(b.operatePin, b.editPin);
    hub.log.warn({ ip: req.ip }, 'first-run setup: PINs set');
    startSession(req, reply, 'operate', false);
    return { role: 'operate' };
  });

  route('POST', '/auth/pin', 'public', async (req, reply) => {
    if (auth.setupRequired()) throw new HttpError(409, 'setup_required', 'Set the PINs first');
    auth.checkRate(req.ip);
    const b = validate(PinBody, req.body);
    const role = await auth.matchPin(b.pin);
    auth.recordAttempt(req.ip, !!role);
    if (!role) throw new HttpError(401, 'wrong_pin', 'Wrong PIN');
    startSession(req, reply, role, !!b.remember);
    return { role };
  });

  route('POST', '/auth/logout', 'public', async (req, reply) => {
    auth.endSession(req.cookies[COOKIE_SESSION]);
    reply.clearCookie(COOKIE_SESSION, { path: '/' });
    return reply.code(204).send();
  });

  route('PUT', '/auth/pins', 'operate', async (req) => {
    const b = validate(PinsBody, req.body);
    const keep = req.principal?.kind === 'session' ? req.principal.sessionId : undefined;
    if (b.operatePin) await auth.changePin('operate', b.operatePin, keep);
    if (b.editPin) await auth.changePin('edit', b.editPin, keep);
    return { ok: true };
  });

  // ---------------- library ----------------
  // `?since=<seq>` answers with deltas when the change log still covers that seq, else the full snapshot.
  route('GET', '/library/snapshot', 'edit', async (req) => {
    const withTokens = sessionRole(req.principal) === 'operate';
    const since = (req.query as Record<string, unknown>).since;
    if (typeof since === 'string' && since !== '') {
      const n = Number(since);
      if (!Number.isInteger(n) || n < 0) throw badRequest('since must be a non-negative integer');
      const delta = lib.changesSince(n, { withTokens });
      if (delta) return delta;
    }
    return lib.snapshot({ withTokens });
  });

  // presentations
  route('GET', '/presentations', 'edit', async () => lib.presentations.list());
  route('GET', '/presentations/:id', 'edit', async (req) => lib.presentations.must(params(req).id!));
  route('POST', '/presentations', 'edit', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = validate(PresentationBody, { ...body, id: body.id || newId(), rev: 1 });
    if (lib.presentations.get(p.id)) throw conflict(`Presentation ${p.id} already exists`);
    const saved = lib.savePresentation(p, { create: true, by: by(req) });
    lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
    return reply.code(201).send(saved);
  });
  route('PUT', '/presentations/:id', 'edit', async (req) => {
    const id = params(req).id!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.rev !== 'number') throw badRequest('rev is required');
    assertPresentationUnlocked(id);
    const p = validate(PresentationBody, { ...body, id });
    const saved = lib.savePresentation(p, { expectedRev: body.rev, by: by(req) });
    lib.emit([{ kind: 'presentation', id, rev: saved.rev, entity: saved }]);
    return saved;
  });
  route('DELETE', '/presentations/:id', 'edit', async (req, reply) => {
    const id = params(req).id!;
    assertPresentationUnlocked(id);
    if (!lib.presentations.delete(id)) throw notFound();
    lib.db.prepare(`DELETE FROM presentation_revisions WHERE presentation_id = ?`).run(id);
    lib.emit([{ kind: 'presentation', id, deleted: true }]);
    return reply.code(204).send();
  });
  route('GET', '/presentations/:id/revisions', 'edit', async (req) => {
    lib.presentations.must(params(req).id!);
    return lib.revisions(params(req).id!);
  });
  route('GET', '/presentations/:id/revisions/:rev', 'edit', async (req) =>
    lib.revision(params(req).id!, Number(params(req).rev)),
  );
  route('POST', '/presentations/:id/restore/:rev', 'edit', async (req) => {
    const id = params(req).id!;
    assertPresentationUnlocked(id);
    const saved = lib.restoreRevision(id, Number(params(req).rev), by(req));
    lib.emit([{ kind: 'presentation', id, rev: saved.rev, entity: saved }]);
    return saved;
  });
  route('POST', '/presentations/:id/slides/:slideId/make-editable', 'edit', async (req) => {
    const id = params(req).id!;
    assertPresentationUnlocked(id);
    return hub.imports.makeEditable(id, params(req).slideId!, by(req));
  });
  // 'Show PowerPoint picture' (design/27 §5 "Operator fallback"): LibreOffice pictures of every shown slide.
  route('POST', '/presentations/:id/pptx-reference', 'edit', async (req, reply) => {
    const id = params(req).id!;
    assertPresentationUnlocked(id);
    const p = lib.presentations.must(id);
    const fileId = p.source?.kind === 'pptx' ? p.source.fileId : undefined;
    if (!fileId || !lib.getFile(fileId))
      throw badRequest('This presentation has no stored PowerPoint file', 'no_pptx');
    return reply.code(202).send(hub.imports.pptx.queueReference(id, fileId, by(req)));
  });

  // playlists
  route('GET', '/playlists', 'edit', async () => lib.playlists.list());
  route('GET', '/playlists/:id', 'edit', async (req) => lib.playlists.must(params(req).id!));
  route('POST', '/playlists', 'edit', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = validate(PlaylistBody, { ...body, id: body.id || newId(), rev: 1 });
    if (lib.playlists.get(p.id)) throw conflict(`Playlist ${p.id} already exists`);
    const saved = lib.playlists.insert(p);
    lib.emit([{ kind: 'playlist', id: saved.id, rev: saved.rev, entity: saved }]);
    return reply.code(201).send(saved);
  });
  route('PUT', '/playlists/:id', 'edit', async (req) => {
    const id = params(req).id!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.rev !== 'number') throw badRequest('rev is required');
    assertPlaylistUnlocked(id);
    const saved = lib.playlists.update(id, validate(PlaylistBody, { ...body, id }), body.rev);
    lib.emit([{ kind: 'playlist', id, rev: saved.rev, entity: saved }]);
    return saved;
  });
  route('DELETE', '/playlists/:id', 'edit', async (req, reply) => {
    const id = params(req).id!;
    assertPlaylistUnlocked(id);
    if (!lib.playlists.delete(id)) throw notFound();
    lib.emit([{ kind: 'playlist', id, deleted: true }]);
    return reply.code(204).send();
  });

  // themes
  route('GET', '/themes', 'edit', async () => lib.themes.list());
  route('GET', '/themes/:id', 'edit', async (req) => lib.themes.must(params(req).id!));
  route('POST', '/themes', 'edit', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const t = validate(ThemeBody, { ...body, id: body.id || newId() });
    if (lib.themes.get(t.id)) throw conflict(`Theme ${t.id} already exists`);
    const saved = lib.themes.insert(t);
    lib.emit([{ kind: 'theme', id: saved.id, rev: saved.rev, entity: saved }]);
    return reply.code(201).send(saved);
  });
  route('PUT', '/themes/:id', 'edit', async (req) => {
    const id = params(req).id!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved = lib.themes.update(
      id,
      validate(ThemeBody, { ...body, id }),
      typeof body.rev === 'number' ? body.rev : undefined,
    );
    lib.emit([{ kind: 'theme', id, rev: saved.rev, entity: saved }]);
    return saved;
  });
  route('DELETE', '/themes/:id', 'edit', async (req, reply) => {
    const id = params(req).id!;
    if (id === DEFAULT_THEME.id) throw conflict('The default theme cannot be deleted');
    if (!lib.themes.delete(id)) throw notFound();
    lib.emit([{ kind: 'theme', id, deleted: true }]);
    return reply.code(204).send();
  });

  // folders
  route('GET', '/folders', 'edit', async () => lib.folders.list());
  route('POST', '/folders', 'edit', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved = lib.folders.insert(validate(FolderBody, { ...body, id: body.id || newId() }));
    lib.emit([{ kind: 'folder', id: saved.id, rev: saved.rev, entity: saved }]);
    return reply.code(201).send(saved);
  });
  route('PUT', '/folders/:id', 'edit', async (req) => {
    const id = params(req).id!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved = lib.folders.update(
      id,
      validate(FolderBody, { ...body, id }),
      typeof body.rev === 'number' ? body.rev : undefined,
    );
    lib.emit([{ kind: 'folder', id, rev: saved.rev, entity: saved }]);
    return saved;
  });
  route('DELETE', '/folders/:id', 'edit', async (req, reply) => {
    const id = params(req).id!;
    if (!lib.folders.delete(id)) throw notFound();
    lib.emit([{ kind: 'folder', id, deleted: true }]);
    return reply.code(204).send();
  });

  // ---------------- media ----------------
  route('GET', '/media', 'edit', async () => lib.media.list());
  route('GET', '/media/:id', 'edit', async (req) => lib.media.must(params(req).id!));
  route('POST', '/media', 'edit', async (req, reply) => {
    const { files, fields } = await readMultipart(hub, req);
    if (!files.length) throw badRequest('No file in the upload (field "file")');
    const out: Media[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        const name = files.length === 1 && fields.name ? `${fields.name}.${extOf(f.filename)}` : f.filename;
        out.push(
          await hub.media.ingest(f, name, {
            isBackground: fields.isBackground === 'true' || fields.isBackground === '1',
            tags: fields.tags
              ? fields.tags
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean)
              : [],
          }),
        );
        files[i] = { ...f, path: '' };
      }
    } finally {
      await Promise.all(files.filter((f) => f.path).map((f) => rm(f.path, { force: true })));
    }
    return reply.code(201).send(out.length === 1 ? out[0] : out);
  });
  route('PUT', '/media/:id', 'edit', async (req) => {
    const id = params(req).id!;
    const patch = validate(MediaPatch, req.body);
    const cur = lib.media.must(id);
    const next: Media = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.loop !== undefined ? { loop: patch.loop } : {}),
      ...(patch.isBackground !== undefined ? { isBackground: patch.isBackground } : {}),
      ...(patch.audio !== undefined
        ? {
            audio: {
              ...cur.audio,
              gainDb: patch.audio.gainDb ?? cur.audio?.gainDb ?? 0,
              pairId: patch.audio.pairId,
            },
          }
        : {}),
    };
    const saved = lib.media.update(id, next, patch.rev);
    lib.emit([{ kind: 'media', id, rev: saved.rev, entity: saved }]);
    return saved;
  });
  route('DELETE', '/media/:id', 'edit', async (req, reply) => {
    const id = params(req).id!;
    if (live.locks().media.has(id)) throw locked('This media is used by the live playlist');
    const m = lib.media.must(id);
    // A missing picture refuses goLive (design/27 §11 item 15): media that stored presentations use is
    // deleted only with `?force=1`, which the operator sends once the user has confirmed.
    const users = presentationsUsingMedia(lib, id);
    if (users.length && !isForced(req.query))
      throw new HttpError(409, 'media_in_use', mediaInUseMessage(m.name, users), { presentations: users });
    lib.media.delete(id);
    lib.emit([{ kind: 'media', id, deleted: true }]);
    for (const h of [m.original.hash, m.delivery?.hash, m.poster?.hash]) await hub.store.release(h);
    return reply.code(204).send();
  });
  route('POST', '/media/:id/retry', 'edit', async (req) => hub.media.retry(params(req).id!));

  // Resumable uploads: create, then PATCH chunks with Upload-Offset; the last chunk returns the Media.
  route('POST', '/media/uploads', 'edit', async (req, reply) => {
    const b = validate(UploadCreate, req.body);
    const id = newId();
    const now = Date.now();
    lib.db
      .prepare(
        `INSERT INTO uploads (id, name, size, offset, fields, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, b.name, b.size, JSON.stringify({ isBackground: b.isBackground, tags: b.tags }), now, now);
    await appendFile(join(hub.store.uploads, `${id}.part`), '');
    reply.header('Upload-Offset', '0');
    return reply.code(201).send({ id, offset: 0, size: b.size });
  });
  const uploadRow = (id: string) => {
    const row = lib.db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(id) as
      | { id: string; name: string; size: number; offset: number; fields: string }
      | undefined;
    if (!row) throw notFound('Upload not found or expired');
    return row;
  };
  route('GET', '/media/uploads/:id', 'edit', async (req, reply) => {
    const row = uploadRow(params(req).id!);
    reply.header('Upload-Offset', String(row.offset));
    return { id: row.id, offset: row.offset, size: row.size };
  });
  route('PATCH', '/media/uploads/:id', 'edit', async (req, reply) => {
    const row = uploadRow(params(req).id!);
    const offset = Number(req.headers['upload-offset']);
    if (!Number.isInteger(offset) || offset !== row.offset) {
      reply.header('Upload-Offset', String(row.offset));
      throw new HttpError(409, 'offset_mismatch', `Upload-Offset must be ${row.offset}`, {
        offset: row.offset,
      });
    }
    const path = join(hub.store.uploads, `${row.id}.part`);
    const body = req.body as Readable | Buffer | undefined;
    let added = 0;
    const max = row.size - row.offset;
    const ws = createWriteStream(path, { flags: 'a' });
    const src: Readable | AsyncIterable<Buffer> =
      body && typeof (body as Readable).pipe === 'function'
        ? (body as Readable)
        : (async function* () {
            if (body) yield Buffer.from(body as Buffer);
          })();
    try {
      await pipeline(
        src,
        async function* (s: AsyncIterable<Buffer>) {
          for await (const c of s) {
            added += c.length;
            if (added > max) throw new HttpError(413, 'too_large', 'Chunk exceeds the declared upload size');
            yield c;
          }
        },
        ws,
      );
    } catch (e) {
      // Keep only whole, acknowledged bytes: truncate back to the last known offset.
      const { truncate } = await import('node:fs/promises');
      await truncate(path, row.offset).catch(() => undefined);
      throw e;
    }
    const newOffset = row.offset + added;
    lib.db
      .prepare(`UPDATE uploads SET offset = ?, updated_at = ? WHERE id = ?`)
      .run(newOffset, Date.now(), row.id);
    reply.header('Upload-Offset', String(newOffset));
    if (newOffset < row.size) return reply.code(204).send();
    lib.db.prepare(`DELETE FROM uploads WHERE id = ?`).run(row.id);
    const fields = JSON.parse(row.fields) as { isBackground?: boolean; tags?: string[] };
    const m = await hub.media.ingest({ path }, row.name, {
      isBackground: fields.isBackground,
      tags: fields.tags,
    });
    return reply.code(201).send(m);
  });

  // ---------------- fonts ----------------
  route('GET', '/fonts', 'edit', async () => lib.listFonts());
  route('POST', '/fonts/upload', 'edit', async (req, reply) => {
    const { files, fields } = await readMultipart(hub, req, { limit: 50 * 1024 * 1024 });
    if (!files.length) throw badRequest('No font file in the upload');
    const out = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        out.push(await hub.fonts.addUpload(f, f.filename, files.length === 1 ? fields : {}));
        files[i] = { ...f, path: '' };
      }
    } finally {
      await Promise.all(files.filter((f) => f.path).map((f) => rm(f.path, { force: true })));
    }
    return reply.code(201).send(out);
  });
  route('DELETE', '/fonts/:id', 'edit', async (req, reply) => {
    if (!(await hub.fonts.remove(params(req).id!))) throw notFound();
    return reply.code(204).send();
  });
  route('GET', '/fonts/google/search', 'edit', async (req) =>
    searchGoogleFonts(String((req.query as Record<string, unknown>).q ?? '').slice(0, 100)),
  );
  route('POST', '/fonts/google', 'edit', async (req, reply) => {
    const b = validate(z.object({ family: z.string().min(1).max(100) }).strict(), req.body);
    return reply.code(202).send(hub.fonts.queueGoogle(b.family));
  });

  // ---------------- imports ----------------
  route('POST', '/import/songselect', 'edit', async (req, reply) => {
    let text: string;
    let title: string | undefined;
    if (req.isMultipart()) {
      const { files, fields } = await readMultipart(hub, req, { maxFiles: 1, limit: 2 * 1024 * 1024 });
      const f = files[0];
      if (!f) throw badRequest('No file');
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(f.path);
      await rm(f.path, { force: true });
      text =
        buf[0] === 0xff && buf[1] === 0xfe
          ? buf.subarray(2).toString('utf16le')
          : buf[0] === 0xfe && buf[1] === 0xff
            ? Buffer.from(buf.subarray(2)).swap16().toString('utf16le')
            : buf.toString('utf8');
      title = fields.title;
    } else {
      const b = validate(SongselectBody, req.body);
      text = b.text;
      title = b.title;
    }
    return reply.code(201).send(hub.imports.songselect(text, { title, by: by(req) }));
  });
  route('POST', '/import/pro7', 'edit', async (req, reply) => {
    assertNotLive();
    if (req.isMultipart()) {
      const { files } = await readMultipart(hub, req, { maxFiles: 1 });
      const f = files[0];
      if (!f) throw badRequest('No zip file');
      const s = sniff(await readHead(f.path));
      if (s?.kind !== 'zip') {
        await rm(f.path, { force: true });
        throw new HttpError(415, 'unsupported', 'Upload a .zip of the ProPresenter library or export');
      }
      return reply.code(202).send(hub.imports.queuePro7FromUpload(f.path, f.filename));
    }
    const b = validate(z.object({ path: z.string().min(1).max(1000) }).strict(), req.body);
    return reply.code(202).send(await hub.imports.queuePro7FromPath(b.path));
  });
  route('POST', '/import/document', 'edit', async (req, reply) => {
    assertNotLive();
    const { files, fields } = await readMultipart(hub, req, { maxFiles: 1, limit: 1024 ** 3 });
    const f = files[0];
    if (!f) throw badRequest('No document');
    // How a PowerPoint is imported (optional form fields): editable slides unless pictures are asked for.
    let form: DocumentImportForm;
    try {
      form = documentImportForm(fields);
    } catch (e) {
      await rm(f.path, { force: true });
      throw e;
    }
    const s = sniff(await readHead(f.path));
    const ext = extOf(f.filename);
    let kind: 'pdf' | 'pptx';
    if (s?.kind === 'pdf') kind = 'pdf';
    else if (s?.kind === 'zip' && ext === 'pptx') kind = 'pptx';
    else {
      await rm(f.path, { force: true });
      throw new HttpError(415, 'unsupported', 'Upload a .pptx or .pdf file');
    }
    const ref = await hub.store.put(f.path, {
      ext: kind,
      mime: kind === 'pdf' ? 'application/pdf' : PPTX_MIME,
      hash: f.hash,
      bytes: f.bytes,
    });
    if (kind === 'pptx' && form.renderer === 'native')
      return reply.code(202).send(hub.imports.pptx.queueNative(ref.hash, f.filename, form.options));
    // A PDF is always pictures: the PowerPoint choice does not apply to it.
    const renderer = form.renderer === 'native' ? 'libreoffice' : form.renderer;
    return reply.code(202).send(hub.imports.queueDocument(ref.hash, f.filename, kind, renderer));
  });

  // ---------------- jobs ----------------
  route('GET', '/jobs', 'edit', async () => hub.jobs.list());
  route('GET', '/jobs/:id', 'edit', async (req) => hub.jobs.get(params(req).id!));

  // ---------------- settings and outputs ----------------
  route('GET', '/settings', 'edit', async (req) => {
    const s = lib.getSettings();
    return sessionRole(req.principal) === 'operate' ? s : stripTokens(s);
  });
  route('GET', '/settings/:key', 'edit', async (req) => {
    const key = params(req).key as SettingsKey;
    if (!SETTINGS_KEYS.includes(key)) throw notFound(`Unknown setting ${key}`);
    const v = lib.getSetting(key);
    return key === 'outputs' && sessionRole(req.principal) !== 'operate'
      ? (v as Output[]).map(({ token: _t, ...o }) => o)
      : v;
  });
  route('PUT', '/settings/:key', 'operate', async (req) => {
    const key = params(req).key as SettingsKey;
    if (!SETTINGS_KEYS.includes(key)) throw notFound(`Unknown setting ${key}`);
    let value = validate(SETTINGS_BODY[key], req.body, key) as Settings[SettingsKey];
    if (key === 'outputs') {
      if (!Array.isArray(value)) throw badRequest('outputs must be an array');
      const cur = new Map(lib.getSetting('outputs').map((o) => [o.id, o]));
      // Tokens are only changed by rotation; new outputs get a fresh one.
      value = (value as Output[]).map((o) => ({
        ...o,
        id: o.id || newId(),
        token: cur.get(o.id)?.token ?? newToken(),
      }));
      const ids = new Set<string>();
      for (const o of value as Output[]) {
        if (ids.has(o.id)) throw badRequest(`Duplicate output id ${o.id}`);
        ids.add(o.id);
      }
      assertOneAudioMaster(value as Output[]);
    }
    return lib.putSetting(key, value);
  });
  route('POST', '/outputs/:id/token/rotate', 'operate', async (req) => {
    const id = params(req).id!;
    const outputs = lib.getSetting('outputs');
    const o = outputs.find((x) => x.id === id);
    if (!o) throw notFound(`Output ${id}`);
    const next = { ...o, token: newToken() };
    lib.putSetting(
      'outputs',
      outputs.map((x) => (x.id === id ? next : x)),
    );
    hub.disconnectOutput(id, 'token-rotated');
    hub.log.info({ output: id }, 'output token rotated');
    return next;
  });
  // ---------------- files ----------------
  route('GET', '/files/:hash', 'any', async (req, reply) => {
    const hash = params(req).hash!;
    if (!/^[0-9a-f]{64}$/.test(hash)) throw notFound();
    const f = lib.getFile(hash);
    if (!f) throw notFound();
    return sendFile(req, reply, hub.store.abs(f.path), {
      mime: f.mime,
      etag: `"${hash}"`,
      cacheControl: 'private, max-age=31536000, immutable',
    });
  });

  // ---------------- diagnostics, backups ----------------
  route('GET', '/diagnostics/export', 'operate', async (_req, reply) => {
    const zip = new JSZip();
    const s = stripTokens(lib.getSettings());
    const d = await hub.liveDiag();
    zip.file('logs.ndjson', hub.ring.snapshot().join('\n'));
    if (d?.log) zip.file('logs-live.ndjson', d.log.join('\n'));
    zip.file('journal.json', JSON.stringify(d?.journal ?? 'the live process did not answer', null, 1));
    zip.file('settings.json', JSON.stringify(s, null, 1));
    zip.file('health.json', JSON.stringify(d?.health ?? {}, null, 1));
    zip.file(
      'hub.json',
      JSON.stringify(
        {
          version: APP_VERSION,
          node: process.version,
          uptimeS: Math.round(process.uptime()),
          domain: cfg.domain,
          seq: d?.seq,
          mode: d?.mode ?? live.mode(),
          playlist: d?.playlist,
          sockets: d?.sockets,
          live: d?.extra,
          processes: hub.diagExtra?.(),
          jobs: hub.jobs
            .list(50)
            .map((j) => ({ id: j.id, kind: j.kind, state: j.state, error: j.error, updatedAt: j.updatedAt })),
          backups: (await hub.backups.list()).files.slice(0, 10),
          exportedAt: new Date().toISOString(),
        },
        null,
        1,
      ),
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    reply.header(
      'Content-Disposition',
      `attachment; filename="ordo-diagnostics-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.zip"`,
    );
    reply.header('Cache-Control', 'no-store');
    return reply.type('application/zip').send(buf);
  });
  route('POST', '/backup/run', 'operate', async () => hub.backups.run());
  route('GET', '/backup/list', 'operate', async () => hub.backups.list());
}

/**
 * Exactly one output window plays audio (design/18): the hub accepts `media.ended` only from it, so the
 * outputs list must name exactly one audio master, and it must be an output (not the stage) that is enabled.
 */
export function assertOneAudioMaster(
  outputs: Pick<Output, 'kind' | 'audioMaster' | 'enabled' | 'name'>[],
): void {
  const masters = outputs.filter((o) => o.audioMaster);
  if (masters.length !== 1)
    throw badRequest(
      masters.length === 0
        ? 'Exactly one output must be the audio master; none is set'
        : `Exactly one output must be the audio master; ${masters.length} are set (${masters.map((m) => m.name).join(', ')})`,
      'audio_master',
    );
  const m = masters[0]!;
  if (m.kind === 'stage') throw badRequest('The stage display cannot be the audio master', 'audio_master');
  if (m.enabled === false)
    throw badRequest(
      `The audio master "${m.name}" is disabled; enable it or pick another output`,
      'audio_master',
    );
}

/** Startup cleanup of uploads/ and tmp/. Returns how many orphaned multipart .part files were removed. */
export async function cleanupStaleUploads(hub: Pick<Ctx, 'lib' | 'store' | 'cfg'>): Promise<number> {
  const cutoff = Date.now() - 7 * 86400_000;
  const rows = hub.lib.db.prepare(`SELECT id FROM uploads WHERE updated_at < ?`).all(cutoff) as {
    id: string;
  }[];
  for (const r of rows) {
    await rm(join(hub.store.uploads, `${r.id}.part`), { force: true });
    hub.lib.db.prepare(`DELETE FROM uploads WHERE id = ?`).run(r.id);
  }
  // A multipart upload streams into uploads/<id>.part with no row; a library process that died mid-upload
  // (or a client that vanished while it was killed) leaves it behind. At startup nothing is receiving, so
  // every .part without a row is an orphan; resumable uploads (with a row) keep theirs.
  const { readdir } = await import('node:fs/promises');
  const resumable = new Set(
    (hub.lib.db.prepare(`SELECT id FROM uploads`).all() as { id: string }[]).map((r) => `${r.id}.part`),
  );
  let orphans = 0;
  for (const f of await readdir(hub.store.uploads).catch(() => [] as string[])) {
    if (!f.endsWith('.part') || resumable.has(f)) continue;
    await rm(join(hub.store.uploads, f), { force: true });
    orphans++;
  }
  // tmp/ only ever holds scratch files of jobs in flight (partial transcodes, inflated imports). Every job
  // that was running is re-queued on start and begins again, so everything in it is garbage now.
  const tmp = join(hub.cfg.dataDir, 'tmp');
  for (const f of await readdir(tmp).catch(() => [] as string[]))
    await rm(join(tmp, f), { recursive: true, force: true });
  return orphans;
}

/**
 * The stored presentations that name a media item (backgrounds, pictures, imported pages, reference
 * pictures, clips): any JSON string equal to its id, so fields added later are covered too. Prefiltered in
 * SQL, title order, at most `limit`.
 */
export function presentationsUsingMedia(
  lib: Library,
  mediaId: string,
  limit = 1000,
): { id: string; title: string }[] {
  const quoted = JSON.stringify(mediaId);
  const like = `%${quoted.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = lib.db
    .prepare(`SELECT id, title, json FROM presentations WHERE json LIKE ? ESCAPE '\\' ORDER BY title, id`)
    .all(like) as { id: string; title: string; json: string }[];
  const out: { id: string; title: string }[] = [];
  for (const r of rows) {
    if (!r.json.includes(quoted)) continue;
    out.push({ id: r.id, title: r.title });
    if (out.length >= limit) break;
  }
  return out;
}

/** What the operator shows before deleting media that presentations use. */
function mediaInUseMessage(name: string, users: { title: string }[]): string {
  const shown = users.slice(0, 5).map((u) => `“${u.title}”`);
  const more = users.length > shown.length ? ` and ${users.length - shown.length} more` : '';
  const what = users.length === 1 ? 'the presentation' : `${users.length} presentations:`;
  return `“${name}” is used by ${what} ${shown.join(', ')}${more}. Without it they cannot go live until it is replaced.`;
}

function isForced(query: unknown): boolean {
  const v = query && typeof query === 'object' ? (query as Record<string, unknown>).force : undefined;
  return v === '1' || v === 'true';
}

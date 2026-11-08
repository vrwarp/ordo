import {
  DEFAULT_THEME,
  type Font,
  type Media,
  newId,
  type Output,
  type Playlist,
  Playlist as PlaylistSchema,
  type Presentation,
  Presentation as PresentationSchema,
  type Theme,
  Theme as ThemeSchema,
} from '@ordo/domain';
import { importPro7, parseSongFile, PRO7_MEDIA_PREFIX, readZip, remapMediaIds } from '@ordo/importers';
import { initialState } from '@ordo/live-state';
import { clearAll, deleteFile, getDoc, getFile, putDoc, putFile } from './store.ts';
import {
  type Job,
  type LibrarySnapshot,
  SETTINGS_BODY,
  type Settings,
  type SettingsKey,
} from '@ordo/protocol';
import { ZodError } from 'zod';

/**
 * The demo hub (apps/demo, GitHub Pages): the hub's REST API answered inside the visitor's browser. The
 * library starts as the sample service bundled with the site (`demo/seed.json`) and every change is kept in
 * IndexedDB. What needs the real hub's server tools (PowerPoint and PDF rendering, media transcoding, Google
 * Fonts, backups) answers with a clear "not in the demo". There is no WebSocket: the apps run with
 * `ORDO_DEMO=1` and go live in the browser (design/17 "Going live without the hub").
 */

type Lib = LibrarySnapshot;
type Res = Response;

const VERSION = '0.1.0-demo';
let scope = '/';
let lib: Lib | undefined;
let loading: Promise<Lib> | undefined;
const seedFiles = new Set<string>();

export function setScope(s: string): void {
  scope = s;
}

const json = (body: unknown, status = 200): Res =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, code: string, message: string): Res =>
  json({ error: { code, message } }, status);
const noContent = (): Res => new Response(null, { status: 204 });
const notInDemo = (what: string) =>
  fail(
    501,
    'not_in_demo',
    `${what} needs the ordo hub on a server; it is not available in the browser demo.`,
  );
const nowIso = () => new Date().toISOString();

/** An output token as the hub mints them (library.ts `newToken`): 32 random bytes, base64url. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A `.parse` failure as the hub's `validate()` reports it: one line, the first few issues. */
function invalid(e: ZodError, what = 'body'): string {
  const msg = e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || what}: ${i.message}`)
    .join('; ');
  return `Invalid ${what}: ${msg}`;
}

async function seed(): Promise<{ snapshot: Lib; files: string[] }> {
  const r = await fetch(new URL('demo/seed.json', scope));
  if (!r.ok) throw new Error(`seed: HTTP ${r.status}`);
  return (await r.json()) as { snapshot: Lib; files: string[] };
}

async function library(): Promise<Lib> {
  if (lib) return lib;
  loading ??= (async () => {
    const s = await seed();
    for (const f of s.files) seedFiles.add(f);
    const saved = await getDoc<Lib>('lib');
    lib = saved ?? s.snapshot;
    if (!saved) await putDoc('lib', lib);
    return lib;
  })().finally(() => {
    loading = undefined;
  });
  return loading;
}

async function save(next: Lib): Promise<void> {
  next.seq = (next.seq ?? 0) + 1;
  lib = next;
  await putDoc('lib', next);
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const out = list.slice();
  out[i] = item;
  return out;
}

async function sha256(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function mimeOf(name: string, given: string): string {
  if (given && given !== 'application/octet-stream') return given;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
    }[ext] ?? 'application/octet-stream'
  );
}

/** A media item from a file the visitor added: stored as-is (browsers play these formats directly). */
async function mediaFromBlob(
  blob: Blob,
  name: string,
  opts: { isBackground?: boolean; tags?: string[] } = {},
): Promise<Media> {
  const mime = mimeOf(name, blob.type);
  const kind =
    mime.startsWith('video/') || VIDEO.test(name)
      ? 'video'
      : mime.startsWith('audio/') || AUDIO.test(name)
        ? 'audio'
        : 'image';
  if (kind === 'image' && !IMAGE.test(name) && !mime.startsWith('image/'))
    throw new Error(`"${name}" is not a picture, video or audio file`);
  const hash = await sha256(blob);
  await putFile(hash, blob);
  const ref = { hash, bytes: blob.size, mime, path: `files/${hash}` };
  const base = name.replace(/\.[^.]+$/, '').slice(0, 200) || 'Media';
  const m: Media = {
    id: newId(),
    rev: 1,
    name: base,
    tags: opts.tags ?? [],
    kind,
    original: ref,
    state: 'ready',
    loop: false,
    isBackground: !!opts.isBackground,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (kind !== 'image') m.delivery = ref;
  if (kind === 'image') {
    try {
      const bmp = await createImageBitmap(blob);
      m.width = bmp.width;
      m.height = bmp.height;
      bmp.close();
    } catch {
      /* dimensions unknown: drawn as decoded */
    }
  }
  return m;
}

function job(kind: string, result: unknown, log: string[], error?: string): Job {
  const at = nowIso();
  return {
    id: newId(),
    kind,
    state: error ? 'failed' : 'done',
    progress: 1,
    log,
    result,
    error,
    createdAt: at,
    updatedAt: at,
  };
}

async function saveJob(j: Job): Promise<Job> {
  const jobs = ((await getDoc<Job[]>('jobs')) ?? []).filter((x) => x.id !== j.id).slice(-49);
  await putDoc('jobs', [...jobs, j]);
  return j;
}

/** ProPresenter 7 import in the browser: a .pro, a .probundle, a .proPlaylist or a zip of a library. */
async function importPro7Upload(file: File): Promise<Job> {
  const log: string[] = [`reading ${file.name}`];
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const files = isZip ? await readZip(bytes) : new Map([[file.name, bytes]]);
    const r = importPro7(files);
    for (const l of r.log) log.push(`[${l.level}] ${l.item ? `${l.item}: ` : ''}${l.message}`);
    const map = new Map<string, string>();
    let l = await library();
    let media = l.media;
    for (const m of r.media) {
      const data = files.get(m.path);
      if (!data || data.length === 0) {
        log.push(`[warn] media ${m.path}: file not in the import`);
        continue;
      }
      try {
        const item = await mediaFromBlob(
          new Blob([data as Uint8Array<ArrayBuffer>]),
          m.path.split('/').pop() ?? m.path,
          {
            isBackground: m.background === true,
            tags: ['pro7'],
          },
        );
        const existing = media.find((x) => x.original.hash === item.original.hash);
        map.set(m.key, existing?.id ?? item.id);
        if (!existing) media = [...media, item];
      } catch (e) {
        log.push(`[warn] media ${m.path}: ${(e as Error).message}`);
      }
    }
    let presentations = l.presentations;
    const ids: string[] = [];
    for (const raw of r.presentations) {
      const p = remapMediaIds(raw, map) as Presentation;
      stripPlaceholders(p);
      const prev = presentations.find((x) => x.id === p.id);
      const saved = {
        ...p,
        rev: (prev?.rev ?? 0) + 1,
        createdAt: prev?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      presentations = upsert(presentations, PresentationSchema.parse(saved));
      ids.push(p.id);
    }
    let playlists = l.playlists;
    for (const raw of r.playlists) {
      const pl = remapMediaIds(raw, map) as Playlist;
      pl.items = pl.items.filter((it) => it.kind !== 'media' || !it.mediaId.startsWith(PRO7_MEDIA_PREFIX));
      playlists = upsert(playlists, PlaylistSchema.parse({ ...pl, rev: 1, updatedAt: nowIso() }));
    }
    l = { ...l, media, presentations, playlists };
    await save(l);
    log.push(
      `imported ${r.presentations.length} presentation(s), ${r.playlists.length} playlist(s), ${map.size} media file(s)`,
    );
    return saveJob(
      job(
        'pro7-import',
        {
          presentations: r.presentations.length,
          playlists: r.playlists.length,
          media: map.size,
          presentationIds: ids,
          log: r.log,
        },
        log,
      ),
    );
  } catch (e) {
    log.push(`[error] ${(e as Error).message}`);
    return saveJob(job('pro7-import', undefined, log, (e as Error).message));
  }
}

/** Media references whose file was not in the import stay as placeholders: drop them, as the hub does. */
function stripPlaceholders(p: Presentation): void {
  const bad = (id?: string) => !!id && id.startsWith(PRO7_MEDIA_PREFIX);
  if (bad(p.backgroundMediaId)) delete p.backgroundMediaId;
  for (const s of p.sections)
    for (const sl of s.slides) {
      if (bad(sl.backgroundMediaId)) delete sl.backgroundMediaId;
      sl.objects = sl.objects.filter((o) => o.type !== 'image' || !bad(o.mediaId));
    }
}

function outputByToken(l: Lib, token: string | null) {
  return l.settings.outputs.find((o) => o.token && o.token === token);
}

/** Route one API request (path after `/api/v1`). */
export async function handle(req: Request): Promise<Res> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/api\/v1/, '');
  const m = req.method;
  const seg = path.split('/').filter(Boolean);
  try {
    // ---- session: one visitor, always the operator
    if (path === '/auth/me')
      return json({ role: 'operate', setupRequired: false, version: VERSION, domain: '' });
    if (path === '/auth/pins') return notInDemo('Changing the PINs');
    if (seg[0] === 'auth') return json({ ok: true });
    if (path === '/health') return json({ ok: true, demo: true, version: VERSION });

    // ---- the reset button
    if (path === '/demo/reset' && m === 'POST') {
      // Forget the in-memory library first: if the stores cannot be cleared, the next request must not
      // keep serving the stale one.
      lib = undefined;
      loading = undefined;
      await clearAll();
      return json({ ok: true });
    }

    // ---- files: the visitor's own (IndexedDB), else the sample service's (on the site)
    if (seg[0] === 'files' && seg[1]) {
      const own = await getFile(seg[1]);
      if (own)
        return new Response(own, { headers: { 'content-type': own.type || 'application/octet-stream' } });
      return fetch(new URL(`demo/files/${seg[1]}`, scope));
    }

    const l = await library();

    // ---- live: the browser is the authority; the "hub" is always idle
    if (path === '/live') return json({ seq: 0, state: initialState() });
    if (path === '/live/summary') return json({ seq: 0, mode: 'idle', lockedPresentationIds: [] });
    if (path === '/live/events' || path === '/actions')
      return fail(503, 'no_hub', 'The demo runs the service in the browser');
    if (path === '/cache/manifest') return json({ manifestId: '', files: [] });

    // ---- output and stage windows
    if (path === '/output/config') {
      const token = req.headers.get('x-ordo-token') ?? url.searchParams.get('token');
      const out = outputByToken(l, token);
      if (!out) return fail(401, 'unauthorized', 'Unknown output token');
      const { token: _t, ...output } = out;
      const logo = l.settings.general.logoMediaId
        ? l.media.find((x) => x.id === l.settings.general.logoMediaId)
        : undefined;
      return json({
        output,
        looks: l.settings.looks,
        audio: l.settings.audio,
        general: l.settings.general,
        logo,
        fonts: l.fonts,
      });
    }

    // ---- library
    if (path === '/library/snapshot') return json(l);
    if (seg[0] === 'settings') {
      if (m === 'GET') return json(seg[1] ? l.settings[seg[1] as keyof Settings] : l.settings);
      if (m === 'PUT' && seg[1]) {
        const key = seg[1] as SettingsKey;
        const schema = Object.hasOwn(SETTINGS_BODY, key) ? SETTINGS_BODY[key] : undefined;
        if (!schema) return fail(404, 'not_found', `Unknown setting ${key}`);
        let value = schema.parse(await req.json()) as Settings[SettingsKey];
        if (key === 'outputs') {
          // Tokens are only changed by rotation; new outputs get a fresh one (as the hub does).
          const cur = new Map(l.settings.outputs.map((o) => [o.id, o]));
          value = (value as Output[]).map((o) => ({
            ...o,
            id: o.id || newId(),
            token: cur.get(o.id)?.token ?? newToken(),
          }));
          const ids = new Set<string>();
          for (const o of value as Output[]) {
            if (ids.has(o.id)) return fail(400, 'bad_request', `Duplicate output id ${o.id}`);
            ids.add(o.id);
          }
        }
        await save({ ...l, settings: { ...l.settings, [key]: value } });
        return json(value);
      }
    }
    if (seg[0] === 'outputs' && seg[2] === 'token') {
      const o = l.settings.outputs.find((x) => x.id === seg[1]);
      if (!o) return fail(404, 'not_found', 'No such output');
      return json(o);
    }

    if (seg[0] === 'presentations') {
      if (m === 'GET' && !seg[1]) return json(l.presentations);
      if (m === 'GET' && seg[2] === 'revisions') return json([]);
      if (m === 'GET') {
        const p = l.presentations.find((x) => x.id === seg[1]);
        return p ? json(p) : fail(404, 'not_found', 'No such presentation');
      }
      if (m === 'POST' && !seg[1]) {
        const body = (await req.json()) as Presentation;
        const p = PresentationSchema.parse({
          ...body,
          id: body.id || newId(),
          rev: 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        if (l.presentations.some((x) => x.id === p.id))
          return fail(409, 'conflict', `Presentation ${p.id} already exists`);
        await save({ ...l, presentations: upsert(l.presentations, p) });
        return json(p, 201);
      }
      if (m === 'PUT' && seg[1]) {
        const body = (await req.json()) as Presentation;
        const prev = l.presentations.find((x) => x.id === seg[1]);
        if (prev && typeof body.rev === 'number' && body.rev !== prev.rev)
          return fail(409, 'conflict', 'This presentation was changed elsewhere; reload it');
        const p = PresentationSchema.parse({
          ...body,
          id: seg[1],
          rev: (prev?.rev ?? 0) + 1,
          updatedAt: nowIso(),
        });
        await save({ ...l, presentations: upsert(l.presentations, p) });
        return json(p);
      }
      if (m === 'DELETE' && seg[1]) {
        const id = seg[1];
        if (!l.presentations.some((x) => x.id === id)) return fail(404, 'not_found', 'No such presentation');
        // Playlist items that showed it go with it.
        const playlists = l.playlists.map((pl) => {
          const items = pl.items.filter((it) => it.kind !== 'presentation' || it.presentationId !== id);
          return items.length === pl.items.length
            ? pl
            : { ...pl, items, rev: pl.rev + 1, updatedAt: nowIso() };
        });
        await save({ ...l, presentations: l.presentations.filter((x) => x.id !== id), playlists });
        return noContent();
      }
      if (m === 'POST' && seg[2] === 'restore') return notInDemo('Version history');
      if (m === 'POST' && seg[4] === 'make-editable') return notInDemo('Making an imported slide editable');
    }

    if (seg[0] === 'playlists') {
      if (m === 'GET' && !seg[1]) return json(l.playlists);
      if (m === 'GET') {
        const p = l.playlists.find((x) => x.id === seg[1]);
        return p ? json(p) : fail(404, 'not_found', 'No such playlist');
      }
      if (m === 'POST' || m === 'PUT') {
        const body = (await req.json()) as Playlist;
        const id = seg[1] ?? body.id ?? newId();
        const prev = l.playlists.find((x) => x.id === id);
        const p = PlaylistSchema.parse({ ...body, id, rev: (prev?.rev ?? 0) + 1, updatedAt: nowIso() });
        await save({ ...l, playlists: upsert(l.playlists, p) });
        return json(p, m === 'POST' ? 201 : 200);
      }
      if (m === 'DELETE' && seg[1]) {
        if (!l.playlists.some((x) => x.id === seg[1])) return fail(404, 'not_found', 'No such playlist');
        await save({ ...l, playlists: l.playlists.filter((x) => x.id !== seg[1]) });
        return noContent();
      }
    }

    if (seg[0] === 'themes') {
      if (m === 'GET' && !seg[1]) return json(l.themes.length ? l.themes : [DEFAULT_THEME]);
      if (m === 'GET') return json(l.themes.find((x) => x.id === seg[1]) ?? DEFAULT_THEME);
      if (m === 'POST' || m === 'PUT') {
        const body = (await req.json()) as Theme;
        const t = ThemeSchema.parse({ ...body, id: seg[1] ?? body.id ?? newId() });
        if (m === 'POST' && l.themes.some((x) => x.id === t.id))
          return fail(409, 'conflict', `Theme ${t.id} already exists`);
        await save({ ...l, themes: upsert(l.themes, t) });
        return json(t, m === 'POST' ? 201 : 200);
      }
      if (m === 'DELETE' && seg[1]) {
        if (seg[1] === DEFAULT_THEME.id) return fail(409, 'conflict', 'The default theme cannot be deleted');
        if (!l.themes.some((x) => x.id === seg[1])) return fail(404, 'not_found', 'No such theme');
        await save({ ...l, themes: l.themes.filter((x) => x.id !== seg[1]) });
        return noContent();
      }
    }

    if (seg[0] === 'folders') {
      if (m === 'GET') return json(l.folders);
      if (m === 'DELETE' && seg[1]) {
        if (!l.folders.some((x) => x.id === seg[1])) return fail(404, 'not_found', 'No such folder');
        await save({ ...l, folders: l.folders.filter((x) => x.id !== seg[1]) });
        return noContent();
      }
      if (m !== 'POST' && m !== 'PUT') return fail(404, 'not_found', `${m} ${path} is not part of the demo`);
      const body = (await req.json()) as { id?: string; name: string; parentId?: string };
      const f = {
        id: seg[1] ?? body.id ?? newId(),
        name: String(body.name ?? 'Folder').slice(0, 200),
        parentId: body.parentId,
      };
      await save({ ...l, folders: upsert(l.folders, f) });
      return json(f, m === 'POST' ? 201 : 200);
    }

    if (seg[0] === 'media') {
      if (m === 'GET' && !seg[1]) return json(l.media);
      if (m === 'GET') {
        const x = l.media.find((y) => y.id === seg[1]);
        return x ? json(x) : fail(404, 'not_found', 'No such media');
      }
      if (m === 'POST' && !seg[1]) {
        const form = await req.formData();
        const files = form.getAll('file').filter((f): f is File => f instanceof File);
        if (!files.length) return fail(400, 'bad_request', 'No file in the upload (field "file")');
        const isBackground = form.get('isBackground') === 'true' || form.get('isBackground') === '1';
        const out: Media[] = [];
        let media = l.media;
        for (const f of files) {
          const item = await mediaFromBlob(f, f.name, { isBackground });
          const same = media.find((x) => x.original.hash === item.original.hash);
          if (same) out.push(same);
          else {
            media = [...media, item];
            out.push(item);
          }
        }
        await save({ ...l, media });
        return json(out.length === 1 ? out[0] : out, 201);
      }
      if (m === 'PUT' && seg[1]) {
        const patch = (await req.json()) as Partial<Media>;
        const prev = l.media.find((x) => x.id === seg[1]);
        if (!prev) return fail(404, 'not_found', 'No such media');
        const next: Media = {
          ...prev,
          ...patch,
          id: prev.id,
          original: prev.original,
          rev: prev.rev + 1,
          updatedAt: nowIso(),
        };
        await save({ ...l, media: upsert(l.media, next) });
        return json(next);
      }
      if (m === 'DELETE' && seg[1]) {
        const x = l.media.find((y) => y.id === seg[1]);
        if (!x) return fail(404, 'not_found', 'No such media');
        const media = l.media.filter((y) => y.id !== x.id);
        await save({ ...l, media });
        // The visitor's own file goes too, unless another item still uses it (the sample's live on the site).
        for (const h of new Set([x.original.hash, x.delivery?.hash, x.poster?.hash])) {
          if (!h || seedFiles.has(h)) continue;
          if (media.some((y) => y.original.hash === h || y.delivery?.hash === h || y.poster?.hash === h))
            continue;
          await deleteFile(h);
        }
        return noContent();
      }
      if (m === 'POST' && seg[2] === 'retry') return notInDemo('Retrying media processing');
      if (seg[1] === 'uploads') return notInDemo('Resumable uploads');
    }

    if (seg[0] === 'fonts') {
      if (m === 'GET' && !seg[1]) return json(l.fonts as Font[]);
      if (seg[1] === 'google' && seg[2] === 'search') return json([]);
      if (m === 'DELETE' && seg[1]) {
        const f = (l.fonts as Font[]).find((x) => x.id === seg[1]);
        if (!f) return fail(404, 'not_found', 'No such font');
        await save({ ...l, fonts: l.fonts.filter((x) => x.id !== seg[1]) });
        if (!seedFiles.has(f.file.hash)) await deleteFile(f.file.hash);
        return noContent();
      }
      return notInDemo('Adding fonts');
    }

    // ---- imports
    if (path === '/import/songselect' && m === 'POST') {
      let text = '';
      let title: string | undefined;
      if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
        const form = await req.formData();
        const f = form.get('file');
        if (f instanceof File) text = await f.text();
        title = (form.get('title') as string | null) ?? undefined;
      } else {
        const b = (await req.json()) as { text?: string; title?: string };
        text = b.text ?? '';
        title = b.title;
      }
      if (!text.trim()) return fail(400, 'bad_request', 'No lyrics text');
      const p = parseSongFile(text, { title, linesPerSlide: l.settings.general.defaultLinesPerSlide });
      if (!p.sections.length) return fail(400, 'bad_request', 'No lyric sections found');
      const saved = PresentationSchema.parse({ ...p, rev: 1, createdAt: nowIso(), updatedAt: nowIso() });
      await save({ ...l, presentations: upsert(l.presentations, saved) });
      return json(saved, 201);
    }
    if (path === '/import/pro7' && m === 'POST') {
      if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data'))
        return notInDemo('Importing from a folder on the NAS');
      const form = await req.formData();
      const f = form.get('file');
      if (!(f instanceof File)) return fail(400, 'bad_request', 'No file');
      return json(await importPro7Upload(f), 202);
    }
    if (path === '/import/document') return notInDemo('Importing PowerPoint and PDF');

    if (seg[0] === 'jobs') {
      const jobs = (await getDoc<Job[]>('jobs')) ?? [];
      if (!seg[1]) return json(jobs);
      const j = jobs.find((x) => x.id === seg[1]);
      return j ? json(j) : fail(404, 'not_found', 'No such job');
    }

    if (seg[0] === 'backup') return notInDemo('Backups');
    if (seg[0] === 'diagnostics') return notInDemo('The diagnostics export');
    return fail(404, 'not_found', `${m} ${path} is not part of the demo`);
  } catch (e) {
    if (e instanceof ZodError) return fail(400, 'bad_request', invalid(e));
    // `req.json()` on a body that is not JSON.
    if (e instanceof SyntaxError) return fail(400, 'bad_request', `Invalid body: ${e.message}`);
    return fail(500, 'internal', (e as Error).message);
  }
}

import {
  DEFAULT_THEME,
  type Font,
  type ImageObject,
  isSvgMime,
  type Media,
  newId,
  pngSize,
  SVG_DEFAULT_SIZE,
  SVG_HEAD_BYTES,
  svgIntrinsicSize,
  svgRasterProblem,
  svgRasterSizeFor,
  type Output,
  type Playlist,
  Playlist as PlaylistSchema,
  type Presentation,
  Presentation as PresentationSchema,
  type Theme,
  Theme as ThemeSchema,
} from '@ordo/domain';
import {
  importPptxClient,
  importPro7,
  parseSongFile,
  PRO7_MEDIA_PREFIX,
  readZip,
  remapMediaIds,
} from '@ordo/importers';
import { initialState } from '@ordo/live-state';
import { clearAll, deleteFile, getDoc, getFile, putDoc, putFile } from './store.ts';
import {
  type HubCapabilities,
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
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

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
      svg: 'image/svg+xml',
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
  if (isSvgMime(mime)) {
    // The size outputs draw it at (design/26): a service worker cannot decode an SVG.
    const size = svgRasterSizeFor(
      svgIntrinsicSize(await blob.slice(0, SVG_HEAD_BYTES).text()),
      SVG_DEFAULT_SIZE,
    );
    m.width = size.width;
    m.height = size.height;
    m.hasAlpha = true;
  } else if (kind === 'image') {
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

/** The type of a library file by its hash (media originals, deliveries and posters, fonts). */
function mimeOfHash(l: Lib, hash: string): string | undefined {
  for (const m of l.media)
    for (const f of [m.original, m.delivery, m.poster]) if (f?.hash === hash) return f.mime;
  for (const f of l.fonts as Font[]) if (f.file.hash === hash) return f.file.mime;
  return undefined;
}

/**
 * An SVG's still from the operator's upload (field "raster", design/12 "Media pipeline"), checked as the hub
 * checks it, kept as the item's delivery: outputs draw it instead of the SVG. Throws for a raster with
 * anything but one SVG, or one that is not a PNG of its shape within the caps.
 */
async function withRaster(m: Media, svg: Blob, raster: Blob): Promise<Media> {
  if (!isSvgMime(m.original.mime)) throw new Error('a still picture can only come with an SVG');
  const png = pngSize(new Uint8Array(await raster.slice(0, 64).arrayBuffer()));
  if (!png) throw new Error('the still picture is not a PNG');
  const problem = svgRasterProblem(svgIntrinsicSize(await svg.slice(0, SVG_HEAD_BYTES).text()), png);
  if (problem) throw new Error(problem);
  const hash = await sha256(raster);
  await putFile(hash, new Blob([raster], { type: 'image/png' }));
  return {
    ...m,
    delivery: { hash, bytes: raster.size, mime: 'image/png', path: `files/${hash}` },
    width: png.width,
    height: png.height,
  };
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

/** Fallback media for the browser demo when server-side LibreOffice rendering is needed. */
async function ensureDemoFallbackMedia(l: Lib): Promise<{ full: Media; overlay: Media; nextLib: Lib }> {
  let full = l.media.find((m) => m.name === 'Demo Fallback Slide');
  let overlay = l.media.find((m) => m.name === 'Demo Fallback Object');
  let mediaList = l.media;

  if (!full) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <rect width="1920" height="1080" fill="#0f172a"/>
  <rect x="40" y="40" width="1840" height="1000" rx="24" fill="#1e293b" stroke="#334155" stroke-width="4" stroke-dasharray="16 12"/>
  <g transform="translate(960, 420)">
    <path d="M-40 -70 L10 -70 L40 -40 L40 70 L-40 70 Z" fill="#334155" stroke="#94a3b8" stroke-width="6" stroke-linejoin="round"/>
    <path d="M10 -70 L10 -40 L40 -40" fill="none" stroke="#94a3b8" stroke-width="6" stroke-linejoin="round"/>
    <line x1="-20" y1="-15" x2="20" y2="-15" stroke="#64748b" stroke-width="5" stroke-linecap="round"/>
    <line x1="-20" y1="15" x2="20" y2="15" stroke="#64748b" stroke-width="5" stroke-linecap="round"/>
    <line x1="-20" y1="40" x2="10" y2="40" stroke="#64748b" stroke-width="5" stroke-linecap="round"/>
  </g>
  <text x="960" y="580" text-anchor="middle" fill="#f8fafc" font-family="system-ui, -apple-system, sans-serif" font-size="44" font-weight="600">Rendering Not Available in Browser Demo</text>
  <text x="960" y="640" text-anchor="middle" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="28">This element or slide picture requires LibreOffice on the Ordo Hub server.</text>
  <text x="960" y="690" text-anchor="middle" fill="#64748b" font-family="system-ui, -apple-system, sans-serif" font-size="22">Native editable slides remain fully supported and editable in this demo.</text>
</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    full = await mediaFromBlob(blob, 'Demo Fallback Slide.svg', {
      isBackground: true,
      tags: ['demo-fallback'],
    });
    full.width ??= 1920;
    full.height ??= 1080;
    mediaList = [...mediaList, full];
  }

  if (!overlay) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">
  <rect width="800" height="600" rx="16" fill="rgba(30, 41, 59, 0.9)" stroke="#475569" stroke-width="3" stroke-dasharray="8 6"/>
  <text x="400" y="280" text-anchor="middle" fill="#f1f5f9" font-family="system-ui, -apple-system, sans-serif" font-size="32" font-weight="600">Object Not Available in Demo</text>
  <text x="400" y="330" text-anchor="middle" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="20">Rendered by LibreOffice on the Ordo Hub server</text>
</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    overlay = await mediaFromBlob(blob, 'Demo Fallback Object.svg', { tags: ['demo-fallback'] });
    overlay.width ??= 800;
    overlay.height ??= 600;
    overlay.hasAlpha = true;
    mediaList = [...mediaList, overlay];
  }

  return { full, overlay, nextLib: { ...l, media: mediaList } };
}

function slideObjectsDigest(objects: readonly unknown[]): string {
  const s = JSON.stringify(objects);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Import PowerPoint or PDF in the browser demo. */
async function importDocumentUpload(file: File, form: FormData): Promise<Job> {
  let l = await library();
  const fallbacks = await ensureDemoFallbackMedia(l);
  l = fallbacks.nextLib;

  const isPdf = /\.pdf$/i.test(file.name);
  if (isPdf) {
    const hash = await sha256(file);
    await putFile(hash, file);
    const p: Presentation = {
      id: newId(),
      rev: 1,
      title: file.name.replace(/\.pdf$/i, '').slice(0, 200) || 'PDF',
      kind: 'slides',
      meta: { tags: [] },
      sections: [
        {
          id: newId(),
          label: 'Slides',
          short: '',
          slides: [
            {
              id: newId(),
              objects: [],
              imported: {
                fileId: hash,
                page: 1,
                imageMediaId: fallbacks.full.id,
                textBoxes: [],
                textAligned: true,
              },
            },
          ],
        },
      ],
      arrangements: [],
      source: { kind: 'pdf', fileId: hash },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      archived: false,
    };
    p.arrangements = [{ id: newId(), name: 'Default', sectionIds: p.sections.map((s) => s.id) }];
    const saved = PresentationSchema.parse(p);
    await save({ ...l, presentations: upsert(l.presentations, saved) });
    return saveJob(
      job('document', { presentationId: saved.id }, [
        `imported PDF ${file.name} (page rendering uses fallback image in demo)`,
      ]),
    );
  }

  // PowerPoint import:
  const renderer = form.get('renderer');
  const extendBackgrounds = form.get('extendBackgrounds') !== '0';
  const parsed = await importPptxClient(file, file.name, { extendBackgrounds });

  // Store uploaded PPTX file by hash
  await putFile(parsed.deckHash, file);

  if (renderer === 'libreoffice' || renderer === 'pptx-preview') {
    let page = 0;
    const p: Presentation = {
      id: newId(),
      rev: 1,
      title: parsed.presentation.title,
      kind: 'slides',
      meta: { tags: [] },
      sections: parsed.presentation.sections.map((sec) => ({
        ...sec,
        slides: sec.slides.map((sl) => ({
          id: sl.id,
          objects: [],
          ...(sl.notes ? { notes: sl.notes } : {}),
          ...(sl.hidden ? { hidden: true } : {}),
          imported: {
            fileId: parsed.deckHash,
            page: ++page,
            imageMediaId: fallbacks.full.id,
            textBoxes: [],
            textAligned: true,
          },
        })),
      })),
      arrangements: parsed.presentation.arrangements,
      source: { kind: 'pptx', fileId: parsed.deckHash, renderer: 'libreoffice' },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      archived: false,
    };
    const saved = PresentationSchema.parse(p);
    await save({ ...l, presentations: upsert(l.presentations, saved) });
    return saveJob(
      job('document', { presentationId: saved.id }, [
        `imported PowerPoint ${file.name} as pictures (page rendering uses fallback image in demo)`,
      ]),
    );
  }

  // Store geometry files
  for (const g of parsed.geoms) {
    await putFile(g.hash, new Blob([g.bytes as Uint8Array<ArrayBuffer>], { type: 'application/json' }));
  }

  // Store pictures and remap presentation media IDs
  const mediaMap = new Map<string, string>();
  let mediaList = l.media;
  for (const [, pic] of parsed.pictures) {
    const blob = new Blob([pic.bytes as Uint8Array<ArrayBuffer>], { type: pic.mime });
    const item = await mediaFromBlob(blob, pic.name, {
      isBackground: pic.isBackground,
      tags: ['pptx'],
    });
    if (pic.width) item.width ??= pic.width;
    if (pic.height) item.height ??= pic.height;
    if (pic.hasAlpha) item.hasAlpha = true;
    const existing = mediaList.find((x) => x.original.hash === item.original.hash);
    const chosenId = existing?.id ?? item.id;
    mediaMap.set(pic.key, chosenId);
    if (!existing) mediaList = [...mediaList, item];
  }

  // Apply media mapping across presentation (backgroundMediaId, slide backgrounds, image objects)
  parsed.presentation = remapMediaIds(parsed.presentation, mediaMap);

  // If there are loSlides, apply demo fallback images to those slides
  if (parsed.loSlides.length > 0) {
    for (const lo of parsed.loSlides) {
      for (const sec of parsed.presentation.sections) {
        const sl = sec.slides.find((s) => s.id === lo.slideId);
        if (!sl) continue;
        if (lo.class === 'picture') {
          sl.imported = {
            fileId: parsed.deckHash,
            page: lo.index + 1,
            imageMediaId: fallbacks.full.id,
            textBoxes: [],
            textAligned: true,
          };
          if (sl.pptx) delete sl.pptx.pending;
        } else if (lo.class === 'hybrid' && lo.art) {
          const artBox = { ...lo.art.box, rotation: 0 };
          const artImg: ImageObject = {
            id: newId(),
            type: 'image',
            box: artBox,
            mediaId: fallbacks.overlay.id,
            fit: 'contain',
            opacity: 1,
            radius: 0,
            origin: { src: 'pptx', role: 'art' },
          };
          const replaces = new Set(lo.art.replaces);
          sl.objects = sl.objects.filter((o) => !replaces.has(o.id));
          const beforeIdx = lo.art.before ? sl.objects.findIndex((o) => o.id === lo.art!.before) : -1;
          if (beforeIdx >= 0) sl.objects.splice(beforeIdx, 0, artImg);
          else sl.objects.push(artImg);
          if (sl.pptx) delete sl.pptx.pending;
        }
        if (lo.metafileObjects?.length && lo.class !== 'picture') {
          for (const mo of lo.metafileObjects) {
            const mfObj: ImageObject = { ...mo.object, mediaId: fallbacks.overlay.id };
            const beforeIdx = mo.before ? sl.objects.findIndex((o) => o.id === mo.before) : -1;
            if (beforeIdx >= 0) sl.objects.splice(beforeIdx, 0, mfObj);
            else sl.objects.push(mfObj);
          }
          if (sl.pptx) delete sl.pptx.pending;
        }
      }
    }
  }

  for (const sec of parsed.presentation.sections) {
    for (const sl of sec.slides) {
      if (sl.pptx) {
        sl.pptx.digest = slideObjectsDigest(sl.objects.filter((o) => o.origin));
      }
    }
  }

  // Save presentation
  const savedPres = PresentationSchema.parse({
    ...parsed.presentation,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  l = { ...l, media: mediaList, presentations: upsert(l.presentations, savedPres) };
  await save(l);

  const jobResult = {
    presentationId: savedPres.id,
    slides: parsed.classes.length,
    native: parsed.classes.filter((c) => c === 'native').length,
    hybrid: parsed.classes.filter((c) => c === 'hybrid').length,
    picture: parsed.classes.filter((c) => c === 'picture').length,
    compact: parsed.compact,
    pending: 0,
    missingFonts: parsed.missingFonts,
    notes: ['Imported natively in browser demo', ...parsed.notes],
  };

  return saveJob(job('pptx-native', jobResult, parsed.log));
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
    // design/27 M9: what the server tools allow. The pages demo has no LibreOffice and no poppler-utils, but
    // it imports PowerPoint (parsed in the browser) and PDF files and shows its placeholder pictures where a
    // hub's tools would draw them (a picture import, 'Show original', a hybrid slide's art, a PDF page), so
    // the operator offers those (`importDocumentUpload`, the pptx-reference route).
    if (path === '/capabilities')
      return json({
        libreoffice: { state: 'absent' },
        pdf: true,
        documents: ['pptx', 'ppsx', 'potx', 'pptm', 'pdf'],
        pptx: { pictures: true, reference: true, referencePdf: false, art: true },
      } satisfies HubCapabilities);

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
      // As the hub serves them (design/21): a sandboxed document that loads nothing, and an SVG downloads
      // when opened as a page, so a visitor's SVG never runs script on the demo's origin.
      const safe = (type: string): Record<string, string> => ({
        'content-type': type,
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
        ...(isSvgMime(type) ? { 'content-disposition': 'attachment' } : {}),
      });
      const own = await getFile(seg[1]);
      if (own) return new Response(own, { headers: safe(own.type || 'application/octet-stream') });
      const site = await fetch(new URL(`demo/files/${seg[1]}`, scope));
      if (!site.ok) return site;
      // The site serves the sample's files without an extension: their type is the library's.
      const type = mimeOfHash(await library(), seg[1]) ?? site.headers.get('content-type');
      return new Response(site.body, {
        status: site.status,
        headers: safe(type ?? 'application/octet-stream'),
      });
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
      if (m === 'GET' && seg[2] === 'revisions') {
        const p = l.presentations.find((x) => x.id === seg[1]);
        if (!p) return fail(404, 'not_found', 'No such presentation');
        type StoredRevision = { rev: number; savedAt: string; savedBy?: string; title: string; json: string };
        let revs = (await getDoc<StoredRevision[]>(`revs:${seg[1]}`)) ?? [];
        if (revs.length === 0) {
          const baseSavedAt = p.createdAt ?? nowIso();
          const curSavedAt = p.updatedAt ?? baseSavedAt;
          revs = [
            {
              rev: p.rev ?? 1,
              savedAt: curSavedAt,
              savedBy: 'operator',
              title: p.title,
              json: JSON.stringify(p),
            },
          ];
          if ((p.rev ?? 1) > 1) {
            for (let r = (p.rev ?? 1) - 1; r >= 1; r--) {
              revs.push({
                rev: r,
                savedAt: baseSavedAt,
                savedBy: 'sample',
                title: `${p.title} (rev ${r})`,
                json: JSON.stringify({ ...p, rev: r }),
              });
            }
          }
          await putDoc(`revs:${seg[1]}`, revs);
        }
        if (seg[3]) {
          const targetRev = Number(seg[3]);
          const found = revs.find((r) => r.rev === targetRev);
          if (!found) return fail(404, 'not_found', `Revision ${targetRev} not found`);
          return json(JSON.parse(found.json) as Presentation);
        }
        return json(revs.map(({ rev, savedAt, savedBy, title }) => ({ rev, savedAt, savedBy, title })));
      }
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
        const nextRev = (prev?.rev ?? 0) + 1;
        const p = PresentationSchema.parse({
          ...body,
          id: seg[1],
          rev: nextRev,
          updatedAt: nowIso(),
        });
        type StoredRevision = { rev: number; savedAt: string; savedBy?: string; title: string; json: string };
        const revs = (await getDoc<StoredRevision[]>(`revs:${seg[1]}`)) ?? [];
        if (prev && !revs.some((r) => r.rev === prev.rev)) {
          revs.unshift({
            rev: prev.rev,
            savedAt: prev.updatedAt ?? prev.createdAt ?? nowIso(),
            savedBy: 'operator',
            title: prev.title,
            json: JSON.stringify(prev),
          });
        }
        revs.unshift({
          rev: p.rev,
          savedAt: p.updatedAt ?? nowIso(),
          savedBy: 'operator',
          title: p.title,
          json: JSON.stringify(p),
        });
        await putDoc(`revs:${seg[1]}`, revs.slice(0, 50));
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
      if (m === 'POST' && seg[2] === 'restore') {
        const id = seg[1];
        const targetRev = Number(seg[3]);
        const cur = l.presentations.find((x) => x.id === id);
        if (!cur) return fail(404, 'not_found', 'No such presentation');
        type StoredRevision = { rev: number; savedAt: string; savedBy?: string; title: string; json: string };
        const revs = (await getDoc<StoredRevision[]>(`revs:${id}`)) ?? [];
        const old = revs.find((r) => r.rev === targetRev);
        if (!old) return fail(404, 'not_found', `Revision ${targetRev} not found`);
        const restored = JSON.parse(old.json) as Presentation;
        const nextRev = (cur.rev ?? 0) + 1;
        const p = PresentationSchema.parse({
          ...restored,
          id,
          rev: nextRev,
          updatedAt: nowIso(),
        });
        revs.unshift({
          rev: p.rev,
          savedAt: p.updatedAt ?? nowIso(),
          savedBy: 'operator (restored)',
          title: p.title,
          json: JSON.stringify(p),
        });
        await putDoc(`revs:${id}`, revs.slice(0, 50));
        await save({ ...l, presentations: upsert(l.presentations, p) });
        return json(p);
      }
      if (m === 'POST' && seg[4] === 'make-editable') return notInDemo('Making an imported slide editable');
      if (seg[2] === 'pptx-reference' && m === 'POST') {
        const p = l.presentations.find((x) => x.id === seg[1]);
        if (!p) return fail(404, 'not_found', 'No such presentation');
        const fallbacks = await ensureDemoFallbackMedia(l);
        const body = (await req.json().catch(() => ({}))) as { showPicture?: string[] };
        for (const sec of p.sections) {
          for (const sl of sec.slides) {
            if (!sl.pptx) continue;
            sl.pptx.refMediaId = fallbacks.full.id;
            if (body.showPicture && (body.showPicture.length === 0 || body.showPicture.includes(sl.id))) {
              sl.pptx.show = 'picture';
            }
          }
        }
        p.rev = (p.rev ?? 0) + 1;
        p.updatedAt = nowIso();
        await save({ ...fallbacks.nextLib, presentations: upsert(fallbacks.nextLib.presentations, p) });
        return json(
          await saveJob(job('pptx-reference', { presentationId: p.id }, ['Show original in demo'])),
          202,
        );
      }
      if (seg[2] === 'pptx-reimport') {
        const p = l.presentations.find((x) => x.id === seg[1]);
        if (!p) return fail(404, 'not_found', 'No such presentation');
        if (m === 'GET') {
          return json({
            presentationId: p.id,
            fileId: p.source?.fileId ?? '',
            slides: p.sections.flatMap((s) =>
              s.slides.map((sl, i) => ({
                slideId: sl.id,
                number: i + 1,
                kind: sl.pptx ? 'native' : 'other',
                action: 'regenerate',
                userObjects: sl.objects.filter((o) => !o.origin).length,
              })),
            ),
          });
        }
        if (m === 'POST') {
          return json(
            await saveJob(job('pptx-reimport', { presentationId: p.id, rev: p.rev }, ['Re-import in demo'])),
            202,
          );
        }
      }
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
      if (m === 'GET' && seg[2] === 'revisions') {
        const theme = l.themes.find((x) => x.id === seg[1]) ?? DEFAULT_THEME;
        if (seg[3]) return json(theme);
        return json([
          {
            rev: theme.rev ?? 1,
            savedAt: (theme as { updatedAt?: string }).updatedAt ?? nowIso(),
            savedBy: 'operator',
            title: theme.name,
          },
        ]);
      }
      if (m === 'POST' && seg[2] === 'restore') {
        const theme = l.themes.find((x) => x.id === seg[1]) ?? DEFAULT_THEME;
        const restored = { ...theme, rev: (theme.rev ?? 1) + 1, updatedAt: nowIso() };
        await save({ ...l, themes: upsert(l.themes, restored) });
        return json(restored);
      }
      if (m === 'GET') return json(l.themes.find((x) => x.id === seg[1]) ?? DEFAULT_THEME);
      if (m === 'POST' || m === 'PUT') {
        const body = (await req.json()) as Theme;
        const prev = l.themes.find((x) => x.id === (seg[1] ?? body.id));
        const t = ThemeSchema.parse({
          ...body,
          id: seg[1] ?? body.id ?? newId(),
          rev: m === 'POST' ? 1 : (prev?.rev ?? 0) + 1,
          updatedAt: nowIso(),
        });
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
        const rasters = form.getAll('raster').filter((f): f is File => f instanceof File);
        if (rasters.length && (rasters.length > 1 || files.length > 1))
          return fail(400, 'bad_request', 'A still picture (field "raster") comes with exactly one file');
        const isBackground = form.get('isBackground') === 'true' || form.get('isBackground') === '1';
        const out: Media[] = [];
        let media = l.media;
        for (const f of files) {
          let item = await mediaFromBlob(f, f.name, { isBackground });
          if (rasters[0]) {
            try {
              item = await withRaster(item, f, rasters[0]);
            } catch (e) {
              return fail(400, 'bad_raster', `${f.name}: ${(e as Error).message}`);
            }
          }
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
    if (path === '/import/document' && m === 'POST') {
      const form = await req.formData();
      const f = form.get('file');
      if (!(f instanceof File)) return fail(400, 'bad_request', 'No file');
      return json(await importDocumentUpload(f, form), 202);
    }

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

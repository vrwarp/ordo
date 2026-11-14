import { api, ApiFailure, upload } from '@ordo/client';
import { API_PREFIX } from '@ordo/protocol';
import {
  isSvgMime,
  type Media,
  SVG_HEAD_BYTES,
  SVG_MIME,
  svgIntrinsicSize,
  svgRasterSizeFor,
} from '@ordo/domain';

const CHUNK = 8 * 1024 * 1024;
const RESUMABLE_OVER = 24 * 1024 * 1024;
const RESUME_KEY = 'ordo.op.uploads';

type Resume = Record<string, { id: string; size: number }>;

function resumeMap(): Resume {
  try {
    return JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}') as Resume;
  } catch {
    return {};
  }
}
function saveResume(m: Resume): void {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}
const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

/** Whether a picked file is an SVG: by its type, else by its name (some pickers give no type). */
export function isSvgFile(f: Pick<File, 'name' | 'type'>): boolean {
  return isSvgMime(f.type) || (!f.type && /\.svg$/i.test(f.name));
}

/** How long drawing an SVG may take before it is uploaded without its still (the outputs then draw it). */
const RASTER_TIMEOUT_MS = 10_000;

/**
 * An SVG drawn into a PNG for the screens (design/12 "Media pipeline", design/14 "Pictures"): outputs cannot
 * decode an SVG in their workers, so the uploading client draws it through an `<img>` (no script runs in an
 * image; an animation shows its first frame) into a canvas of `svgRasterSizeFor` and uploads the PNG beside
 * it, which the hub keeps as its delivery. Undefined when it cannot be drawn here (no DOM, a decode error,
 * a canvas the SVG taints, past `RASTER_TIMEOUT_MS`): the SVG is uploaded alone and outputs draw it on their
 * main thread.
 */
export async function rasterizeSvg(file: Blob): Promise<Blob | undefined> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return undefined;
  const declared = svgIntrinsicSize(await file.slice(0, SVG_HEAD_BYTES).text());
  const url = URL.createObjectURL(new Blob([file], { type: SVG_MIME }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const img = new Image();
    img.src = url;
    await Promise.race([
      img.decode(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), RASTER_TIMEOUT_MS);
      }),
    ]);
    const size = svgRasterSizeFor(declared, { width: img.naturalWidth, height: img.naturalHeight });
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0, size.width, size.height);
    try {
      return (await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))) ?? undefined;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
}

/** The form of a one-request upload: the file, its still beside it (field "raster") and the fields. */
export function mediaForm(
  file: File,
  opts: { isBackground?: boolean; tags?: string[] },
  raster?: Blob,
): FormData {
  const fd = new FormData();
  fd.append('file', file, file.name);
  if (raster) fd.append('raster', raster, `${file.name.replace(/\.[^.]*$/, '') || 'still'}.png`);
  if (opts.isBackground) fd.append('isBackground', 'true');
  if (opts.tags?.length) fd.append('tags', opts.tags.join(','));
  return fd;
}

/** How often, and how far apart, a still is sent again while the hub is still processing its SVG (409 busy). */
const STILL_TRIES = 10;
const STILL_RETRY_MS = 1000;

/**
 * Send an SVG's still after the SVG (`PUT /media/:id/still`, design/12 "Media pipeline"): the resumable upload
 * carries the SVG alone. Sent again while the hub is processing the SVG (409 `busy`). The updated item, or
 * undefined when the hub refused the still (the SVG then stays without one, and the screens draw it themselves
 * within their cap).
 */
export async function sendStill(
  mediaId: string,
  name: string,
  raster: Blob,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Media | undefined> {
  for (let i = 0; i < STILL_TRIES; i++) {
    const fd = new FormData();
    fd.append('raster', raster, `${name.replace(/\.[^.]*$/, '') || 'still'}.png`);
    try {
      return await api<Media>(`/media/${encodeURIComponent(mediaId)}/still`, { method: 'PUT', body: fd });
    } catch (e) {
      if (!(e instanceof ApiFailure) || e.status !== 409 || e.code !== 'busy') return undefined;
      await wait(STILL_RETRY_MS);
    }
  }
  return undefined;
}

/**
 * Upload one media file with progress. Large files use the hub's resumable upload (create, then PATCH
 * chunks with Upload-Offset), so an interrupted upload from home continues where it stopped. An SVG goes in
 * one request with the still the screens draw (`rasterizeSvg`); one too large for that goes alone, and its
 * still follows once the hub has it (`sendStill`).
 */
export async function uploadMedia(
  file: File,
  opts: { isBackground?: boolean; tags?: string[] },
  onProgress: (frac: number) => void,
  signal?: AbortSignal,
  rasterize: (f: File) => Promise<Blob | undefined> = rasterizeSvg,
): Promise<Media> {
  if (file.size <= RESUMABLE_OVER) {
    const raster = isSvgFile(file) ? await rasterize(file) : undefined;
    const r = await upload<Media | Media[]>('/media', mediaForm(file, opts, raster), onProgress);
    return Array.isArray(r) ? r[0]! : r;
  }
  const key = fileKey(file);
  const map = resumeMap();
  let session = map[key];
  let offset = 0;
  if (session) {
    try {
      const st = await api<{ id: string; offset: number; size: number }>(`/media/uploads/${session.id}`);
      offset = st.offset;
    } catch {
      session = undefined;
    }
  }
  if (!session) {
    const created = await api<{ id: string; offset: number; size: number }>('/media/uploads', {
      method: 'POST',
      json: { name: file.name, size: file.size, isBackground: !!opts.isBackground, tags: opts.tags ?? [] },
    });
    session = { id: created.id, size: file.size };
    map[key] = session;
    saveResume(map);
  }
  for (;;) {
    if (signal?.aborted) throw new ApiFailure(0, 'aborted', 'Upload cancelled');
    onProgress(offset / file.size);
    const end = Math.min(file.size, offset + CHUNK);
    const res = await fetch(`${API_PREFIX}/media/uploads/${session.id}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' },
      body: file.slice(offset, end),
      signal,
    });
    const next = Number(res.headers.get('upload-offset'));
    if (res.status === 201) {
      const m = (await res.json()) as Media;
      delete map[key];
      saveResume(map);
      onProgress(1);
      if (!isSvgFile(file)) return m;
      const raster = await rasterize(file);
      return (raster && (await sendStill(m.id, file.name, raster))) || m;
    }
    if (res.status === 204) {
      offset = Number.isFinite(next) && next > offset ? next : end;
      continue;
    }
    if (res.status === 409 && Number.isFinite(next)) {
      offset = next;
      continue;
    }
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error: { message: string } }).error.message;
    } catch {
      /* not json */
    }
    throw new ApiFailure(res.status, 'upload_failed', msg);
  }
}

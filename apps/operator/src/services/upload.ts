import { api, ApiFailure, upload } from '@ordo/client';
import { API_PREFIX } from '@ordo/protocol';
import type { Media } from '@ordo/domain';

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

/**
 * Upload one media file with progress. Large files use the hub's resumable upload (create, then PATCH
 * chunks with Upload-Offset), so an interrupted upload from home continues where it stopped.
 */
export async function uploadMedia(
  file: File,
  opts: { isBackground?: boolean; tags?: string[] },
  onProgress: (frac: number) => void,
  signal?: AbortSignal,
): Promise<Media> {
  if (file.size <= RESUMABLE_OVER) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    if (opts.isBackground) fd.append('isBackground', 'true');
    if (opts.tags?.length) fd.append('tags', opts.tags.join(','));
    const r = await upload<Media | Media[]>('/media', fd, onProgress);
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
      return m;
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

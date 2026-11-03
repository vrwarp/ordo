import { fileUrl } from '@ordo/client';
import type { Font, Look, Media, Slide } from '@ordo/domain';
import { useEffect, useState } from 'react';
import type { ThumbIn, ThumbJob, ThumbOut } from '../workers/thumb.worker.ts';

const MAX_ENTRIES = 800;

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const slideHashes = new WeakMap<Slide, string>();
function slideHash(s: Slide): string {
  let h = slideHashes.get(s);
  if (!h) {
    h = fnv(JSON.stringify(s));
    slideHashes.set(s, h);
  }
  return h;
}

/** The file hash a media item shows as a still: the image itself, or a video's poster. */
export function stillHash(m: Media | undefined): string | undefined {
  if (!m) return undefined;
  if (m.kind === 'image') return (m.delivery ?? m.original).hash;
  if (m.kind === 'video') return m.poster?.hash;
  return undefined;
}

type Pending = { resolve: (url: string | undefined) => void };

/**
 * Client for the thumbnail worker. Results are JPEG object URLs cached by (slide content, background,
 * look, size), LRU-evicted. Newest requests render first so the visible grid fills quickly.
 */
class Thumbs {
  private worker?: Worker;
  private cache = new Map<string, string>();
  private inflight = new Map<string, Promise<string | undefined>>();
  private waiting = new Map<number, Pending>();
  private queue: { id: number; job: ThumbJob; key: string }[] = [];
  private busy = 0;
  private nextId = 1;
  private fontKey = '';

  private ensure(): Worker | undefined {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return undefined;
    try {
      this.worker = new Worker(new URL('../workers/thumb.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<ThumbOut>) => {
        const p = this.waiting.get(ev.data.id);
        this.waiting.delete(ev.data.id);
        this.busy--;
        p?.resolve(ev.data.blob ? URL.createObjectURL(ev.data.blob) : undefined);
        this.pump();
      };
    } catch {
      this.worker = undefined;
    }
    return this.worker;
  }

  setFonts(fonts: Font[]): void {
    const list = fonts.map((f) => ({ family: f.family, weight: f.weight, style: f.style, url: fileUrl(f.file.hash) }));
    const key = JSON.stringify(list);
    if (key === this.fontKey) return;
    this.fontKey = key;
    const msg: ThumbIn = { t: 'fonts', fonts: list.map((f) => ({ ...f, url: new URL(f.url, location.href).href })) };
    this.ensure()?.postMessage(msg);
    // Fonts changed: drop cached thumbnails so text re-renders with the right faces.
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
    this.version++;
  }

  version = 0;

  keyOf(job: ThumbJob): string {
    return `${slideHash(job.slide)}:${job.bg ?? ''}:${job.look?.id ?? 'authored'}:${job.width}:${this.version}`;
  }

  peek(key: string): string | undefined {
    return this.cache.get(key);
  }

  get(job: ThumbJob): Promise<string | undefined> {
    const key = this.keyOf(job);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    const w = this.ensure();
    if (!w) return Promise.resolve(undefined);
    const id = this.nextId++;
    const p = new Promise<string | undefined>((resolve) => {
      this.waiting.set(id, {
        resolve: (url) => {
          this.inflight.delete(key);
          if (url) {
            this.cache.set(key, url);
            while (this.cache.size > MAX_ENTRIES) {
              const first = this.cache.keys().next().value as string;
              const u = this.cache.get(first);
              if (u) URL.revokeObjectURL(u);
              this.cache.delete(first);
            }
          }
          resolve(url);
        },
      });
    });
    this.inflight.set(key, p);
    this.queue.push({ id, job, key });
    this.pump();
    return p;
  }

  private pump(): void {
    while (this.busy < 2 && this.queue.length) {
      const next = this.queue.pop()!;
      this.busy++;
      this.worker!.postMessage({ t: 'render', id: next.id, job: next.job } satisfies ThumbIn);
    }
  }
}

export const thumbs = new Thumbs();

/** Media-id to hash map for a slide's images. */
export function slideImages(slide: Slide, media: (id: string) => Media | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of slide.objects) {
    if (o.type !== 'image') continue;
    const h = stillHash(media(o.mediaId));
    if (h) out[o.mediaId] = h;
  }
  if (slide.imported) {
    const h = stillHash(media(slide.imported.imageMediaId));
    if (h) out[slide.imported.imageMediaId] = h;
  }
  return out;
}

/** React hook: a thumbnail URL for a slide once `visible` is true. */
export function useThumb(
  slide: Slide | undefined,
  opts: { look?: Look; isSong: boolean; bg?: string; media: (id: string) => Media | undefined; width?: number },
  visible: boolean,
): string | undefined {
  const width = opts.width ?? 320;
  const job: ThumbJob | undefined = slide
    ? {
        slide,
        look: opts.look,
        isSong: opts.isSong,
        bg: opts.bg,
        images: slideImages(slide, opts.media),
        width,
        height: Math.round((width * 9) / 16),
      }
    : undefined;
  const key = job ? thumbs.keyOf(job) : '';
  const [url, setUrl] = useState<string | undefined>(() => (key ? thumbs.peek(key) : undefined));
  useEffect(() => {
    if (!job || !visible) return;
    const hit = thumbs.peek(key);
    if (hit) {
      setUrl(hit);
      return;
    }
    let alive = true;
    void thumbs.get(job).then((u) => {
      if (alive && u) setUrl(u);
    });
    return () => {
      alive = false;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: key captures the job
  }, [key, visible]);
  return url;
}

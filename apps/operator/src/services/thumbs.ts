import { fileUrl, isControl, type Supervisor } from '@ordo/client';
import {
  type Font,
  type Look,
  type Media,
  type Slide,
  drawnMediaIds,
  isSvgMime,
  SVG_SCREEN_MAX_BYTES,
  stillFile,
} from '@ordo/domain';
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

/**
 * The file hash a media item shows as a still: the image itself, or a video's poster. The same file an
 * output draws for it (`stillFile`, design/27 §8), so thumbnails match the outputs.
 */
export function stillHash(m: Media | undefined): string | undefined {
  return m ? stillFile(m)?.hash : undefined;
}

/**
 * The file a media tile shows in the library, a picker or a background swatch: an SVG itself, where an
 * animated one moves (its still is what the screens draw, design/14 "Pictures"), else `stillHash`.
 */
export function tileHash(m: Media | undefined): string | undefined {
  return m && isSvgMime(m.original.mime) ? m.original.hash : stillHash(m);
}

/**
 * What a volunteer is told where an SVG is picked (design/15 "Media library"): the screens show it as a still,
 * an animated one at its first frame. One without its still (`delivery`: one this browser could not draw or
 * whose still the hub refused, or from before) is drawn by each Audience screen itself, during the service,
 * and not at all past `SVG_SCREEN_MAX_BYTES`.
 */
export function svgNote(m: Pick<Media, 'original' | 'delivery'> | undefined): string | undefined {
  if (!m || !isSvgMime(m.original.mime)) return undefined;
  if (!m.delivery)
    return m.original.bytes > SVG_SCREEN_MAX_BYTES
      ? `SVG without a still picture, over ${SVG_SCREEN_MAX_BYTES / 1024 ** 2} MB: Audience screens do not show it. Upload it again from this browser, or a PNG of it.`
      : 'SVG without a still picture: each Audience screen draws it itself when it is shown. Upload it again from this browser to give it one.';
  return 'SVG: Audience screens show it as a still picture (an animated one at its first frame); it moves in previews only.';
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

  private sup?: Supervisor;
  private fontMsg?: ThumbIn;
  private inWorker = new Map<number, { job: ThumbJob; key: string }>();

  /** Run the thumbnail worker under the operator's supervisor (restart on crash or missed heartbeats). */
  supervise(sup: Supervisor): void {
    if (this.sup === sup) return;
    this.sup = sup;
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
      this.requeueInFlight();
    }
  }

  private create(): Worker {
    return new Worker(new URL('../workers/thumb.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ordo-thumbs',
    });
  }

  private wire(w: Worker): void {
    this.worker = w;
    w.onmessage = (ev: MessageEvent<ThumbOut>) => {
      if (isControl(ev.data) || this.worker !== w) return;
      // A font that failed at first has loaded: thumbnails drawn before used a fallback for it.
      if (ev.data.t === 'fonts') {
        this.invalidate();
        return;
      }
      if (ev.data.t === 'decode') {
        const { id, hash } = ev.data;
        const img = new Image();
        img.src = fileUrl(hash);
        img.onload = async () => {
          try {
            const bmp = await createImageBitmap(img, { resizeWidth: 640, resizeQuality: 'medium' });
            w.postMessage({ t: 'decoded', id, hash, bmp } satisfies ThumbIn, [bmp]);
          } catch {
            w.postMessage({ t: 'decoded', id, hash } satisfies ThumbIn);
          }
        };
        img.onerror = () => {
          w.postMessage({ t: 'decoded', id, hash } satisfies ThumbIn);
        };
        return;
      }
      const p = this.waiting.get(ev.data.id);
      if (!p) return;
      this.waiting.delete(ev.data.id);
      this.inWorker.delete(ev.data.id);
      this.busy = Math.max(0, this.busy - 1);
      p.resolve(ev.data.blob ? URL.createObjectURL(ev.data.blob) : undefined);
      this.pump();
    };
    if (this.fontMsg) w.postMessage(this.fontMsg);
  }

  /** A restarted worker lost its jobs: render them again (newest first, like any other request). */
  private requeueInFlight(): void {
    for (const [id, j] of this.inWorker) this.queue.push({ id, job: j.job, key: j.key });
    this.inWorker.clear();
    this.busy = 0;
  }

  private ensure(): Worker | undefined {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return undefined;
    try {
      if (this.sup) {
        if (!this.sup.worker('thumbs'))
          this.sup.add<Worker>({
            name: 'thumbs',
            create: () => this.create(),
            start: (w, gen) => {
              if (gen > 0) this.requeueInFlight();
              this.wire(w);
              this.pump();
            },
            stop: () => {
              this.worker = undefined;
            },
            // A large image decode can hold the worker for a while; it is not on the live path.
            deadAfterMs: 5000,
          });
      } else this.wire(this.create());
    } catch {
      this.worker = undefined;
    }
    return this.worker;
  }

  setFonts(fonts: Font[]): void {
    const list = fonts.map((f) => ({
      family: f.family,
      weight: f.weight,
      style: f.style,
      hash: f.file.hash,
      url: fileUrl(f.file.hash),
    }));
    const key = JSON.stringify(list);
    if (key === this.fontKey) return;
    this.fontKey = key;
    const msg: ThumbIn = {
      t: 'fonts',
      fonts: list.map((f) => ({ ...f, url: new URL(f.url, location.href).href })),
    };
    this.fontMsg = msg;
    this.ensure()?.postMessage(msg);
    // Fonts changed: drop cached thumbnails so text re-renders with the right faces.
    this.invalidate();
  }

  /** Drop every cached thumbnail: the next request of each draws it again. */
  private invalidate(): void {
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
    this.version++;
  }

  version = 0;

  keyOf(job: ThumbJob): string {
    const extra =
      job.clear || job.nextSlide || job.presentationKind
        ? // Look previews: the look's content too (an edited look re-renders under the same id).
          `:${job.look ? fnv(JSON.stringify(job.look)) : ''}:${job.clear ? Object.values(job.clear).join(',') : ''}:${job.nextSlide ? slideHash(job.nextSlide) : ''}:${job.presentationKind ?? ''}`
        : '';
    return `${slideHash(job.slide)}:${job.bg ?? ''}:${job.look?.id ?? 'authored'}:${job.width}:${this.version}${extra}`;
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
    const w = this.worker;
    if (!w) return;
    while (this.busy < 2 && this.queue.length) {
      const next = this.queue.pop()!;
      this.busy++;
      this.inWorker.set(next.id, { job: next.job, key: next.key });
      w.postMessage({ t: 'render', id: next.id, job: next.job } satisfies ThumbIn);
    }
  }
}

export const thumbs = new Thumbs();

/**
 * Media-id to hash map for the pictures a slide draws (`drawnMediaIds`, the outputs' rule of design/27 §5):
 * its PowerPoint reference picture or imported page, then its image objects (only the operator's own on a
 * reference picture), a video by its poster.
 */
export function slideImages(slide: Slide, media: (id: string) => Media | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of drawnMediaIds(slide)) {
    const h = stillHash(media(id));
    if (h) out[id] = h;
  }
  return out;
}

/** React hook: a thumbnail URL for a slide once `visible` is true. */
export function useThumb(
  slide: Slide | undefined,
  opts: {
    look?: Look;
    isSong: boolean;
    bg?: string;
    media: (id: string) => Media | undefined;
    width?: number;
  },
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency list
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
  }, [key, visible]);
  return url;
}

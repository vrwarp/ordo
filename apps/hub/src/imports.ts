import { createHash } from 'node:crypto';
import { copyFile, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_THEME,
  type ExtractedText,
  type ImageObject,
  newId,
  parseLyrics,
  type Playlist,
  type Presentation,
  type Slide,
  songFromParsed,
  type TextObject,
  type Theme,
} from '@ordo/domain';
import * as realImporters from '@ordo/importers';
import { extractZip, ZIP_MAX_IN_MEMORY_BYTES } from '@ordo/importers/zip-stream.ts';
import type { Logger } from 'pino';
import type { HubConfig } from './config.ts';
import { badRequest, errorMessage, forbidden } from './errors.ts';
import type { JobCtx, JobQueue } from './jobs.ts';
import type { Library } from './library.ts';
import { fitPage, pdfToPngs, pptxToPdf } from './media/ffmpeg.ts';
import { baseName, type MediaService } from './media/service.ts';
import type { Store } from './store.ts';

export type Pro7Result = {
  presentations: Presentation[];
  playlists: Playlist[];
  media: { key: string; path: string }[];
  log: { level: 'info' | 'warn' | 'error'; item?: string; message: string }[];
  protoVersion: string;
};
export type PptxText = {
  slideSize: { cx: number; cy: number };
  slides: { index: number; boxes: ExtractedText[] }[];
};
/** The parts of @ordo/importers the hub uses (injectable for tests). */
export type Importers = {
  importPro7?: (files: Map<string, Uint8Array>) => Pro7Result | Promise<Pro7Result>;
  remapMediaIds?: <T>(obj: T, map: Map<string, string>) => T;
  readZip?: (buf: Uint8Array) => Promise<Map<string, Uint8Array>>;
  extractPptxText?: (buf: Uint8Array) => Promise<PptxText>;
};

const MEDIA_EXT =
  /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|jpe?g|png|gif|bmp|tiff?|heic|webp|wav|mp3|aac|m4a|flac|ogg|aiff?)$/i;
const MAX_DIR_FILES = 20_000;
const MAX_INLINE_BYTES = 64 * 1024 * 1024;
/** Documents held in memory for one import (zip or folder); media never counts, it stays on disk. */
export const MAX_IMPORT_MEMORY_BYTES = ZIP_MAX_IN_MEMORY_BYTES;

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Resume points of a ProPresenter import, kept in the job payload after every item so a job re-queued by
 * a crash or restart skips what it already wrote instead of duplicating it.
 */
export type Pro7Progress = {
  /** importer media key -> media id */
  media: Record<string, string>;
  /** original presentation id -> saved id */
  presentations: Record<string, string>;
  /** original playlist id -> saved id */
  playlists: Record<string, string>;
};
export type Pro7Payload = { upload?: string; path?: string; name?: string; done?: Pro7Progress };
export type DocPayload = { hash: string; name: string; ext: 'pdf' | 'pptx'; done?: Record<number, string> };

/** Files the importer sees: documents in memory, media as empty placeholders backed by `onDisk`. */
type ImportFiles = { files: Map<string, Uint8Array>; onDisk: Map<string, string> };

export class ImportService {
  private imp: Importers;

  constructor(
    private lib: Library,
    private store: Store,
    private jobs: JobQueue,
    private media: MediaService,
    private cfg: HubConfig,
    private log: Logger,
  ) {
    this.imp = (cfg.importers as Importers | undefined) ?? (realImporters as unknown as Importers);
    jobs.register<Pro7Payload>('pro7-import', (ctx) => this.pro7Job(ctx));
    jobs.register<DocPayload>('document', (ctx) => this.documentJob(ctx));
  }

  theme(p?: { themeId?: string }): Theme {
    const general = this.lib.getSetting('general');
    return (
      (p?.themeId ? this.lib.themes.get(p.themeId) : undefined) ??
      (general.defaultThemeId ? this.lib.themes.get(general.defaultThemeId) : undefined) ??
      DEFAULT_THEME
    );
  }

  /** SongSelect lyrics/ChordPro text → a saved song presentation. */
  songselect(text: string, opts: { title?: string; by?: string }): Presentation {
    const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (!clean.trim()) throw badRequest('No lyrics text');
    if (clean.length > 1_000_000) throw badRequest('Lyrics text is too long');
    const parsed = parseLyrics(clean);
    if (!parsed.sections.length) throw badRequest('No lyric sections found');
    const p = songFromParsed(parsed, {
      title: opts.title?.trim() || undefined,
      linesPerSlide: this.lib.getSetting('general').defaultLinesPerSlide,
      theme: this.theme(),
      source: { kind: 'songselect' },
    });
    const saved = this.lib.savePresentation(p, { create: true, by: opts.by });
    this.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
    return saved;
  }

  // ---- ProPresenter 7 ----
  async queuePro7FromPath(path: string) {
    const abs = resolve(path);
    const real = await realpath(abs).catch(() => {
      throw badRequest(`Path not found: ${path}`);
    });
    const roots = await Promise.all(this.cfg.importRoots.map((r) => realpath(r).catch(() => r)));
    if (!roots.some((r) => real === r || real.startsWith(r + sep)))
      throw forbidden(`Imports may only read from ${this.cfg.importRoots.join(', ')}`);
    return this.jobs.enqueue('pro7-import', { path: real, name: baseName(real) }, 'light');
  }

  queuePro7FromUpload(uploadPath: string, name: string) {
    return this.jobs.enqueue('pro7-import', { upload: uploadPath, name }, 'light');
  }

  private async readDir(root: string): Promise<ImportFiles> {
    const files = new Map<string, Uint8Array>();
    const onDisk = new Map<string, string>();
    let inMemory = 0;
    const walk = async (dir: string) => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        if (files.size >= MAX_DIR_FILES)
          throw new Error(`More than ${MAX_DIR_FILES} files in the import folder`);
        if (ent.name.startsWith('.')) continue;
        const p = join(dir, ent.name);
        if (ent.isDirectory()) await walk(p);
        else if (ent.isFile()) {
          const rel = relative(root, p).split(sep).join('/');
          const st = await stat(p);
          if (MEDIA_EXT.test(ent.name) || st.size > MAX_INLINE_BYTES) {
            // Only the key matters for media resolution; bytes are read from disk on upload.
            files.set(rel, new Uint8Array(0));
            onDisk.set(rel, p);
          } else {
            inMemory += st.size;
            if (inMemory > MAX_IMPORT_MEMORY_BYTES)
              throw new Error(
                `The folder holds more than ${Math.round(MAX_IMPORT_MEMORY_BYTES / 1024 ** 2)} MB of documents; import it in parts`,
              );
            files.set(rel, await readFile(p));
          }
        }
      }
    };
    await walk(root);
    return { files, onDisk };
  }

  /** Stream an uploaded zip: documents in memory (capped), media spilled to a scratch directory. */
  private async readZipUpload(upload: string, dir: string, signal: AbortSignal): Promise<ImportFiles> {
    const r = await extractZip(upload, {
      dir,
      spill: (path, size) => MEDIA_EXT.test(path) || size > MAX_INLINE_BYTES,
      maxInMemoryBytes: MAX_IMPORT_MEMORY_BYTES,
      signal,
    });
    return { files: r.files, onDisk: r.onDisk };
  }

  /**
   * Decode the library off the event loop. The injected importer (tests) runs inline; the real one runs in
   * a worker thread, falling back to inline decoding (with a warning) if the worker cannot start.
   */
  private async decodePro7(files: Map<string, Uint8Array>, ctx: JobCtx<Pro7Payload>): Promise<Pro7Result> {
    const importPro7 = this.imp.importPro7!;
    if (importPro7 !== (realImporters as unknown as Importers).importPro7) return importPro7(files);
    try {
      return await importPro7InWorker(files, ctx.signal);
    } catch (e) {
      if (!(e instanceof WorkerStartError)) throw e;
      this.log.warn({ err: e.message }, 'import worker unavailable; decoding on the main thread');
      ctx.log(`[warn] import worker unavailable (${e.message}); decoding on the main thread`);
      return importPro7(files);
    }
  }

  private async pro7Job(ctx: JobCtx<Pro7Payload>) {
    const { importPro7, remapMediaIds } = this.imp;
    if (!importPro7 || !remapMediaIds) throw new Error('The ProPresenter importer is not available');
    const pl = ctx.payload;
    const done: Pro7Progress = pl.done ?? { media: {}, presentations: {}, playlists: {} };
    const resumed = Object.keys(done.media).length + Object.keys(done.presentations).length;
    if (resumed) ctx.log(`resuming: ${resumed} item(s) already imported`);
    const save = () => ctx.setPayload({ ...pl, done });
    const scratch = await this.store.tmpDir();
    try {
      let files: Map<string, Uint8Array>;
      let onDisk: Map<string, string>;
      let fromFolder = false;
      if (pl.upload) {
        ctx.log(`reading zip ${pl.name ?? ''}`);
        ({ files, onDisk } = await this.readZipUpload(pl.upload, scratch, ctx.signal));
      } else if (pl.path) {
        ctx.log(`reading folder ${pl.path}`);
        ({ files, onDisk } = await this.readDir(pl.path));
        fromFolder = true;
      } else throw new Error('Nothing to import');
      ctx.log(`${files.size} file(s), ${onDisk.size} media file(s) on disk`);
      ctx.progress(0.1);
      const result = await this.decodePro7(files, ctx);
      files.clear();
      for (const l of result.log) ctx.log(`[${l.level}] ${l.item ? `${l.item}: ` : ''}${l.message}`);

      const map = new Map<string, string>(Object.entries(done.media));
      let i = 0;
      for (const m of result.media) {
        if (ctx.signal.aborted) throw new Error('cancelled');
        i++;
        ctx.progress(0.1 + (0.6 * i) / Math.max(1, result.media.length));
        if (map.has(m.key)) continue;
        try {
          const disk = onDisk.get(m.path);
          let tmp: string;
          if (disk) {
            // Folder imports copy (the NAS folder is read-only to us); zip spills are ours to move.
            if (fromFolder) {
              tmp = this.store.tmpPath();
              await copyFile(disk, tmp);
            } else tmp = disk;
          } else {
            throw new Error('file not in the import');
          }
          const id = await this.mediaFor(tmp, m.path);
          map.set(m.key, id);
          done.media[m.key] = id;
          save();
        } catch (e) {
          ctx.log(`[warn] media ${m.path}: ${errorMessage(e)}`);
        }
      }

      const presIds = new Map<string, string>(Object.entries(done.presentations));
      for (const p0 of result.presentations) {
        if (ctx.signal.aborted) throw new Error('cancelled');
        if (presIds.has(p0.id)) continue;
        try {
          const p = remapMediaIds(p0, map);
          const saved = this.savePro7Presentation(p);
          presIds.set(p0.id, saved.id);
          done.presentations[p0.id] = saved.id;
          save();
        } catch (e) {
          ctx.log(`[error] ${p0.title}: ${errorMessage(e)}`);
        }
      }
      ctx.progress(0.9);
      const plIds = new Map<string, string>(Object.entries(done.playlists));
      for (const pl0 of result.playlists) {
        if (ctx.signal.aborted) throw new Error('cancelled');
        if (plIds.has(pl0.id)) continue;
        try {
          const p = remapMediaIds(pl0, map);
          const items = p.items.map((it) =>
            it.kind === 'presentation'
              ? { ...it, presentationId: presIds.get(it.presentationId) ?? it.presentationId }
              : it,
          );
          const saved = this.savePro7Playlist({ ...p, items });
          plIds.set(pl0.id, saved.id);
          done.playlists[pl0.id] = saved.id;
          save();
        } catch (e) {
          ctx.log(`[error] playlist ${pl0.name}: ${errorMessage(e)}`);
        }
      }
      if (pl.upload) await rm(pl.upload, { force: true });
      ctx.log(
        `imported ${presIds.size} presentation(s), ${plIds.size} playlist(s), ${map.size} media file(s)`,
      );
      return {
        presentations: presIds.size,
        playlists: plIds.size,
        media: map.size,
        protoVersion: result.protoVersion,
        log: result.log,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Save an imported presentation under its ProPresenter id: importing the same library twice (or resuming
   * after a crash before the resume point was written) updates the earlier copy instead of duplicating it.
   * An id that belongs to a presentation from another source gets a fresh id.
   */
  private savePro7Presentation(p: Presentation): Presentation {
    const existing = this.lib.presentations.get(p.id);
    let saved: Presentation;
    if (existing && existing.source?.kind === 'pro7')
      saved = this.lib.savePresentation(
        { ...p, rev: existing.rev },
        { expectedRev: existing.rev, by: 'pro7-import' },
      );
    else
      saved = this.lib.savePresentation(
        { ...p, id: existing ? newId() : p.id },
        { create: true, by: 'pro7-import' },
      );
    this.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
    return saved;
  }

  private savePro7Playlist(p: Playlist): Playlist {
    const existing = this.lib.playlists.get(p.id);
    const saved = existing
      ? this.lib.playlists.update(p.id, { ...p, rev: existing.rev })
      : this.lib.playlists.insert(p);
    this.lib.emit([{ kind: 'playlist', id: saved.id, rev: saved.rev, entity: saved }]);
    return saved;
  }

  /** Reuse an existing media item with the same original content, else ingest a new one. */
  private async mediaFor(tmp: string, path: string): Promise<string> {
    const buf = await readFile(tmp);
    const hash = createHash('sha256').update(buf).digest('hex');
    const existing = this.lib.media.list().find((m) => m.original.hash === hash);
    if (existing) {
      await rm(tmp, { force: true });
      return existing.id;
    }
    const m = await this.media.ingest({ path: tmp, hash, bytes: buf.length }, path, { tags: ['pro7'] });
    return m.id;
  }

  // ---- PPTX / PDF ----
  queueDocument(hash: string, name: string, ext: 'pdf' | 'pptx') {
    return this.jobs.enqueue('document', { hash, name, ext } satisfies DocPayload, 'heavy');
  }

  private async documentJob(ctx: JobCtx<DocPayload>): Promise<{ presentationId: string; pages: number }> {
    const { hash, name, ext } = ctx.payload;
    // Page images already stored by an earlier attempt of this job (crash or restart) are reused.
    const done: Record<number, string> = { ...(ctx.payload.done ?? {}) };
    if (Object.keys(done).length) ctx.log(`resuming: ${Object.keys(done).length} page(s) already stored`);
    const file = this.lib.getFile(hash);
    if (!file) throw new Error('The uploaded document is missing');
    const t = this.cfg.timeouts;
    const dir = await this.store.tmpDir();
    try {
      let pdf = this.store.abs(file.path);
      let text: PptxText | undefined;
      if (ext === 'pptx') {
        const input = join(dir, 'slides.pptx');
        await copyFile(pdf, input);
        if (this.imp.extractPptxText) {
          try {
            text = await this.imp.extractPptxText(await readFile(input));
            ctx.log(`extracted text from ${text.slides.length} slide(s)`);
          } catch (e) {
            ctx.log(`[warn] text extraction failed: ${errorMessage(e)}`);
          }
        } else ctx.log('[warn] PPTX text extraction is not available');
        ctx.log('converting with LibreOffice');
        pdf = await pptxToPdf(input, dir, { timeoutMs: t.soffice, signal: ctx.signal });
        ctx.progress(0.3);
      }
      ctx.log('rendering pages');
      const pagesDir = join(dir, 'pages');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(pagesDir);
      const pages = await pdfToPngs(pdf, pagesDir, { timeoutMs: t.pdf, signal: ctx.signal });
      if (!pages.length) throw new Error('The document has no pages');
      ctx.log(`${pages.length} page(s)`);
      const title = baseName(name);
      const slides: Slide[] = [];
      for (let i = 0; i < pages.length; i++) {
        if (ctx.signal.aborted) throw new Error('cancelled');
        let imageMediaId = done[i + 1];
        if (!imageMediaId || !this.lib.media.get(imageMediaId)) {
          const out = join(dir, `slide-${i + 1}.png`);
          await fitPage(pages[i]!, out, { timeoutMs: t.light, signal: ctx.signal });
          const m = await this.media.addReadyImage(out, `${title} – ${i + 1}`, {
            width: 1920,
            height: 1080,
            tags: ['document'],
          });
          imageMediaId = m.id;
          done[i + 1] = m.id;
          ctx.setPayload({ ...ctx.payload, done });
        }
        const boxes = text?.slides.find((s) => s.index === i + 1)?.boxes;
        slides.push({
          id: newId(),
          objects: [],
          imported: {
            fileId: hash,
            page: i + 1,
            imageMediaId,
            ...(boxes?.length ? { textBoxes: boxes } : {}),
          },
        });
        ctx.progress(0.3 + (0.65 * (i + 1)) / pages.length);
      }
      const sectionId = newId();
      const pres: Presentation = {
        id: newId(),
        rev: 1,
        title,
        kind: 'slides',
        meta: { tags: [] },
        sections: [{ id: sectionId, label: 'Slides', short: 'S', slides }],
        arrangements: [{ id: newId(), name: 'Default', sectionIds: [sectionId] }],
        source: { kind: ext, fileId: hash },
        archived: false,
      };
      const saved = this.lib.savePresentation(pres, { create: true, by: `${ext}-import` });
      this.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
      return { presentationId: saved.id, pages: pages.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Turn an imported page's extracted text boxes into editable text objects over the page image. */
  makeEditable(presentationId: string, slideId: string, by?: string): Presentation {
    const p = this.lib.presentations.must(presentationId);
    let found: Slide | undefined;
    const theme = this.theme(p);
    const sections = p.sections.map((sec) => ({
      ...sec,
      slides: sec.slides.map((sl) => {
        if (sl.id !== slideId) return sl;
        found = sl;
        if (!sl.imported) return sl;
        const back: ImageObject = {
          id: newId(),
          type: 'image',
          box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
          mediaId: sl.imported.imageMediaId,
          fit: 'contain',
          opacity: 1,
          radius: 0,
        };
        const texts: TextObject[] = (sl.imported.textBoxes ?? []).map((tb) => ({
          id: newId(),
          type: 'text',
          box: { ...tb.box, rotation: tb.box.rotation ?? 0 },
          text: tb.text,
          style: {
            ...theme.textBoxDefaults,
            fontSizePx: tb.fontSizePx ?? theme.textBoxDefaults.fontSizePx,
            align: 'left',
            valign: 'top',
          },
          opacity: 1,
        }));
        const { imported: _i, ...rest } = sl;
        return { ...rest, objects: [back, ...sl.objects, ...texts] };
      }),
    }));
    if (!found) throw badRequest(`Slide ${slideId} not found`, 'not_found');
    if (!found.imported) throw badRequest('Not an imported slide', 'not_imported');
    const saved = this.lib.savePresentation({ ...p, sections }, { expectedRev: p.rev, by });
    this.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
    return saved;
  }
}

/** The worker could not be started (no worker file, unsupported flags): the caller decodes inline. */
export class WorkerStartError extends Error {}

/** Where the worker entry lives: next to this module, `.ts` from source (tsx) or `.js` in the bundle. */
export function importWorkerUrl(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './import.worker.ts' : './import.worker.js', here);
}

/** Run `importPro7` in a worker thread; buffers that own their ArrayBuffer are transferred, not copied. */
export function importPro7InWorker(
  files: Map<string, Uint8Array>,
  signal?: AbortSignal,
): Promise<Pro7Result> {
  return new Promise((resolve, reject) => {
    const url = importWorkerUrl();
    const transfer: ArrayBuffer[] = [];
    for (const b of files.values())
      if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer)
        transfer.push(b.buffer);
    const fromSource = url.pathname.endsWith('.ts');
    let worker: Worker;
    try {
      worker = new Worker(url, {
        workerData: { files },
        transferList: transfer,
        // From source the worker needs the TypeScript loader; the bundle inherits the process flags.
        ...(fromSource ? { execArgv: ['--import', 'tsx'] } : {}),
      });
    } catch (e) {
      reject(new WorkerStartError(errorMessage(e)));
      return;
    }
    let started = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
      void worker.terminate();
    };
    const onAbort = () => finish(() => reject(new Error('cancelled')));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.on('online', () => {
      started = true;
    });
    worker.on('message', (m: { ok: true; result: Pro7Result } | { ok: false; error: string }) => {
      finish(() => (m.ok ? resolve(m.result) : reject(new Error(m.error))));
    });
    worker.on('error', (e) => {
      finish(() => reject(started ? e : new WorkerStartError(errorMessage(e))));
    });
    worker.on('exit', (code) => {
      finish(() => reject(new WorkerStartError(`import worker exited with code ${code}`)));
    });
  });
}

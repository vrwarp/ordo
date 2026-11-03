import { createHash } from 'node:crypto';
import { copyFile, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
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

const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|jpe?g|png|gif|bmp|tiff?|heic|webp|wav|mp3|aac|m4a|flac|ogg|aiff?)$/i;
const MAX_DIR_FILES = 20_000;
const MAX_INLINE_BYTES = 64 * 1024 * 1024;

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

type Pro7Payload = { upload?: string; path?: string; name?: string };
type DocPayload = { hash: string; name: string; ext: 'pdf' | 'pptx' };

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

  private async readDir(root: string): Promise<{ files: Map<string, Uint8Array>; onDisk: Set<string> }> {
    const files = new Map<string, Uint8Array>();
    const onDisk = new Set<string>();
    const walk = async (dir: string) => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        if (files.size >= MAX_DIR_FILES) throw new Error(`More than ${MAX_DIR_FILES} files in the import folder`);
        if (ent.name.startsWith('.')) continue;
        const p = join(dir, ent.name);
        if (ent.isDirectory()) await walk(p);
        else if (ent.isFile()) {
          const rel = relative(root, p).split(sep).join('/');
          const st = await stat(p);
          if (MEDIA_EXT.test(ent.name) || st.size > MAX_INLINE_BYTES) {
            // Only the key matters for media resolution; bytes are read from disk on upload.
            files.set(rel, new Uint8Array(0));
            onDisk.add(rel);
          } else files.set(rel, await readFile(p));
        }
      }
    };
    await walk(root);
    return { files, onDisk };
  }

  private async pro7Job(ctx: JobCtx<Pro7Payload>) {
    const { importPro7, remapMediaIds, readZip } = this.imp;
    if (!importPro7 || !remapMediaIds || !readZip) throw new Error('The ProPresenter importer is not available');
    const pl = ctx.payload;
    let files: Map<string, Uint8Array>;
    let onDisk = new Set<string>();
    if (pl.upload) {
      ctx.log(`reading zip ${pl.name ?? ''}`);
      files = await readZip(await readFile(pl.upload));
    } else if (pl.path) {
      ctx.log(`reading folder ${pl.path}`);
      ({ files, onDisk } = await this.readDir(pl.path));
    } else throw new Error('Nothing to import');
    ctx.log(`${files.size} file(s)`);
    ctx.progress(0.1);
    const result = await importPro7(files);
    for (const l of result.log) ctx.log(`[${l.level}] ${l.item ? `${l.item}: ` : ''}${l.message}`);

    const map = new Map<string, string>();
    let mediaCount = 0;
    let i = 0;
    for (const m of result.media) {
      if (ctx.signal.aborted) throw new Error('cancelled');
      i++;
      ctx.progress(0.1 + (0.6 * i) / Math.max(1, result.media.length));
      try {
        let id: string;
        if (onDisk.has(m.path) && pl.path) {
          const abs = join(pl.path, ...m.path.split('/'));
          const tmp = this.store.tmpPath();
          await copyFile(abs, tmp);
          id = await this.mediaFor(tmp, m.path);
        } else {
          const bytes = files.get(m.path);
          if (!bytes?.length) throw new Error('file not in the import');
          const tmp = this.store.tmpPath();
          const { writeFile } = await import('node:fs/promises');
          await writeFile(tmp, bytes);
          id = await this.mediaFor(tmp, m.path);
        }
        map.set(m.key, id);
        mediaCount++;
      } catch (e) {
        ctx.log(`[warn] media ${m.path}: ${errorMessage(e)}`);
      }
    }

    const presIds = new Map<string, string>();
    let presCount = 0;
    for (const p0 of result.presentations) {
      try {
        const p = remapMediaIds(p0, map);
        const id = this.lib.presentations.get(p.id) ? newId() : p.id;
        presIds.set(p.id, id);
        const saved = this.lib.savePresentation({ ...p, id }, { create: true, by: 'pro7-import' });
        this.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
        presCount++;
      } catch (e) {
        ctx.log(`[error] ${p0.title}: ${errorMessage(e)}`);
      }
    }
    ctx.progress(0.9);
    let plCount = 0;
    for (const pl0 of result.playlists) {
      try {
        const p = remapMediaIds(pl0, map);
        const items = p.items.map((it) =>
          it.kind === 'presentation' ? { ...it, presentationId: presIds.get(it.presentationId) ?? it.presentationId } : it,
        );
        const saved = this.lib.playlists.insert({ ...p, id: this.lib.playlists.get(p.id) ? newId() : p.id, items });
        this.lib.emit([{ kind: 'playlist', id: saved.id, rev: saved.rev, entity: saved }]);
        plCount++;
      } catch (e) {
        ctx.log(`[error] playlist ${pl0.name}: ${errorMessage(e)}`);
      }
    }
    if (pl.upload) await rm(pl.upload, { force: true });
    ctx.log(`imported ${presCount} presentation(s), ${plCount} playlist(s), ${mediaCount} media file(s)`);
    return {
      presentations: presCount,
      playlists: plCount,
      media: mediaCount,
      protoVersion: result.protoVersion,
      log: result.log,
    };
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
        const out = join(dir, `slide-${i + 1}.png`);
        await fitPage(pages[i]!, out, { timeoutMs: t.light, signal: ctx.signal });
        const m = await this.media.addReadyImage(out, `${title} – ${i + 1}`, {
          width: 1920,
          height: 1080,
          tags: ['document'],
        });
        const boxes = text?.slides.find((s) => s.index === i + 1)?.boxes;
        slides.push({
          id: newId(),
          objects: [],
          imported: { fileId: hash, page: i + 1, imageMediaId: m.id, ...(boxes?.length ? { textBoxes: boxes } : {}) },
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

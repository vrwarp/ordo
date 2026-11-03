import { readFile } from 'node:fs/promises';
import type { Font } from '@ordo/domain';
import type { Logger } from 'pino';
import type { HubConfig } from '../config.ts';
import { badRequest, HttpError } from '../errors.ts';
import type { JobCtx, JobQueue } from '../jobs.ts';
import type { Library } from '../library.ts';
import { extOf, readHead, sniff, type Store } from '../store.ts';
import { fetchFamilyCss, parseFontCss } from './google.ts';
import { type FontFace, faceFromFilename, readFontFace } from './sfnt.ts';

const FONT_MIME: Record<string, string> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};
const MAX_FONT_BYTES = 50 * 1024 * 1024;

export class FontService {
  constructor(
    private lib: Library,
    private store: Store,
    private jobs: JobQueue,
    private cfg: HubConfig,
    private log: Logger,
  ) {
    jobs.register<{ family: string }>('font-google', (ctx) => this.googleJob(ctx));
  }

  /**
   * Add an uploaded font file. Family/weight/style come from the font's name and OS/2 tables; form fields
   * override them; the filename is the last resort.
   */
  async addUpload(
    file: { path: string; hash: string; bytes: number },
    filename: string,
    fields: { family?: string; weight?: string | number; style?: string },
  ): Promise<Font> {
    if (file.bytes > MAX_FONT_BYTES) throw new HttpError(413, 'too_large', 'Font files are limited to 50 MB');
    const s = sniff(await readHead(file.path));
    if (s?.kind !== 'font')
      throw new HttpError(415, 'unsupported_font', `${filename}: not a TTF, OTF, WOFF or WOFF2 font`);
    const ext = extOf(filename);
    if (ext && !(ext in FONT_MIME))
      throw new HttpError(415, 'extension_mismatch', `${filename}: unexpected extension`);
    let face: FontFace;
    try {
      face = readFontFace(await readFile(file.path));
    } catch (e) {
      this.log.info({ file: filename, err: (e as Error).message }, 'font tables unreadable; using filename');
      face = faceFromFilename(filename);
    }
    if (fields.family?.trim()) face.family = fields.family.trim();
    if (fields.weight !== undefined && fields.weight !== '') {
      const w = Number(fields.weight);
      if (!Number.isFinite(w) || w < 1 || w > 1000) throw badRequest('weight must be 1..1000');
      face.weight = w;
    }
    if (fields.style === 'italic' || fields.style === 'normal') face.style = fields.style;
    const ref = await this.store.put(file.path, {
      ext: s.ext,
      mime: FONT_MIME[s.ext] ?? s.mime,
      dir: 'fonts',
      hash: file.hash,
      bytes: file.bytes,
    });
    const font = this.lib.upsertFont({
      family: face.family,
      weight: face.weight,
      style: face.style,
      file: ref,
      source: 'upload',
    });
    this.lib.emit([{ kind: 'font', id: font.id, entity: font }]);
    return font;
  }

  async remove(id: string): Promise<Font | undefined> {
    const f = this.lib.deleteFont(id);
    if (!f) return undefined;
    this.lib.emit([{ kind: 'font', id, deleted: true }]);
    await this.store.release(f.file.hash);
    return f;
  }

  queueGoogle(family: string) {
    const fam = family.trim();
    if (!fam || fam.length > 100 || !/^[\w .'-]+$/u.test(fam)) throw badRequest('Invalid font family name');
    return this.jobs.enqueue('font-google', { family: fam }, 'light');
  }

  private async googleJob(ctx: JobCtx<{ family: string }>): Promise<{ fonts: string[] }> {
    const fetcher = this.cfg.fetch;
    const css = await fetchFamilyCss(fetcher, ctx.payload.family, (m) => ctx.log(m));
    const faces = parseFontCss(css);
    if (!faces.length) throw new Error('No font faces in the Google Fonts response');
    ctx.log(`${faces.length} face(s) for ${faces[0]!.family}`);
    const byUrl = new Map<string, Awaited<ReturnType<Store['putBytes']>>>();
    const out: string[] = [];
    let i = 0;
    for (const f of faces) {
      if (ctx.signal.aborted) throw new Error('cancelled');
      const u = new URL(f.url);
      if (u.protocol !== 'https:' || u.hostname !== 'fonts.gstatic.com')
        throw new Error(`Refusing font URL ${u.hostname}`);
      let ref = byUrl.get(f.url);
      if (!ref) {
        const res = await fetcher(f.url, { signal: ctx.signal });
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${f.family} ${f.weights[0]}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        const s = sniff(buf);
        if (s?.kind !== 'font') throw new Error('Downloaded file is not a font');
        ref = await this.store.putBytes(buf, { ext: s.ext, mime: FONT_MIME[s.ext] ?? s.mime, dir: 'fonts' });
        byUrl.set(f.url, ref);
      }
      const font = this.lib.upsertFont({
        family: f.family,
        weight: f.weights[0]!,
        style: f.style,
        file: ref,
        source: 'google',
      });
      this.lib.emit([{ kind: 'font', id: font.id, entity: font }]);
      out.push(font.id);
      ctx.progress(++i / faces.length);
    }
    ctx.log(`stored ${out.length} face(s), ${byUrl.size} file(s)`);
    return { fonts: out };
  }
}

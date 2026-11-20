/**
 * Slide files on the hub (design/29 §1.3): the head and pages of a pre-rendered slide's full form, kept as
 * application/json files in the content store and checked in the CPU pool. `SlideFileIndex` is the DB-only side
 * (a property of `Library`: the save check, the goLive bundle and collection read it, never a file);
 * `SlideFiles` is the service (PUT a page, PUT a head, the writers inside the hub).
 *
 * The hub is the authority: a head's `uses` and bytes are its own record (`slide_heads`), written when the head
 * is checked; a presentation save rewrites the slide's `uses` and `file.bytes` from it (`Library.savePresentation`).
 */
import { readFile } from 'node:fs/promises';
import { canonicalJson } from '@ordo/domain/palette.ts';
import { slideUses } from '@ordo/domain/prerender.ts';
import { type SlideFile, SLIDE_FILE_LIMITS } from '@ordo/domain/slidefile.ts';
import type { DB } from './db.ts';
import { HttpError } from './errors.ts';
import type { Library } from './library.ts';
import { type CpuPool, transferables } from './pool.ts';
import type { SlideUses } from './slidetasks.ts';
import type { Store } from './store.ts';

const JSON_MIME = 'application/json';
/** The most refs or pages a refusal names. */
export const NAMED_MAX = 20;

export type HeadRow = { hash: string; bytes: number; objects: number; uses: SlideUses; pages: string[] };

/** The DB-only side: no pool, no store. */
export class SlideFileIndex {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** The head's record with its pages in order; undefined when the hub has no such head (a row AND its file). */
  head(hash: string): HeadRow | undefined {
    const r = this.db
      .prepare(
        `SELECT h.hash, h.bytes, h.objects, h.uses FROM slide_heads h JOIN files f ON f.hash = h.hash WHERE h.hash = ?`,
      )
      .get(hash) as { hash: string; bytes: number; objects: number; uses: string } | undefined;
    if (!r) return undefined;
    return {
      hash: r.hash,
      bytes: r.bytes,
      objects: r.objects,
      uses: JSON.parse(r.uses) as SlideUses,
      pages: this.pagesOf(hash),
    };
  }

  /** Of `refs`, those with a head row and a files row. */
  have(refs: readonly string[]): Set<string> {
    const out = new Set<string>();
    const unique = [...new Set(refs)];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT h.hash FROM slide_heads h JOIN files f ON f.hash = h.hash WHERE h.hash IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as { hash: string }[];
      for (const r of rows) out.add(r.hash);
    }
    return out;
  }

  pagesOf(head: string): string[] {
    return (
      this.db.prepare(`SELECT page FROM slide_head_pages WHERE head = ? ORDER BY pos`).all(head) as {
        page: string;
      }[]
    ).map((r) => r.page);
  }

  /** Record a checked head: its row and its pages, in one transaction. */
  record(row: HeadRow): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO slide_heads (hash, bytes, objects, uses, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.hash, row.bytes, row.objects, JSON.stringify(row.uses), new Date().toISOString());
      this.db.prepare(`DELETE FROM slide_head_pages WHERE head = ?`).run(row.hash);
      const ins = this.db.prepare(`INSERT INTO slide_head_pages (head, pos, page) VALUES (?, ?, ?)`);
      for (let i = 0; i < row.pages.length; i++) ins.run(row.hash, i, row.pages[i]);
      // uploaded again: the clocks of the head and its pages stop (collection)
      for (const h of [row.hash, ...row.pages])
        this.db.prepare(`DELETE FROM collect_marks WHERE hash = ?`).run(h);
    })();
  }

  /** Forget a head (collection removes it with its files row). */
  remove(hash: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM slide_head_pages WHERE head = ?`).run(hash);
      this.db.prepare(`DELETE FROM slide_heads WHERE hash = ?`).run(hash);
    })();
  }
}

type Pool = Pick<CpuPool, 'run'>;

export type Stored = { status: 200 | 201; hash: string; bytes: number; count?: number };

/** The service: the two PUTs and the writers inside the hub. */
export class SlideFiles {
  private lib: Library;
  private store: Store;
  private pool: () => Pool;
  constructor(lib: Library, store: Store, pool: () => Pool) {
    this.lib = lib;
    this.store = store;
    this.pool = pool;
  }

  private refuse(out: { status: number; code: string; message: string }): never {
    throw new HttpError(out.status, out.code, out.message);
  }

  /** PUT a page: checked in the pool, stored as canonical JSON; 200 when the hub already has it. */
  async putPage(name: string, body: unknown): Promise<Stored> {
    const out = await this.pool().run('slide-file', { kind: 'page', name, body });
    if (!out.ok) this.refuse(out);
    if (out.kind !== 'page') throw new Error('unexpected slide-file answer');
    const had = this.lib.getFile(name);
    if (had) return { status: 200, hash: name, bytes: out.bytes.length };
    await this.store.putBytes(out.bytes, { ext: 'json', mime: JSON_MIME });
    return { status: 201, hash: name, bytes: out.bytes.length };
  }

  /**
   * PUT a head: its pages must be the hub's (409 `pages_missing` names the first 20 it lacks), at most 16 MiB
   * of them (413), and assemble (400 `bad_head`); the hub then records bytes, objects, `uses` and the pages.
   */
  async putHead(name: string, body: unknown): Promise<Stored> {
    const pageNames = headPages(body);
    if (!pageNames)
      throw new HttpError(400, 'bad_head', 'not a slide file head (pages must be a list of names)');
    if (pageNames.length > SLIDE_FILE_LIMITS.pages)
      throw new HttpError(400, 'bad_head', `a slide file has at most ${SLIDE_FILE_LIMITS.pages} pages`);
    const rows = pageNames.map((p) => this.lib.getFile(p));
    const missing = [...new Set(pageNames.filter((_, i) => !rows[i] || rows[i]!.mime !== JSON_MIME))];
    if (missing.length)
      throw new HttpError(409, 'pages_missing', 'Upload the slide’s pages before its head', {
        missing: missing.slice(0, NAMED_MAX),
      });
    const sum = rows.reduce((n, r) => n + (r?.bytes ?? 0), 0);
    if (sum > SLIDE_FILE_LIMITS.bytes)
      throw new HttpError(413, 'slide_too_large', 'A slide’s file is at most 16 MiB of pages');
    const bufs = await Promise.all(rows.map((r) => readFile(this.store.abs(r!.path))));
    const pages = bufs.map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    const out = await this.pool().run(
      'slide-file',
      { kind: 'head', name, body, pages },
      { transfer: transferables(pages) },
    );
    if (!out.ok) this.refuse(out);
    if (out.kind !== 'head') throw new Error('unexpected slide-file answer');
    const had = this.lib.getFile(name);
    const known = !!had && !!this.lib.slideFiles.head(name);
    if (!had) await this.store.putBytes(out.bytes, { ext: 'json', mime: JSON_MIME });
    if (!known)
      this.lib.slideFiles.record({
        hash: name,
        bytes: out.total,
        objects: out.objects,
        uses: out.uses,
        pages: pageNames,
      });
    return { status: known ? 200 : 201, hash: name, bytes: out.total, count: out.objects };
  }

  /**
   * A writer inside the hub (an import, hub-writers; C-PS1): the pages first, then the head, no HTTP, the pool
   * is not asked (the file was just made by the domain's own `slideFileOf`). Returns what the slide records.
   */
  async storeFile(file: SlideFile): Promise<{ ref: string; bytes: number }> {
    for (const p of file.pages)
      if (!this.lib.getFile(p.name))
        await this.store.putBytes(Buffer.from(canonicalJson(p.page), 'utf8'), {
          ext: 'json',
          mime: JSON_MIME,
        });
    if (!this.lib.getFile(file.name))
      await this.store.putBytes(Buffer.from(canonicalJson(file.head), 'utf8'), {
        ext: 'json',
        mime: JSON_MIME,
      });
    const objects = file.pages.flatMap((p) => p.page.objects);
    const uses = slideUses({
      id: 'file',
      objects,
      ...(file.head.imported ? { imported: file.head.imported } : {}),
    } as never);
    this.lib.slideFiles.record({
      hash: file.name,
      bytes: file.bytes,
      objects: file.head.count,
      uses,
      pages: file.head.pages,
    });
    return { ref: file.name, bytes: file.bytes };
  }
}

/** The page names of a head body, or undefined when it is not a list of 64-hex names. */
function headPages(body: unknown): string[] | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const pages = (body as { pages?: unknown }).pages;
  if (!Array.isArray(pages) || !pages.every((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p)))
    return undefined;
  return pages as string[];
}

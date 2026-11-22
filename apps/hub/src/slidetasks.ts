/**
 * The two CPU-pool tasks of slide files (design/29 §1.3; run in `cpu.worker.ts`, never on an event loop):
 *
 * - `slide-file`: the check of a page or a head that a writer PUT. A page is parsed against the domain's schema,
 *   named by the SHA-256 of its canonical JSON and returned as the bytes the hub stores; a head is assembled
 *   from the pages the library read from its store (`slideFromFile` re-hashes each and checks their order and
 *   the count), its `uses` read from the objects, its bytes summed. A refusal is a message with the status the
 *   route answers, never a stack.
 * - `prerender-keys`: the key and stand-by id of each pre-rendered slide of a presentation, computed with the
 *   domain's own functions and nothing else (`slideFromFile`, `pictureSource`, `prerenderKey`, `standbyId`), so a
 *   key can never depend on drawing code (design/29 §1.2).
 */
import { canonicalJson } from '@ordo/domain/palette.ts';
import { type PictureInputs, pictureSource, prerenderKey, standbyId } from '@ordo/domain/prerender.ts';
import type { Slide } from '@ordo/domain/schemas.ts';
import { sha256Text } from '@ordo/domain/sha256.ts';
import {
  SLIDE_FILE_LIMITS,
  SlideFileHead,
  SlideFilePage,
  SlideFileRefusal,
  slideFileName,
  slideFromFile,
  slideUsesAll,
  usesTooMany,
} from '@ordo/domain/slidefile.ts';

/** What a slide file draws (the head row's `uses`, whole: `slideUsesAll`): media ids, shape files, font families. */
export type SlideUses = ReturnType<typeof slideUsesAll>;

export type SlideFileTaskInput =
  | { kind: 'page'; name: string; body: unknown }
  | { kind: 'head'; name: string; body: unknown; pages: Uint8Array[] };

export type SlideFileTaskOutput =
  | { ok: true; kind: 'page'; name: string; bytes: Uint8Array; objects: number }
  | {
      ok: true;
      kind: 'head';
      name: string;
      /** The head's canonical JSON, as stored. */
      bytes: Uint8Array;
      /** Bytes of the head and the pages together (`Slide.prerender.file.bytes`). */
      total: number;
      objects: number;
      uses: SlideUses;
    }
  | { ok: false; status: number; code: string; message: string };

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const refuse = (status: number, code: string, message: string) => ({
  ok: false as const,
  status,
  code,
  message,
});
const issue = (e: { issues: { path: PropertyKey[]; message: string }[] }): string => {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || 'value'}: ${i.message}`.slice(0, 200) : 'invalid';
};

export function slideFileTask(input: SlideFileTaskInput): SlideFileTaskOutput {
  if (input.kind === 'page') {
    const parsed = SlideFilePage.safeParse(input.body);
    if (!parsed.success) return refuse(400, 'bad_page', `not a slide page (${issue(parsed.error)})`);
    const canonical = canonicalJson(parsed.data);
    const name = sha256Text(canonical);
    if (name !== input.name)
      return refuse(400, 'bad_name', 'the name is not the SHA-256 of the page as the hub stores it');
    return {
      ok: true,
      kind: 'page',
      name,
      bytes: enc.encode(canonical),
      objects: parsed.data.objects.length,
    };
  }
  const head = SlideFileHead.safeParse(input.body);
  if (!head.success) return refuse(400, 'bad_head', `not a slide file head (${issue(head.error)})`);
  const canonical = canonicalJson(head.data);
  const name = sha256Text(canonical);
  if (name !== input.name)
    return refuse(400, 'bad_name', 'the name is not the SHA-256 of the head as the hub stores it');
  if (input.pages.length !== head.data.pages.length)
    return refuse(400, 'bad_head', 'the pages given are not the head’s');
  const pages: SlideFilePage[] = [];
  let total = 0;
  for (let i = 0; i < input.pages.length; i++) {
    const bytes = input.pages[i]!;
    total += bytes.length;
    let json: unknown;
    try {
      json = JSON.parse(dec.decode(bytes));
    } catch {
      return refuse(400, 'bad_head', `page ${i + 1} is not JSON`);
    }
    const p = SlideFilePage.safeParse(json);
    if (!p.success) return refuse(400, 'bad_head', `page ${i + 1} is not a slide page (${issue(p.error)})`);
    pages.push(p.data);
  }
  if (total > SLIDE_FILE_LIMITS.bytes)
    return refuse(413, 'slide_too_large', 'a slide’s file is at most 16 MiB of pages');
  let full: Slide;
  try {
    full = slideFromFile({ id: 'file', objects: [] }, head.data, pages);
  } catch (e) {
    if (e instanceof SlideFileRefusal) return refuse(400, 'bad_head', e.message);
    throw e;
  }
  const headBytes = enc.encode(canonical);
  // The head row keeps the whole lists (the collector, the keys job and goLive read them); past what a slide file may name
  // the head is refused, never cut.
  const uses = slideUsesAll(full);
  const many = usesTooMany(uses);
  if (many) return refuse(413, 'slide_uses_too_many', many);
  return {
    ok: true,
    kind: 'head',
    name,
    bytes: headBytes,
    total: total + headBytes.length,
    objects: head.data.count,
    uses,
  };
}

// ── keys ──────────────────────────────────────────────────────────────────────────────────────────────────

export type PrerenderKeysTaskInput = {
  slides: {
    slideId: string;
    /** The stand-in as stored. */
    standIn: Slide;
    /** The slide file's head and its pages' bytes in order (JSON as stored); absent for a slide stored inline. */
    head?: Uint8Array;
    pages?: Uint8Array[];
    /** The file each drawn picture decodes, by media id; null when the library lacks it. */
    media: Record<string, string | null>;
  }[];
  /** The library's faces, bundled ones included. */
  fonts: { family: string; hash: string }[];
};

export type PrerenderKeysTaskOutput = {
  keys: ({ slideId: string; key: string; standbyId: string } | { slideId: string; error: string })[];
};

export function prerenderKeysTask(input: PrerenderKeysTaskInput): PrerenderKeysTaskOutput {
  const fonts = input.fonts.map((f) => ({ family: f.family, file: { hash: f.hash } }));
  const out: PrerenderKeysTaskOutput['keys'] = [];
  for (const s of input.slides) {
    try {
      let full: Slide = s.standIn;
      if (s.head !== undefined) {
        const head = SlideFileHead.parse(JSON.parse(dec.decode(s.head)));
        const pages = (s.pages ?? []).map((b) => SlideFilePage.parse(JSON.parse(dec.decode(b))));
        full = slideFromFile(s.standIn, head, pages);
      }
      const inputs: PictureInputs = { mediaFile: (id) => s.media[id] ?? undefined, fonts };
      const src = pictureSource(full, s.standIn.prerender?.live ?? [], inputs);
      out.push({ slideId: s.slideId, key: prerenderKey(src), standbyId: standbyId(src) });
    } catch (e) {
      out.push({ slideId: s.slideId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { keys: out };
}

export { slideFileName };

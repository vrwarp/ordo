import { type Media, type Presentation, readableText } from '@ordo/domain';

import { importedText } from '@ordo/domain';

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .trim();
}

export type SearchDoc = {
  id: string;
  kind: 'presentation' | 'media';
  title: string;
  /** Normalized title. */
  t: string;
  /** Normalized full haystack: title, lyrics, CCLI, tags, author. */
  h: string;
  archived: boolean;
  folderId?: string;
  tags: string[];
  presentationKind?: Presentation['kind'];
  mediaKind?: Media['kind'];
};

const presDocs = new WeakMap<Presentation, SearchDoc>();
const mediaDocs = new WeakMap<Media, SearchDoc>();

export function presentationDoc(p: Presentation): SearchDoc {
  const hit = presDocs.get(p);
  if (hit) return hit;
  const parts: string[] = [p.title, p.meta.ccli ?? '', p.meta.author ?? '', ...(p.meta.tags ?? [])];
  for (const sec of p.sections) {
    // As people read it: verse numbers and list numbers are searchable.
    for (const sl of sec.slides)
      for (const o of sl.objects) if (o.type === 'text') parts.push(readableText(o));
  }
  // Picture slides: the text of the picture, once it is known to be that slide's (design/27 §11).
  for (const sec of p.sections) for (const sl of sec.slides) parts.push(importedText(sl));
  const doc: SearchDoc = {
    id: p.id,
    kind: 'presentation',
    title: p.title,
    t: normalize(p.title),
    h: normalize(parts.join(' ')),
    archived: p.archived,
    folderId: p.folderId,
    tags: p.meta.tags ?? [],
    presentationKind: p.kind,
  };
  presDocs.set(p, doc);
  return doc;
}

export function mediaDoc(m: Media): SearchDoc {
  const hit = mediaDocs.get(m);
  if (hit) return hit;
  const doc: SearchDoc = {
    id: m.id,
    kind: 'media',
    title: m.name,
    t: normalize(m.name),
    h: normalize([m.name, ...m.tags, m.kind].join(' ')),
    archived: false,
    tags: m.tags,
    mediaKind: m.kind,
  };
  mediaDocs.set(m, doc);
  return doc;
}

/**
 * Docs are memoized per entity object, so rebuilding after a library delta only re-normalizes the
 * changed entities. Search is an AND of terms over the haystack, ranked: title prefix, title contains,
 * then body; ties alphabetical.
 */
export class SearchIndex {
  private docs: SearchDoc[] = [];
  private presSrc?: Presentation[];
  private mediaSrc?: Media[];

  update(presentations: Presentation[], media: Media[]): void {
    if (presentations === this.presSrc && media === this.mediaSrc) return;
    this.presSrc = presentations;
    this.mediaSrc = media;
    const out: SearchDoc[] = [];
    for (const p of presentations) out.push(presentationDoc(p));
    for (const m of media) out.push(mediaDoc(m));
    this.docs = out;
  }

  get size(): number {
    return this.docs.length;
  }

  search(
    query: string,
    f: {
      kind?: 'presentation' | 'media';
      includeArchived?: boolean;
      folderId?: string | null;
      tag?: string;
      limit?: number;
    } = {},
  ): SearchDoc[] {
    const terms = normalize(query).split(' ').filter(Boolean);
    const scored: { d: SearchDoc; s: number }[] = [];
    for (const d of this.docs) {
      if (f.kind && d.kind !== f.kind) continue;
      if (!f.includeArchived && d.archived) continue;
      if (f.folderId !== undefined && f.folderId !== null && d.folderId !== f.folderId) continue;
      if (f.tag && !d.tags.includes(f.tag)) continue;
      let ok = true;
      for (const t of terms) {
        if (!d.h.includes(t)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      let s = 3;
      if (terms.length) {
        const q = terms.join(' ');
        if (d.t.startsWith(q)) s = 0;
        else if (d.t.includes(q)) s = 1;
        else if (terms.every((t) => d.t.includes(t))) s = 2;
      }
      scored.push({ d, s });
    }
    scored.sort((a, b) => a.s - b.s || a.d.title.localeCompare(b.d.title));
    const lim = f.limit ?? scored.length;
    return scored.slice(0, lim).map((x) => x.d);
  }
}

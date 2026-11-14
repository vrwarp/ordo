import { fileUrl } from '@ordo/client';
import type { Font } from '@ordo/domain';
// The font module itself, not the @ordo/renderer barrel (which brings the preset geometry and the text
// engine into the entry); the barrel re-exports this module, so currentFontEnv sees the same env.
import { FontResolver, installFontEnv } from '@ordo/renderer/text/fonts.ts';
import { useEffect, useState } from 'react';
import { currentLayout, type Layout, onLayoutChange } from '../lib/layout.ts';
import { thumbs } from './thumbs.ts';

/**
 * The page's font resolver (design/27 §10): the editor canvas and look previews draw text through it, with
 * the same internal family names and fallback order as the outputs and the thumbnail worker, and a face
 * that loads late (a retried failure, a new upload) is used by the next draw.
 */
const resolver =
  typeof document !== 'undefined' && 'fonts' in document
    ? new FontResolver({ set: document.fonts, data: async (f) => fileUrl(f.hash) })
    : undefined;
if (resolver) installFontEnv(resolver);

/** What syncFonts drives (the page's globals; tests feed fakes). */
export type FontSyncDeps = {
  /** The thumbnail worker's list (it draws every preview, on every layout). */
  setThumbFonts(fonts: Font[]): void;
  /** The page's resolver (canvas drawing). */
  resolverSync?(fonts: { family: string; weight: number; style: Font['style']; hash: string }[]): void;
  /** Add a face to the document under the family's own name and load it (CSS: the font picker, the fonts tab). */
  addDocumentFace?(family: string, url: string, weight: string, style: string): void;
  layout(): Layout;
  fileUrl(hash: string): string;
};

/**
 * Library fonts into the thumbnail worker always, and into the page (the resolver and the document's faces) on
 * the regular layout only: nothing on the compact path draws text on the page's canvas (previews draw in the
 * thumbnail worker), so a phone downloads no font file at sign-in (design/28 §7). A change to the regular
 * layout (an iPad leaving a narrow Split View) adds them with the list last given. The regular layout behaves
 * as before.
 */
export function createFontSync(deps: FontSyncDeps): {
  sync(fonts: Font[]): void;
  layoutChanged(l: Layout): void;
} {
  const added = new Set<string>();
  let last: Font[] | undefined;
  const onPage = (fonts: Font[]) => {
    deps.resolverSync?.(
      fonts.map((f) => ({ family: f.family, weight: f.weight, style: f.style, hash: f.file.hash })),
    );
    if (!deps.addDocumentFace) return;
    for (const f of fonts) {
      const key = `${f.family}|${f.weight}|${f.style}|${f.file.hash}`;
      if (added.has(key)) continue;
      added.add(key);
      try {
        deps.addDocumentFace(f.family, deps.fileUrl(f.file.hash), String(f.weight), f.style);
      } catch {
        /* ignore broken font */
      }
    }
  };
  return {
    sync(fonts) {
      deps.setThumbFonts(fonts);
      last = fonts;
      if (deps.layout() === 'regular') onPage(fonts);
    },
    layoutChanged(l) {
      if (l === 'regular' && last) onPage(last);
    },
  };
}

const hasDocumentFonts = typeof document !== 'undefined' && 'fonts' in document;
const fontSync = createFontSync({
  setThumbFonts: (fonts) => thumbs.setFonts(fonts),
  resolverSync: resolver ? (list) => void resolver.sync(list) : undefined,
  addDocumentFace: hasDocumentFonts
    ? (family, url, weight, style) => {
        const face = new FontFace(family, `url(${url})`, { weight, style });
        document.fonts.add(face);
        void face.load().catch(() => undefined);
      }
    : undefined,
  layout: currentLayout,
  fileUrl,
});
onLayoutChange((l) => fontSync.layoutChanged(l));

/**
 * Load every library font: into the thumbnail worker, and on the regular layout into the page's font resolver
 * (canvas drawing) and into the document under its own family name (CSS: the font picker and the fonts tab
 * show each family in itself).
 */
export function syncFonts(fonts: Font[]): void {
  fontSync.sync(fonts);
}

/** Run `fn` whenever the faces canvas text resolves to change. Returns the unsubscribe. */
export function onFontsChanged(fn: () => void): () => void {
  return resolver ? resolver.onChange(() => fn()) : () => undefined;
}

/** The font generation of canvas text: a dependency for effects that draw text onto a canvas. */
export function useFontGeneration(): number {
  const [gen, setGen] = useState(() => resolver?.generation ?? 0);
  useEffect(() => onFontsChanged(() => setGen(resolver?.generation ?? 0)), []);
  return gen;
}

/** Families available in the font picker: library fonts plus safe system fallbacks. */
export function fontFamilies(fonts: Font[]): string[] {
  const set = new Set<string>(fonts.map((f) => f.family));
  for (const f of ['Inter', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Verdana', 'Segoe UI'])
    set.add(f);
  return [...set].sort((a, b) => a.localeCompare(b));
}

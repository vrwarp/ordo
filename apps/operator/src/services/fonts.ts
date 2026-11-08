import { fileUrl } from '@ordo/client';
import type { Font } from '@ordo/domain';
import { FontResolver, installFontEnv } from '@ordo/renderer';
import { useEffect, useState } from 'react';
import { thumbs } from './thumbs.ts';

const added = new Set<string>();

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

/**
 * Load every library font: into the page's font resolver (canvas drawing), into the document under its own
 * family name (CSS: the font picker and the fonts tab show each family in itself) and into the thumbnail
 * worker.
 */
export function syncFonts(fonts: Font[]): void {
  thumbs.setFonts(fonts);
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  void resolver?.sync(
    fonts.map((f) => ({ family: f.family, weight: f.weight, style: f.style, hash: f.file.hash })),
  );
  for (const f of fonts) {
    const key = `${f.family}|${f.weight}|${f.style}|${f.file.hash}`;
    if (added.has(key)) continue;
    added.add(key);
    try {
      const face = new FontFace(f.family, `url(${fileUrl(f.file.hash)})`, {
        weight: String(f.weight),
        style: f.style,
      });
      document.fonts.add(face);
      void face.load().catch(() => undefined);
    } catch {
      /* ignore broken font */
    }
  }
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

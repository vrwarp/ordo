import { fileUrl } from '@ordo/client';
import type { Font } from '@ordo/domain';
import { thumbs } from './thumbs.ts';

const added = new Set<string>();

/** Load every library font into the document (editor canvas) and the thumbnail worker. */
export function syncFonts(fonts: Font[]): void {
  thumbs.setFonts(fonts);
  if (typeof document === 'undefined' || !('fonts' in document)) return;
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

/** Families available in the font picker: library fonts plus safe system fallbacks. */
export function fontFamilies(fonts: Font[]): string[] {
  const set = new Set<string>(fonts.map((f) => f.family));
  for (const f of ['Inter', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Verdana', 'Segoe UI'])
    set.add(f);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Embedded OLE objects (design/27 §15 M9, `metafiles-ole.md` §4.5; `metafile-a` fills this): an OLE graphic
 * frame drawn as its preview picture (`p:oleObj/p:pic`, else the legacy VML preview by `spid`), a locked
 * `ImageObject` with `origin.role` 'ole'.
 *
 * Stub since `conv-seams`: `readOle` reads none, so an OLE frame stays a residual element (LibreOffice's
 * art, or `missing: ['ole']` without LibreOffice).
 *
 * Pure.
 */
import type { SlideCtx, Source } from './context.ts';
import type { ElementBase, PictureElement } from './ir.ts';
import type { XNode } from './xml.ts';

/** The preview picture of an OLE graphic frame, or undefined when it has none ordo reads. Stub: none. */
export function readOle(
  _ctx: SlideCtx,
  _frame: XNode,
  _from: Source,
  _base: ElementBase,
): PictureElement | undefined {
  return undefined;
}

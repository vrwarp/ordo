/// <reference lib="webworker" />
/**
 * The import worker (design/27 §2 "Where the deck is parsed", design/15 "Import"): a PowerPoint the operator
 * imports as editable slides is parsed here, never on the page's thread, with the library's faces for the
 * families a deck with a table names (fetched from the hub, read as the hub reads them). One parse per worker:
 * the page terminates it when the parse ends or its deadline passes (`services/pptxParse.ts`). The scene goes
 * back as JSON bytes (transferred), so the page never serializes it.
 */
import { loadDeckFaces, type FaceFile } from '@ordo/importers/pptx-faces.ts';
import { parsePptxScene } from '@ordo/importers/pptx-client.ts';

export type ImportIn = {
  t: 'parse';
  file: Blob;
  extendBackgrounds: boolean;
  libreoffice: boolean;
  /** The library's faces (`Font` rows) with the URLs their files are fetched from. */
  faces: FaceFile[];
};
export type ImportOut =
  | { t: 'progress'; pct: number }
  | { t: 'done'; scene: ArrayBuffer; ms: number; slides: number }
  | { t: 'error'; message: string };

const post = (m: ImportOut, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** A face file fetched from the hub, or undefined when it cannot be (the face is then missing). */
async function fetchFace(url: string): Promise<Uint8Array | undefined> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) return undefined;
  return new Uint8Array(await r.arrayBuffer());
}

self.onmessage = async (ev: MessageEvent<ImportIn>) => {
  const m = ev.data;
  if (!m || m.t !== 'parse') return;
  try {
    const parse = await parsePptxScene(
      m.file,
      {
        extendBackgrounds: m.extendBackgrounds,
        libreoffice: m.libreoffice,
        loadFaces: (parts) => loadDeckFaces(parts, m.faces, fetchFace),
      },
      (pct) => post({ t: 'progress', pct }),
    );
    const bytes = new TextEncoder().encode(JSON.stringify(parse.scene));
    const buf = bytes.buffer as ArrayBuffer;
    post({ t: 'done', scene: buf, ms: Math.round(parse.ms), slides: parse.scene.listed.length }, [buf]);
  } catch (e) {
    post({ t: 'error', message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  }
};

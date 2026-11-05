/**
 * Worker thread of the CPU pool (pool.ts): ProPresenter decode (with its RTF), PPTX XML text extraction, the
 * pptx-preview annotation of a deck and font table parsing. Built as its own bundle entry
 * (dist/cpu.worker.js); run from source under tsx in dev.
 * Messages: { id, kind, input } in, { id, ok, result | error } out. Messages tagged `__ordo` are ignored.
 */
import { parentPort } from 'node:worker_threads';
import { extractPptxText, importPro7, type Pro7ImportOptions } from '@ordo/importers';
import { annotatePptx } from '@ordo/pptx-render/annotate.ts';
import { readFontFace } from './fonts/sfnt.ts';

type Req = { id: number; kind: string; input: Record<string, unknown>; __ordo?: unknown };

async function handle(m: Req): Promise<unknown> {
  switch (m.kind) {
    case 'pro7':
      return importPro7(
        m.input.files as Map<string, Uint8Array>,
        (m.input.opts as Pro7ImportOptions | undefined) ?? {},
      );
    case 'pptx':
      return extractPptxText(m.input.buf as Uint8Array);
    case 'pptx-annotate':
      return annotatePptx(m.input.buf as Uint8Array);
    case 'font':
      return readFontFace(m.input.buf as Uint8Array);
    default:
      throw new Error(`unknown task ${m.kind}`);
  }
}

parentPort?.on('message', (m: Req) => {
  if (!m || typeof m !== 'object' || '__ordo' in m) return;
  handle(m).then(
    (result) => parentPort?.postMessage({ id: m.id, ok: true, result }),
    (e: unknown) =>
      parentPort?.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
});

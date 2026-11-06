/**
 * Helpers for the native PowerPoint import tests (design/27 M3): crafted decks zipped and stored like an
 * upload, and jobs awaited.
 */
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Slide } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import type { PartSource } from '@ordo/pptx-scene/opc.ts';
import JSZip from 'jszip';
import { PPTX_MIME } from '../src/imports.ts';
import type { TestHub } from './helpers.ts';

/** Zip a deck's parts into `<dir>/<name>`. */
export async function zipDeck(parts: PartSource, dir: string, name = 'deck.pptx'): Promise<string> {
  const z = new JSZip();
  for (const [k, v] of parts) z.file(k, v);
  const file = join(dir, name);
  await writeFile(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return file;
}

/** Store a deck file as the upload route does; its SHA-256. */
export async function storeDeck(hub: TestHub, file: string): Promise<string> {
  const tmp = hub.store.tmpPath('pptx');
  await copyFile(file, tmp);
  return (await hub.store.put(tmp, { ext: 'pptx', mime: PPTX_MIME })).hash;
}

/** Wait until a job is done or failed. */
export async function waitJob(hub: TestHub, id: string, timeoutMs = 60_000): Promise<Job> {
  const t0 = Date.now();
  for (;;) {
    const j = hub.jobs.get(id);
    if (j.state === 'done' || j.state === 'failed') return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} still ${j.state}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every slide of a presentation in section order. */
export const slidesOf = (p: { sections: { slides: Slide[] }[] }): Slide[] =>
  p.sections.flatMap((s) => s.slides);

import { deflateSync } from 'node:zlib';
import { type APIRequestContext, expect } from '@playwright/test';
import { DEFAULT_LYRIC_STYLE, type SlideObject } from '../packages/domain/src/index.ts';
import { type SlideFile, slideFileOf } from '../packages/domain/src/slidefile.ts';
import { json } from './helpers.ts';

/**
 * What the bake spec seeds (`bake.spec.ts`, design/29 section 1.4): slides the pre-render plan keeps whole, with the
 * record the hub keys them by, so a hub with `ORDO_PRERENDER=on` lists their keys at once and an open operator page
 * makes the pictures. No product hook is used here: everything goes through the hub's own routes.
 */

/** The slide's record: pre-rendered because of its object count, with no live set (Q24.a is not built). */
export const RECORD = { why: ['count'], live: [] } as const;

const rect = (id: string, i: number): SlideObject =>
  ({
    id,
    type: 'shape',
    box: { x: (i % 40) * 46, y: Math.floor(i / 40) * 46, w: 40, h: 40, rotation: 0 },
    shape: 'rect',
    fill: { r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 53) % 256, a: 1 },
    opacity: 1,
    radius: 0,
  }) as SlideObject;

/**
 * A heavy slide: `shapes` squares, one image object a media in `mediaIds` (cycled to `images`), and two text boxes.
 * The title text carries `label`, so two slides never share a key.
 */
export function heavySlide(
  id: string,
  opts: { label: string; mediaIds: string[]; shapes?: number; images?: number },
): { id: string; objects: SlideObject[]; prerender: typeof RECORD } {
  const shapes = opts.shapes ?? 250;
  const images = opts.images ?? 60;
  const objects: SlideObject[] = Array.from({ length: shapes }, (_, i) => rect(`${id}-r${i}`, i));
  for (let i = 0; i < images; i++)
    objects.push({
      id: `${id}-img${i}`,
      type: 'image',
      box: { x: 40 + (i % 12) * 150, y: 500 + Math.floor(i / 12) * 90, w: 120, h: 70, rotation: 0 },
      mediaId: opts.mediaIds[i % opts.mediaIds.length]!,
      fit: 'cover',
      opacity: 1,
      radius: 0,
    } as SlideObject);
  for (const [k, text] of [opts.label, `${opts.label} two`].entries())
    objects.push({
      id: `${id}-t${k}`,
      type: 'text',
      box: { x: 100, y: 60 + k * 200, w: 1700, h: 160, rotation: 0 },
      text,
      style: { ...DEFAULT_LYRIC_STYLE },
      opacity: 1,
    } as SlideObject);
  return { id, objects, prerender: RECORD };
}

/** A presentation body for `POST /presentations`. */
export const presentationBody = (title: string, slides: { id: string }[]) => ({
  title,
  kind: 'slides',
  sections: [{ id: 'sec', label: title, short: 'S', slides }],
});

// ---- one-colour PNGs ---------------------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A `size` x `size` PNG of one colour (colour type 2, 8 bits): distinct colours are distinct files. */
export function colourPng(r: number, g: number, b: number, size = 48): Buffer {
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Uploads `n` distinct one-colour PNGs as media (ten at a time) and returns their ids once all are ready. */
export async function uploadColourPngs(api: APIRequestContext, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; from < n; from += 10) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(10, n - from) }, async (_, j) => {
        const i = from + j;
        const m = await json<{ id: string } | { id: string }[]>(
          api.post('media', {
            multipart: {
              file: {
                name: `colour-${i}.png`,
                mimeType: 'image/png',
                buffer: colourPng((i * 7) % 256, (i * 29 + 40) % 256, (i * 61 + 90) % 256),
              },
              isBackground: 'false',
            },
          }),
        );
        return Array.isArray(m) ? m[0]!.id : m.id;
      }),
    );
    ids.push(...batch);
  }
  for (const id of ids)
    await expect
      .poll(async () => (await json<{ state: string }>(api.get(`media/${id}`))).state, { timeout: 60_000 })
      .toBe('ready');
  return ids;
}

// ---- a slide kept in a slide file (Q54) --------------------------------------------------------------------

/**
 * A whole slide of `count` small squares kept in its slide file: the pages and the head are uploaded through the hub's
 * own route (`PUT /files/slide/:hash`, pages first), and the returned slide is the presentation's: a small stand-in
 * and the record that names the head. Written here with the same calls the import makes (a twin of the import-files
 * track's helper, which this track does not wait for).
 */
export async function fileFormSlide(
  api: APIRequestContext,
  id: string,
  count = 1357,
): Promise<{ slide: { id: string } & Record<string, unknown>; file: SlideFile }> {
  const full = { id, objects: Array.from({ length: count }, (_, i) => rect(`${id}-r${i}`, i)) };
  const file = slideFileOf(full as never);
  for (const p of file.pages) {
    const r = await api.put(`files/slide/${p.name}`, { data: p.page });
    expect(r.status(), await r.text()).toBeLessThan(300);
  }
  const r = await api.put(`files/slide/${file.name}`, { data: file.head });
  expect(r.status(), await r.text()).toBeLessThan(300);
  const slide = {
    id,
    objects: full.objects.slice(0, 50),
    prerender: { why: ['count'], live: [], file: { ref: file.name, bytes: file.bytes } },
  };
  return { slide, file };
}

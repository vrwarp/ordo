/**
 * The library side of the size budgets (design/27 §3.4, §14.10): a year of weekly sermon decks keeps the
 * library snapshot under 6 MB, and hub health reports the snapshot's size.
 */
import { createHash } from 'node:crypto';
import { jsonBytes, type Media, newId, type Presentation, SIZE_BUDGETS, type Slide } from '@ordo/domain';
import { convertDeck } from '@ordo/pptx-scene';
import {
  body,
  buildDeck,
  imageRel,
  para,
  pic,
  pictureBg,
  pngHeader,
  run,
  solid,
  sp,
} from '@ordo/pptx-scene/test-util.ts';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { Library } from '../src/library.ts';
import { LibraryStatsCache } from '../src/libstats.ts';
import { startHub, type TestHub } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

const EMU = 12_700; // per point
const VERSES = [
  'In the beginning was the Word, and the Word was with God, and the Word was God.',
  'The same was in the beginning with God.',
  'All things were made by him; and without him was not any thing made that was made.',
  'In him was life; and the life was the light of men.',
  'And the light shineth in darkness; and the darkness comprehended it not.',
];
const white = solid('FFFFFF');

const title = (id: number, text: string) =>
  sp({
    id,
    x: 60 * EMU,
    y: 40 * EMU,
    cx: 840 * EMU,
    cy: 90 * EMU,
    txBox: true,
    geom: 'none',
    txBody: body(para(run(text, 'sz="4400" b="1"', white))),
  });
const textBox = (id: number, y: number, paras: string) =>
  sp({
    id,
    x: 60 * EMU,
    y: y * EMU,
    cx: 840 * EMU,
    cy: 300 * EMU,
    txBox: true,
    geom: 'none',
    txBody: body(paras),
  });

/** A synthetic sermon deck of 17 slides: a photo background, scripture with verse numbers, points, pictures and notes. */
function sermonDeck(week: number) {
  const slides = [];
  slides.push({
    shapes:
      title(2, `Week ${week}: Light in the darkness`) +
      textBox(3, 200, para(run('Pastor Sam · Sunday service', 'sz="2800"', white))),
  });
  for (let k = 0; k < 16; k++) {
    const kind = k % 4;
    if (kind === 0 || kind === 1) {
      // Scripture: superscript verse numbers, a reference.
      const verses = [0, 1, 2].map((v) => {
        const n = ((week + k + v) % VERSES.length) + 1;
        return (
          run(String(n), 'sz="2400" baseline="30000"', white) + run(` ${VERSES[n - 1]} `, 'sz="3200"', white)
        );
      });
      slides.push({
        shapes:
          title(2, `John 1:${(week % 20) + 1}`) +
          textBox(3, 150, para(verses.join(''))) +
          textBox(4, 470, para(run('King James Version', 'sz="1800" i="1"', white), 'algn="r"')),
      });
    } else if (kind === 2) {
      // Points.
      const points = [1, 2, 3].map((n) =>
        para(
          run(`Point ${n}: the light of week ${week} shines for everyone`, 'sz="3200"', white),
          'marL="342900" indent="-342900"',
        ),
      );
      slides.push({ shapes: title(2, `What it means for us (${k})`) + textBox(3, 160, points.join('')) });
    } else {
      // A picture with a caption.
      slides.push({
        shapes:
          title(2, 'This week') +
          pic({
            id: 3,
            x: 300 * EMU,
            y: 140 * EMU,
            cx: 360 * EMU,
            cy: 270 * EMU,
            rId: 'rId2',
            srcRect: 'l="5000" r="5000"',
          }) +
          textBox(4, 430, para(run('Youth group, Friday 7 pm in the hall', 'sz="2400"', white))),
        rels: [imageRel('rId2', `photo${k}.png`)],
      });
    }
  }
  const media: Record<string, Uint8Array> = { 'ppt/media/background.png': pngHeader(1920, 1080) };
  for (let k = 0; k < 16; k++) media[`ppt/media/photo${k}.png`] = pngHeader(1600, 1200);
  return buildDeck({
    slides,
    layouts: [{ bg: pictureBg('rId2'), rels: [imageRel('rId2', 'background.png')] }],
    media,
  });
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * What a native import stores for the deck (design/27 §2 step 6): the converter's objects with real media
 * ids, `Slide.pptx` provenance, speaker notes, the import log, and one ready picture per part.
 */
function importSermon(lib: Library, week: number): Presentation {
  const deckHash = hash(`deck ${week}`);
  const out = convertDeck(sermonDeck(week), { newId });
  const ids = new Map<string, string>();
  for (const m of out.media) {
    const media: Media = {
      id: newId(),
      rev: 1,
      name: m.part.slice(m.part.lastIndexOf('/') + 1),
      tags: ['pptx'],
      kind: 'image',
      original: {
        hash: hash(`${week}${m.part}`),
        bytes: 900_000,
        mime: 'image/jpeg',
        path: `media/ab/${hash(`${week}${m.part}`)}.jpg`,
      },
      state: 'ready',
      width: 1920,
      height: 1080,
      loop: false,
      isBackground: false,
    };
    ids.set(m.id, lib.media.insert(media).id);
  }
  const slides: Slide[] = out.slides.map((e, i) => ({
    ...e.slide,
    ...(e.slide.backgroundMediaId ? { backgroundMediaId: ids.get(e.slide.backgroundMediaId)! } : {}),
    objects: e.slide.objects.map((o) => (o.type === 'image' ? { ...o, mediaId: ids.get(o.mediaId)! } : o)),
    ...(i % 3
      ? {
          notes: `Remind everyone about the youth group. Read verse ${i} slowly and pause before the application.`,
        }
      : {}),
    pptx: {
      fileId: deckHash,
      index: e.index,
      ...(e.shown !== undefined ? { shown: e.shown } : {}),
      class: e.classification.class,
      version: 1,
      digest: e.digest,
      ...(e.notes.length ? { notes: e.notes.slice(0, 16).map((n) => n.slice(0, 200)) } : {}),
    },
  }));
  const sectionId = newId();
  return lib.presentations.insert({
    id: newId(),
    rev: 1,
    title: `Sermon, week ${week}`,
    kind: 'slides',
    meta: { tags: ['sermon'] },
    sections: [{ id: sectionId, label: 'Slides', short: 'S', slides }],
    arrangements: [{ id: newId(), name: 'Default', sectionIds: [sectionId] }],
    source: {
      kind: 'pptx',
      fileId: deckHash,
      log: `sermon-week-${week}.pptx: 17 slides (17 native); fonts: Calibri (Carlito)`,
      native: { version: 1, slides: 17, native: 17, hybrid: 0, picture: 0, slideRect: out.slideRect },
    },
    archived: false,
  });
}

describe('library snapshot size (design/27 §3.4)', () => {
  it('a year of weekly 17-slide sermon decks keeps the snapshot under 6 MB, and health reports it', async () => {
    hub = await startHub();
    const lib = hub.lib;
    const empty = jsonBytes(lib.snapshot({ withTokens: true }));
    for (let week = 1; week <= 52; week++) importSermon(lib, week);
    const snap = lib.snapshot({ withTokens: true });
    expect(snap.presentations).toHaveLength(52);
    expect(snap.presentations.every((p) => p.sections[0]!.slides.length === 17)).toBe(true);
    expect(snap.media.length).toBeGreaterThanOrEqual(52 * 5);
    const exact = jsonBytes(snap);
    expect(exact).toBeLessThan(SIZE_BUDGETS.librarySnapshotYear);
    // A deck costs what it should: every slide within the typical imported-slide budget.
    const perDeck = (exact - empty) / 52;
    expect(perDeck).toBeLessThan(17 * SIZE_BUDGETS.slideTypical);
    for (const p of snap.presentations)
      for (const s of p.sections[0]!.slides) expect(jsonBytes(s)).toBeLessThan(SIZE_BUDGETS.slideTypical);
    // The SQL estimate health reports matches the real snapshot.
    const est = lib.snapshotStats();
    expect(est.presentations).toBe(52);
    expect(Math.abs(est.snapshotBytes - exact) / exact).toBeLessThan(0.005);
    const health = (await (await fetch(`${hub.url}/api/v1/health`)).json()) as {
      librarySnapshotBytes: number;
    };
    expect(health.librarySnapshotBytes).toBe(est.snapshotBytes);
  });

  it('measures again only after a change and an interval, and logs once past the follow-up threshold', () => {
    let seq = 1;
    let bytes = 1000;
    let measured = 0;
    const lib = {
      seq: () => seq,
      snapshotStats: () => {
        measured++;
        return { snapshotBytes: bytes, presentations: 3 };
      },
    } as unknown as Library;
    const lines: string[] = [];
    const log = pino({ level: 'warn' }, { write: (l: string) => void lines.push(l) });
    let now = 0;
    const cache = new LibraryStatsCache(lib, log, { minIntervalMs: 5000, now: () => now });
    expect(cache.get()).toMatchObject({ snapshotBytes: 1000, presentations: 3, seq: 1, at: 0 });
    seq = 2;
    bytes = SIZE_BUDGETS.librarySnapshotWarn + 1;
    now = 1000;
    expect(cache.get().snapshotBytes).toBe(1000); // within the interval
    now = 6000;
    expect(cache.get().snapshotBytes).toBe(bytes);
    now = 20_000;
    cache.get(); // same seq: not measured again
    expect(measured).toBe(2);
    seq = 3;
    now = 30_000;
    cache.get();
    expect(measured).toBe(3);
    expect(lines.filter((l) => l.includes('the library snapshot is'))).toHaveLength(1);
  });
});

/**
 * The clips of a native import (design/27 §2 step 5, §8 "Hub"; M3 wave 2, M5 hub scope): embedded videos
 * and sounds become media items that play in place, or the slide's motion background.
 *
 * 1. **Spill and sniff** (`spillClips`, after the pictures): the scan's clip parts (`SceneScan.clips`, at
 *    most `PPTX_LIMITS.clips`) are spilled within what the pictures left of the spill budget, and each is
 *    sniffed (`store.ts` `sniff`): video or sound, which the batches use (`SceneTaskInput.mediaKinds`).
 * 2. **Ingest** (`ClipImport.apply`, before the pictures, so a failed motion background's poster is prepared
 *    like any picture): one media item per part and trim (`clipKey`), through the media hash index
 *    (`clipForFile`: hash plus trim, a failed item never reused), tagged `pptx`, named
 *    '<deck title> – slide N video' (or 'sound'), the extension never checked (part names are the deck's).
 *    At most `PPTX_LIMITS.clips` keys, in slide order, are stored (design/27 §12: the limit bounds the media
 *    items and jobs one deck creates, so one part with a trim per slide counts once per trim); the others
 *    keep their posters. Each part is hashed and probed once, and a part used by several keys is ingested
 *    from hard links (copies where links fail) until its last use.
 *    `p14:trim` is baked (`IngestOpts.trim`): its end is how much PowerPoint cuts from the end, so the clip
 *    is probed for its duration first. The media job is **not** queued here, and never awaited: the job
 *    queues it once version 1 and its LibreOffice follow-up are saved (`MediaService.queue`, after the
 *    follow-up), so LibreOffice never waits behind the deck's own transcodes.
 * 3. **Placeholders** (`pptxmedia:clip<n>`) are replaced by the media ids. A clip that cannot be imported
 *    (linked, missing, past the limits, not a video or sound, unreadable) gives a `[warn]` line in the job
 *    log and the import log, and its object stays a poster: `play` removed, `Slide.audio` dropped, a motion
 *    background's poster put back at the bottom of the slide. A clip that fails later, in its media job, is
 *    left in place: goLive treats slide clips as optional and shows the poster (§8 "Domain").
 *
 * Resume pairs [`clipKey`, media id] (`PptxNativeProgress.clips`) make a re-run reuse what it stored.
 */
import { copyFile, link, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageObject, Slide } from '@ordo/domain';
import { CLIP_PREFIX, type EmittedClip } from '@ordo/pptx-scene';
import { clipKey } from '@ordo/pptx-scene/media.ts';
import { errorMessage } from '../errors.ts';
import { probe } from '../media/ffmpeg.ts';
import { normTrim } from '../media/service.ts';
import { hashFile, readHead, sniff } from '../store.ts';
import { spillDeckParts } from './deckParts.ts';
import { clipForFile } from './mediaParts.ts';
import { logSafe } from './report.ts';
import { PPTX_LIMITS, type PptxDeps } from './shared.ts';

/** A spilled clip part and what its bytes are. */
export type ClipFile = { file: string; kind?: 'video' | 'audio' };

/**
 * Step 1: the scan's clip parts spilled within `bytesLeft` of the spill budget and sniffed: [part, file and
 * kind]; `skipped` counts parts past the limits.
 */
export async function spillClips(
  deck: string,
  dir: string,
  parts: readonly string[],
  bytesLeft: number,
  signal: AbortSignal,
): Promise<{ files: Map<string, ClipFile>; skipped: number }> {
  if (!parts.length) return { files: new Map(), skipped: 0 };
  const spilled = await spillDeckParts(deck, dir, parts, signal, {
    parts: PPTX_LIMITS.clips,
    bytes: bytesLeft,
  });
  const files = new Map<string, ClipFile>();
  let n = 0;
  for (const [part, spilledFile] of spilled.files) {
    let kind: ClipFile['kind'];
    let file = spilledFile;
    try {
      const s = sniff(await readHead(spilledFile));
      if (s?.kind === 'video' || s?.kind === 'audio') kind = s.kind;
      // Named by what the bytes are, never by the part (a part named *.m3u8 or *.sdp must not pick
      // ffprobe's demuxer when the clip's length is probed).
      const named = join(dir, `clip-${++n}.${kind ? s!.ext : 'bin'}`);
      await rename(spilledFile, named);
      file = named;
    } catch {
      kind = undefined; // unreadable: the ingest says so
    }
    files.set(part, { file, ...(kind ? { kind } : {}) });
  }
  return { files, skipped: spilled.skippedCount };
}

/** One slide's clips on their way to version 1. */
export type ClipSlide = {
  /** `SlideRef.index`: 'slide N' in names and warnings is this plus one. */
  index: number;
  slide: Slide;
  clips: readonly EmittedClip[];
  /** A picture-class slide keeps only its sound (its objects wait for a LibreOffice page picture). */
  picture: boolean;
  /** The slide's notes (`Slide.pptx.notes`). */
  notes: string[];
};

export type ClipImportOptions = {
  /** The presentation title, for the media names (already `logSafe`). */
  title: string;
  files: Map<string, ClipFile>;
  /** Resume pairs [`clipKey`, media id], extended as clips are stored. */
  done: [string, string][];
  save: () => void;
  /** A `[warn]` line in the job log and the import log. */
  warn: (msg: string) => void;
  /** A line in the import log. */
  info: (msg: string) => void;
  /** Where copies of a part used twice (whole and trimmed) are made. */
  dir: string;
  probeMs: number;
  signal: AbortSignal;
};

/** Why a clip could not be imported, for its `[warn]` line. */
class ClipError extends Error {}

/** Step 2-3 (see the module comment). */
export class ClipImport {
  /** Media ids this import uses for clips (to queue, and never promoted to the presentation's background). */
  readonly used = new Set<string>();
  /**
   * Media items this run created, their jobs not queued: should the import fail before version 1 is saved,
   * the job queues them anyway (`MediaService.queue`), so no item is left waiting for a job that never comes;
   * a re-import of the deck finds them through the hash index.
   */
  readonly created: string[] = [];
  private readonly ingests = new Map<string, Promise<string | ClipError>>();
  /** The keys stored (the first `PPTX_LIMITS.clips` in slide order). */
  private readonly allowed = new Set<string>();
  /** How many keys still need each spilled file: the last one may take the file, the others get a link. */
  private readonly uses = new Map<string, number>();
  /** Per part: its hash and its duration, each read once whatever the number of trims. */
  private readonly hashes = new Map<string, Promise<{ hash: string; bytes: number }>>();
  private readonly durations = new Map<string, Promise<number | undefined>>();
  private copies = 0;

  constructor(
    private readonly deps: PptxDeps,
    private readonly o: ClipImportOptions,
  ) {}

  /** Ingest every clip the slides use and replace their placeholders. */
  async apply(slides: readonly ClipSlide[]): Promise<void> {
    // Each key with its part (never parsed back out of the key: a part name may hold '#').
    const keys = new Map<string, string>();
    for (const s of slides)
      for (const c of s.clips)
        if (c.part !== undefined && c.id !== undefined && wanted(c, s.picture))
          keys.set(clipKey(c.part, c.trim), c.part);
    let over = 0;
    for (const [k, part] of keys) {
      if (this.allowed.size >= PPTX_LIMITS.clips) {
        over++;
        continue;
      }
      this.allowed.add(k);
      if (this.o.files.has(part)) this.uses.set(part, (this.uses.get(part) ?? 0) + 1);
    }
    if (over)
      this.o.warn(
        `${over} clip(s) past the ${PPTX_LIMITS.clips} (parts and trims) an import may store are not imported: their posters are shown`,
      );
    for (const s of slides) {
      for (const c of s.clips) {
        if (this.o.signal.aborted) return;
        await this.one(s, c);
      }
      sweep(s.slide);
    }
  }

  private async one(s: ClipSlide, c: EmittedClip): Promise<void> {
    const n = s.index + 1;
    const what = c.kind === 'audio' ? 'sound' : 'video';
    const keeps = c.kind === 'audio' ? 'it does not play' : 'its poster is shown';
    if (c.role === 'linked') {
      this.o.warn(`slide ${n}: linked ${what} (${logSafe(c.external ?? '', 100)}) not imported: ${keeps}`);
      return;
    }
    if (c.role === 'missing') {
      this.o.warn(`slide ${n}: a ${what} is missing from the deck: ${keeps}`);
      return;
    }
    if (c.id === undefined || c.part === undefined) return;
    if (!wanted(c, s.picture)) {
      // A picture-class slide's page shows the poster: its video and motion background are left out.
      if (c.role === 'background' && s.slide.backgroundMediaId === c.id) delete s.slide.backgroundMediaId;
      return;
    }
    const got = await this.ingest(c, n);
    if (typeof got === 'string') {
      this.used.add(got);
      place(s, c, got);
      return;
    }
    this.o.warn(`slide ${n}: the ${what} could not be imported (${got.message}): ${keeps}`);
    s.notes.push(`the ${what} could not be imported: ${keeps}`);
    unplace(s, c);
  }

  /** The clip's media id (once per part and trim), or why it could not be imported. */
  private ingest(c: EmittedClip, n: number): Promise<string | ClipError> {
    const key = clipKey(c.part!, c.trim);
    let p = this.ingests.get(key);
    if (!p) {
      p = this.store(key, c, n).catch((e: unknown) => {
        if (e instanceof ClipError) return e;
        // The hub's log has the error; the job log and the import log never get a scratch path.
        this.deps.log.warn({ err: errorMessage(e) }, 'pptx clip not stored');
        return new ClipError('it could not be stored');
      });
      this.ingests.set(key, p);
    }
    return p;
  }

  private async store(key: string, c: EmittedClip, n: number): Promise<string> {
    const part = c.part!;
    if (!this.allowed.has(key))
      throw new ClipError(`past the ${PPTX_LIMITS.clips} clips (parts and trims) an import may store`);
    const resumed = this.o.done.find(([k]) => k === key)?.[1];
    const prior = resumed === undefined ? undefined : this.deps.lib.media.get(resumed);
    const left = this.uses.get(part) ?? 1;
    this.uses.set(part, left - 1);
    if (prior && prior.state !== 'failed') return prior.id;
    const f = this.o.files.get(part);
    if (!f) throw new ClipError('past the clips or bytes an import may extract');
    if (!f.kind) throw new ClipError('not a video or sound file');
    const trim = c.trim ? await this.trimOf(part, f.file, c.trim) : undefined;
    const hashed = await this.hashOf(part, f.file);
    // A part used by several keys (whole and trimmed) is ingested from a link until its last use.
    let file = f.file;
    if (left > 1) {
      file = join(this.o.dir, `clip-copy-${++this.copies}`);
      await link(f.file, file).catch(() => copyFile(f.file, file));
    }
    const name = `${this.o.title} – slide ${n} ${c.kind === 'audio' ? 'sound' : 'video'}`.slice(0, 200);
    const { media, created } = await clipForFile(this.deps, file, {
      name,
      tags: ['pptx'],
      hashed,
      ...(trim ? { trim } : {}),
    });
    if (created) this.created.push(media.id);
    this.o.done.push([key, media.id]);
    this.o.save();
    this.o.info(
      `slide ${n}: ${c.kind === 'audio' ? 'sound' : 'video'} ${created ? 'stored' : 'found already'}${trim ? `, trimmed to ${trim.startMs}-${trim.endMs} ms` : ''}`,
    );
    return media.id;
  }

  /** The part's hash and size, read once (before its last use takes the file). */
  private hashOf(part: string, file: string): Promise<{ hash: string; bytes: number }> {
    let h = this.hashes.get(part);
    if (!h) {
      h = hashFile(file);
      this.hashes.set(part, h);
    }
    return h;
  }

  /**
   * `p14:trim` as the part kept: PowerPoint's `end` is how much is cut from the end, so the clip's duration
   * is probed, once per part. A trim that keeps nothing is ignored (the whole clip plays), as `normTrim` does.
   */
  private async trimOf(
    part: string,
    file: string,
    t: NonNullable<EmittedClip['trim']>,
  ): Promise<{ startMs: number; endMs: number } | undefined> {
    let d = this.durations.get(part);
    if (!d) {
      d = probe(file, this.o.probeMs).then(
        (x) => x.durationMs,
        () => undefined,
      );
      this.durations.set(part, d);
    }
    const durationMs = await d;
    if (durationMs === undefined) throw new ClipError('its length could not be read');
    const trim = normTrim({ startMs: t.startMs, endMs: durationMs - t.endCutMs });
    if (!trim) this.o.info('a clip trimmed to nothing plays whole');
    return trim;
  }
}

/** Whether the slide keeps a use for the clip: a picture-class slide keeps only its sound. */
function wanted(c: EmittedClip, picture: boolean): boolean {
  return !picture || c.role === 'sound';
}

/** The clip's placeholder replaced by its media id. */
function place(s: ClipSlide, c: EmittedClip, id: string): void {
  const sl = s.slide;
  if (c.role === 'play') {
    const play = sl.objects.find((x): x is ImageObject => x.id === c.objectId && x.type === 'image')?.play;
    if (play && play.mediaId === c.id) play.mediaId = id;
  } else if (c.role === 'sound') {
    if (sl.audio && sl.audio.mediaId === c.id) sl.audio.mediaId = id;
  } else if (c.role === 'background') {
    if (sl.backgroundMediaId === c.id) sl.backgroundMediaId = id;
  }
}

/** The clip's use left out: its object stays a poster; a motion background's poster goes back at the bottom. */
function unplace(s: ClipSlide, c: EmittedClip): void {
  const sl = s.slide;
  if (c.role === 'play') {
    const o = sl.objects.find((x): x is ImageObject => x.id === c.objectId && x.type === 'image');
    if (o && o.play?.mediaId === c.id) delete o.play;
  } else if (c.role === 'sound') {
    if (sl.audio?.mediaId === c.id) delete sl.audio;
  } else if (c.role === 'background' && sl.backgroundMediaId === c.id) {
    delete sl.backgroundMediaId;
    // Marked as the import's background (`origin`, design/27 §3.1), as every object the job writes is: a
    // slide set to show its PowerPoint picture leaves it out (`slideContent`), and the background pickers
    // find it.
    if (!s.picture && c.poster)
      sl.objects.unshift({ ...c.poster, origin: { ...(c.poster.origin ?? { src: 'pptx' }), role: 'bg' } });
  }
}

/** Any clip placeholder left (a slide edited by the job meanwhile, a role this wave does not know): removed. */
function sweep(sl: Slide): void {
  const isClip = (v: string | undefined) => v?.startsWith(CLIP_PREFIX) === true;
  for (const o of sl.objects) if (o.type === 'image' && isClip(o.play?.mediaId)) delete o.play;
  if (isClip(sl.audio?.mediaId)) delete sl.audio;
  if (isClip(sl.backgroundMediaId)) delete sl.backgroundMediaId;
}

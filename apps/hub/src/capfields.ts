/**
 * Per-field caps on whole-document saves (design/28 §3.2 "Refused for `light`, per field"; §10 items 6 and 11).
 * A presentation or playlist save sends the whole document, so the hub compares a capped session's body with
 * the stored one, by slide id and by item id, and refuses (403 `cap` naming the field) a change to what a phone
 * may never change: a slide's MIDI cues (show control), its sound and its auto-advance time (playback, as a plan
 * item's), its PowerPoint data and the presentation's source (a phone can never set `pptx.pending` and queue a
 * LibreOffice follow-up), the presentation's loop timing, and a plan item's show-control and playback fields.
 * Pure; O(size of the body), which the schemas already bound.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Media, Playlist, PlaylistItem, Presentation, Slide } from '@ordo/domain';
import { HttpError } from './errors.ts';

export type CapField =
  | 'midiCues'
  | 'slide.audio'
  | 'durationMs'
  | 'pptx'
  | 'source'
  | 'loopTiming'
  | 'keepBackground'
  | 'audioMediaId'
  | 'countdownTimer'
  | 'item.action'
  | 'item.timer'
  | 'loop'
  | 'onEnd'
  | 'audio'
  | 'isBackground';

export type FieldRefusal = { field: CapField; slideId?: string; itemId?: string };

/** What the phone shows when a save is refused for a field (the client shows the hub's message). */
export const FIELD_MESSAGES: Record<CapField, string> = {
  midiCues: "A phone can't change a slide's lighting (MIDI) cues.",
  'slide.audio': "A phone can't change a slide's sound.",
  durationMs: "A phone can't change how long a slide shows before the next one.",
  pptx: "A phone can't change a slide's PowerPoint data.",
  source: "A phone can't change where a presentation was imported from.",
  loopTiming: "A phone can't change how long a loop shows each slide.",
  keepBackground: "A phone can't change whether an item keeps the background.",
  audioMediaId: "A phone can't change an item's music.",
  countdownTimer: "A phone can't change an item's countdown.",
  'item.action': "A phone can't add, change or remove an action item.",
  'item.timer': "A phone can't add, change or remove a timer item.",
  loop: "A phone can't change whether a video loops.",
  onEnd: "A phone can't change what happens when a video ends.",
  audio: "A phone can't change a video's sound settings.",
  isBackground: "A phone can't change whether media is a background.",
};

/** The 403 `cap` for a field refusal: `{ code: 'cap', message, field, slideId? | itemId? }`. */
export function fieldRefusalError(r: FieldRefusal): HttpError {
  return new HttpError(403, 'cap', FIELD_MESSAGES[r.field], { ...r });
}

/** Equal as stored: keys whose value is undefined do not count (a stored document is JSON). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}

const cues = (s: Slide | undefined) => (s?.midiCues?.length ? s.midiCues : []);

function slidesById(p: Presentation | undefined): Map<string, Slide[]> {
  const out = new Map<string, Slide[]>();
  for (const sec of p?.sections ?? [])
    for (const s of sec.slides) {
      const list = out.get(s.id);
      if (list) list.push(s);
      else out.set(s.id, [s]);
    }
  return out;
}

/** The sources a phone may give a new presentation: typed or pasted words, no file (P2's "New song from text"). */
const TYPED_SOURCES: ReadonlySet<string> = new Set(['manual', 'paste', 'songselect']);

/** A new presentation's source a capped session may set: a typed kind with nothing that names a file. */
function typedSource(src: Presentation['source']): boolean {
  if (!src) return true;
  return TYPED_SOURCES.has(src.kind) && src.fileId === undefined && !src.renderer && src.native === undefined;
}

/**
 * Why a capped save of `next` over `stored` (undefined: a new presentation) is refused, or undefined. A new
 * slide carries no MIDI cues, no sound, no auto-advance time and no PowerPoint data; a kept slide keeps them as
 * they are; a slide that had cues may not be removed; the source and the loop timing stay as stored (a new
 * presentation has no loop timing, and a source only of a typed kind without a file); slides sharing an id must
 * agree.
 */
export function presentationRefusal(
  stored: Presentation | undefined,
  next: Presentation,
): FieldRefusal | undefined {
  if (stored ? !same(stored.source, next.source) : !typedSource(next.source)) return { field: 'source' };
  if (!same(stored?.loop, next.loop)) return { field: 'loopTiming' };
  const before = slidesById(stored);
  const after = slidesById(next);
  for (const [id, list] of after) {
    const old = before.get(id)?.[0];
    for (const s of list) {
      if (!same(cues(old), cues(s))) return { field: 'midiCues', slideId: id };
      if (!same(old?.audio, s.audio)) return { field: 'slide.audio', slideId: id };
      if (!same(old?.durationMs, s.durationMs)) return { field: 'durationMs', slideId: id };
      if (!same(old?.pptx, s.pptx)) return { field: 'pptx', slideId: id };
    }
  }
  for (const [id, list] of before)
    if (!after.has(id) && list.some((s) => cues(s).length)) return { field: 'midiCues', slideId: id };
  return undefined;
}

type Item = PlaylistItem;

/** The fields of an item a phone may never change, by kind (owner question 4's default). */
function itemRefusal(old: Item | undefined, it: Item): FieldRefusal | undefined {
  const itemId = it.id;
  if (it.kind === 'action' || old?.kind === 'action') {
    if (!same(old, it)) return { field: 'item.action', itemId };
    return undefined;
  }
  if (it.kind === 'timer' || old?.kind === 'timer') {
    if (!same(old, it)) return { field: 'item.timer', itemId };
    return undefined;
  }
  if (it.kind === 'presentation') {
    const o = old?.kind === 'presentation' ? old : undefined;
    if ((o?.keepBackground === true) !== (it.keepBackground === true))
      return { field: 'keepBackground', itemId };
    if (!same(o?.audioMediaId, it.audioMediaId)) return { field: 'audioMediaId', itemId };
    if (!same(o?.countdownTimer, it.countdownTimer)) return { field: 'countdownTimer', itemId };
    return undefined;
  }
  const o = old?.kind === 'media' ? old : undefined;
  if (!same(o?.loop, it.loop)) return { field: 'loop', itemId };
  if (!same(o?.onEnd, it.onEnd)) return { field: 'onEnd', itemId };
  if (!same(o?.audio, it.audio)) return { field: 'audio', itemId };
  return undefined;
}

/**
 * Why a capped save of a playlist is refused, or undefined: per item id, a presentation item keeps its
 * `keepBackground`, `audioMediaId` and `countdownTimer` (a new one has none), a media item its `loop`, `onEnd`
 * and `audio`; action and timer items are not added, changed or removed.
 */
export function playlistRefusal(stored: Playlist | undefined, next: Playlist): FieldRefusal | undefined {
  const before = new Map<string, Item>();
  for (const it of stored?.items ?? []) if (!before.has(it.id)) before.set(it.id, it);
  const ids = new Set<string>();
  for (const it of next.items) {
    ids.add(it.id);
    const r = itemRefusal(before.get(it.id), it);
    if (r) return r;
  }
  for (const [id, it] of before) {
    if (ids.has(id)) continue;
    if (it.kind === 'action') return { field: 'item.action', itemId: id };
    if (it.kind === 'timer') return { field: 'item.timer', itemId: id };
  }
  return undefined;
}

/** `PUT /media/:id` from a capped session: name and tags only; the playback fields stay as stored. */
export function mediaPatchRefusal(cur: Media, next: Media): FieldRefusal | undefined {
  if (!same(cur.loop, next.loop)) return { field: 'loop' };
  if (!same(cur.isBackground, next.isBackground)) return { field: 'isBackground' };
  if (!same(cur.audio, next.audio)) return { field: 'audio' };
  return undefined;
}

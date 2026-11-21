import type { LiveState, MidiCue, ResolvedMidiCue } from '@ordo/domain';

export type MidiCueDispatch = {
  cue: ResolvedMidiCue;
  source: string;
};

/**
 * Protocol-agnostic MIDI destination key for cross-scope override (Item → Section → Slide).
 * Never deduplicates cues within the same scope/preset.
 */
export function midiDestinationKey(c: Pick<MidiCue, 'deviceName' | 'channel' | 'type' | 'number'>): string {
  const dev = (c.deviceName ?? '').trim().toLowerCase();
  if (c.type === 'programChange') return `${dev}|${c.channel}|programChange`;
  return `${dev}|${c.channel}|${c.type}|${c.number}`;
}

function formatSource(scopeLabel: string, cue: ResolvedMidiCue): string {
  return cue.presetName ? `${scopeLabel} · ${cue.presetName}` : scopeLabel;
}

/**
 * Outgoing show-control cues to send when the operator's live view moves from `prev` to `next`:
 * - Item triggers fire once on entering a new playlist item (`itemId` changes).
 * - Section triggers fire once on entering a new section occurrence (`itemId` or `arrangementPos` changes).
 * - Slide triggers fire on landing on that specific slide.
 * - Cross-scope override: if a narrower scope targets the same MIDI destination key as a broader scope
 *   on the same transition, the narrower scope's message replaces the broader one (never collapsing
 *   multi-cue presets within the same scope).
 * - Suppresses firing on initial hydration / WebSocket reconnect (`opts.fromSnapshot` or initial live load).
 */
export function midiCuesOnChange(
  prev: LiveState,
  next: LiveState,
  opts?: { fromSnapshot?: boolean },
): MidiCueDispatch[] {
  if (opts?.fromSnapshot) return [];
  if (next.live === prev.live || next.live === undefined) return [];
  // Suppress initial live-state hydration when opening or reloading the operator mid-service.
  if (prev.mode !== 'live' && prev.cues.length === 0) return [];

  const nextCue = next.cues[next.live];
  if (!nextCue) return [];
  const prevCue = prev.live !== undefined ? prev.cues[prev.live] : undefined;

  const enteredItem = nextCue.itemId !== prevCue?.itemId;
  const enteredBackground =
    !!nextCue.backgroundMediaId && (enteredItem || nextCue.backgroundMediaId !== prevCue?.backgroundMediaId);
  const enteredSection =
    nextCue.kind === 'slide' && (enteredItem || nextCue.arrangementPos !== prevCue?.arrangementPos);

  const bgName = nextCue.backgroundMediaId
    ? (next.resolved?.media[nextCue.backgroundMediaId]?.name ?? 'Background')
    : 'Background';

  const bgBatch: MidiCueDispatch[] =
    enteredBackground && nextCue.backgroundMidi?.length
      ? nextCue.backgroundMidi.map((cue) => ({ cue, source: formatSource(`Background: ${bgName}`, cue) }))
      : [];

  const itemBatch: MidiCueDispatch[] =
    enteredItem && nextCue.itemMidi?.length
      ? nextCue.itemMidi.map((cue) => ({ cue, source: formatSource(`Item: ${nextCue.label}`, cue) }))
      : [];

  const sectionBatch: MidiCueDispatch[] =
    enteredSection && nextCue.sectionMidi?.length
      ? nextCue.sectionMidi.map((cue) => ({
          cue,
          source: formatSource(`Section: ${nextCue.sectionLabel ?? nextCue.label}`, cue),
        }))
      : [];

  const slideBatch: MidiCueDispatch[] = nextCue.midiCues?.length
    ? nextCue.midiCues.map((cue) => ({ cue, source: formatSource(`Slide: ${nextCue.label}`, cue) }))
    : [];

  if (!bgBatch.length && !itemBatch.length && !sectionBatch.length && !slideBatch.length) return [];

  const slideKeys = new Set(slideBatch.map((d) => midiDestinationKey(d.cue)));
  const filteredSection = sectionBatch.filter((d) => !slideKeys.has(midiDestinationKey(d.cue)));
  const sectionAndSlideKeys = new Set([
    ...slideKeys,
    ...filteredSection.map((d) => midiDestinationKey(d.cue)),
  ]);
  const filteredItem = itemBatch.filter((d) => !sectionAndSlideKeys.has(midiDestinationKey(d.cue)));
  const narrowerKeys = new Set([
    ...sectionAndSlideKeys,
    ...filteredItem.map((d) => midiDestinationKey(d.cue)),
  ]);
  const filteredBg = bgBatch.filter((d) => !narrowerKeys.has(midiDestinationKey(d.cue)));

  return [...filteredBg, ...filteredItem, ...filteredSection, ...slideBatch];
}

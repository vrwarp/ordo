import { isHiddenCue, type LiveState, sectionsOfItem } from '@ordo/domain';
import { mediaPlayTarget } from '@ordo/live-state';
import type { DeckView } from '@ordo/surfaces';

/** What the Stream Deck shows, derived from live state. */
export function deckView(s: LiveState, connected: boolean, masterDb?: number): DeckView {
  const ref = s.live ?? s.armed;
  const secs = ref !== undefined ? sectionsOfItem(s.cues, ref) : [];
  const liveCue = s.live !== undefined ? s.cues[s.live] : undefined;
  const cur = s.live === undefined ? undefined : s.cues[s.live]?.itemIndex;
  const nextItems: string[] = [];
  const items = s.resolved?.playlist.items ?? [];
  // The items Next item goes to, one press each: those after the live one with a cue that is not hidden
  // (design/27 §9), so the "Next N" keys, which press it N times, land on the item they name.
  let last: number | undefined;
  for (const c of s.cues) {
    if ((cur !== undefined && c.itemIndex <= cur) || c.itemIndex === last || isHiddenCue(c)) continue;
    last = c.itemIndex;
    const item = items[c.itemIndex];
    let label = c.label;
    if (item?.kind === 'presentation') label = s.resolved?.presentations[item.presentationId]?.title ?? label;
    nextItems.push(label);
    if (nextItems.length >= 3) break;
  }
  // The play/pause key shows what F8 acts on, as the LayerBar does (design/27 §8): a waiting click-start
  // sound comes before a playing video, so the key offers Play (sub-label 'sound') until it starts.
  const target = mediaPlayTarget(s);
  const mediaPlaying =
    target === 'video'
      ? s.layers.media.content?.state === 'playing'
      : target === 'audio' && s.audio.content?.state === 'playing';
  return {
    sections: secs.map((x) => ({ short: x.short, label: x.label, pos: x.pos })),
    liveSectionPos: liveCue?.arrangementPos,
    nextItems,
    black: s.black,
    logo: s.props.logo,
    mediaPlaying,
    ...(target === 'slideSound' ? { slideSoundWaiting: true } : {}),
    liveLabel: liveCue?.label,
    connected,
    masterDb,
  };
}

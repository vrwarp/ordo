import { itemStarts, type LiveState, sectionsOfItem } from '@ordo/domain';
import type { DeckView } from '@ordo/surfaces';

/** What the Stream Deck shows, derived from live state. */
export function deckView(s: LiveState, connected: boolean, masterDb?: number): DeckView {
  const ref = s.live ?? s.armed;
  const secs = ref !== undefined ? sectionsOfItem(s.cues, ref) : [];
  const liveCue = s.live !== undefined ? s.cues[s.live] : undefined;
  const starts = itemStarts(s.cues);
  const cur = s.live ?? -1;
  const nextItems: string[] = [];
  const items = s.resolved?.playlist.items ?? [];
  for (const st of starts) {
    if (st <= cur) continue;
    const c = s.cues[st];
    if (!c) continue;
    const item = items[c.itemIndex];
    let label = c.label;
    if (item?.kind === 'presentation') label = s.resolved?.presentations[item.presentationId]?.title ?? label;
    nextItems.push(label);
    if (nextItems.length >= 3) break;
  }
  return {
    sections: secs.map((x) => ({ short: x.short, label: x.label, pos: x.pos })),
    liveSectionPos: liveCue?.arrangementPos,
    nextItems,
    black: s.black,
    logo: s.props.logo,
    mediaPlaying: s.layers.media.content?.state === 'playing' || s.audio.content?.state === 'playing',
    liveLabel: liveCue?.label,
    connected,
    masterDb,
  };
}

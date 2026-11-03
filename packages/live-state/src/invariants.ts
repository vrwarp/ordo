import type { LiveState } from '@ordo/domain';

/**
 * Structural invariants of a live state (design/25). Every window checks them after applying a change;
 * a violation means its state cannot be trusted: resync first, restart if that does not clear it.
 * Returns human-readable violations, empty when the state is sound. Never throws.
 */
export function checkInvariants(s: LiveState): string[] {
  const v: string[] = [];
  try {
    if (!Number.isInteger(s.seq) || s.seq < 0) v.push(`seq ${s.seq} is not a non-negative integer`);
    if (s.mode !== 'idle' && s.mode !== 'live') v.push(`mode ${String(s.mode)} is unknown`);
    if (!Array.isArray(s.cues)) {
      v.push('cues is not an array');
      return v;
    }
    const n = s.cues.length;
    if (s.mode === 'idle' && n > 0) v.push('idle state has cues');
    if (s.mode === 'live' && !s.resolved) v.push('live state has no resolved playlist');
    s.cues.forEach((c, i) => {
      if (c?.index !== i) v.push(`cue at ${i} has index ${c?.index}`);
    });
    const inRange = (x: number | undefined, what: string) => {
      if (x !== undefined && (!Number.isInteger(x) || x < 0 || x >= n))
        v.push(`${what} ${x} out of range (0..${n - 1})`);
    };
    inRange(s.live, 'live');
    inRange(s.armed, 'armed');
    const slide = s.layers?.slide?.content;
    if (slide) {
      inRange(slide.cueIndex, 'slide layer cue');
      const c = s.cues[slide.cueIndex];
      if (c && c.slideId !== slide.slideId)
        v.push(`slide layer slide ${slide.slideId} does not match cue ${slide.cueIndex}`);
    }
    const media = s.layers?.media?.content;
    if (media) {
      inRange(media.cueIndex, 'media layer cue');
      if (s.resolved && !s.resolved.media[media.mediaId])
        v.push(`media layer references unknown media ${media.mediaId}`);
    }
    const bg = s.layers?.background?.content;
    if (bg && s.resolved && !s.resolved.media[bg.mediaId])
      v.push(`background references unknown media ${bg.mediaId}`);
    const audio = s.audio?.content;
    if (audio) inRange(audio.cueIndex, 'audio cue');
    for (const [name, layer] of Object.entries(s.layers ?? {})) {
      if (!layer || !Number.isFinite(layer.at)) v.push(`layer ${name} has no finite at`);
      else if (layer.seq > s.seq) v.push(`layer ${name} seq ${layer.seq} is ahead of state seq ${s.seq}`);
    }
    if (!Array.isArray(s.messages)) v.push('messages is not an array');
    else if (s.messages.length > 50) v.push(`${s.messages.length} messages exceed the bound`);
    if (s.props?.countdownTimerId && !s.timers?.[s.props.countdownTimerId])
      v.push('countdown prop references an unknown timer');
  } catch (err) {
    v.push(`invariant check threw: ${(err as Error).message}`);
  }
  return v;
}

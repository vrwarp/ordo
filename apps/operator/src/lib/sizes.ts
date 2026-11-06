import {
  formatBytes,
  jsonBytes,
  type Media,
  type Presentation,
  presentationBytes,
  previewSlice,
  SIZE_BUDGETS,
} from '@ordo/domain';

/**
 * Size checks of what the operator sends (design/27 §3.4). The hub closes a socket whose `preview` or
 * `live.adopt` is over 16 MiB, so the operator measures them first; `live.adopt` is checked by `LiveCore`.
 */

export type PreviewMessage = {
  t: 'preview';
  to: string;
  presentation: Presentation & { media: Media[] };
  slideId?: string;
};

/**
 * The `preview` message for one slide: the slide's section with the presentation-level fields
 * (`previewSlice`) and the media records it needs, measured. Refused (with the reason to show) when even
 * that is over `adoptMax`, so a hand-made giant slide never trips the socket cap.
 */
export function previewMessage(
  to: string,
  p: Presentation,
  slideId: string | undefined,
  media: Media[],
): { ok: true; message: PreviewMessage; bytes: number } | { ok: false; reason: string; bytes: number } {
  const message: PreviewMessage = {
    t: 'preview',
    to,
    presentation: { ...previewSlice(p, slideId), media },
    slideId,
  };
  const bytes = jsonBytes(message);
  if (bytes > SIZE_BUDGETS.adoptMax)
    return {
      ok: false,
      bytes,
      reason: `This slide is too large to preview (${formatBytes(bytes)}; at most ${formatBytes(SIZE_BUDGETS.adoptMax)}).`,
    };
  return { ok: true, message, bytes };
}

/**
 * The editor's size check of a presentation it is about to save: `refuse` above what the hub accepts in a
 * PUT (instead of a bare 413), `warn` above the 4 MiB presentation budget (it still saves).
 */
export function saveSizeCheck(p: Presentation): { bytes: number; refuse?: string; warn?: string } {
  const bytes = presentationBytes(p);
  if (bytes > SIZE_BUDGETS.putMax)
    return {
      bytes,
      refuse: `This presentation is ${formatBytes(bytes)}, more than the hub accepts (${formatBytes(SIZE_BUDGETS.putMax)}). Split it into smaller presentations to save it.`,
    };
  if (bytes > SIZE_BUDGETS.presentationMax)
    return {
      bytes,
      warn: `This presentation is ${formatBytes(bytes)}, over the ${formatBytes(SIZE_BUDGETS.presentationMax)} budget: going live and keeping every operator's library in sync get slower. Consider splitting it.`,
    };
  return { bytes };
}

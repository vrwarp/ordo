import type { LiveState, Media, Output, Presentation } from '@ordo/domain';
import type { OutputHealthEntry } from '@ordo/protocol';

export type PreviewTarget = { id: string; name: string; connected: boolean };

/**
 * Outputs that may show a preview (prd/03 "Send to preview"): audience outputs (not the stage display)
 * that are enabled, while no playlist is live. Connected ones come first; a window that is not reporting
 * is still listed (it may be launching) but marked.
 */
export function previewTargets(
  outputs: Output[],
  health: Record<string, OutputHealthEntry | undefined>,
  state: LiveState,
): PreviewTarget[] {
  if (state.mode === 'live') return [];
  return outputs
    .filter((o) => o.enabled && o.kind !== 'stage')
    .map((o) => ({ id: o.id, name: o.name, connected: !!health[o.id]?.connected }))
    .sort((a, b) => Number(b.connected) - Number(a.connected));
}

/** Why "Send to preview" is unavailable, or null when it can be used. */
export function previewBlockedReason(state: LiveState, targets: PreviewTarget[]): string | null {
  if (state.mode === 'live') return 'A playlist is live; outputs cannot preview until End service.';
  if (!targets.length) return 'No enabled audience output to preview on.';
  return null;
}

/**
 * Media records the previewed slide needs (presentation and slide backgrounds, image objects, an imported
 * page's picture and a PowerPoint slide's reference picture), so the output can resolve them without the
 * hub's resolved playlist. Unknown ids are skipped.
 */
export function previewMedia(
  p: Presentation,
  slideId: string | undefined,
  lookup: (id: string) => Media | undefined,
): Media[] {
  const ids = new Set<string>();
  if (p.backgroundMediaId) ids.add(p.backgroundMediaId);
  for (const sec of p.sections)
    for (const sl of sec.slides) {
      if (slideId && sl.id !== slideId) continue;
      if (sl.backgroundMediaId) ids.add(sl.backgroundMediaId);
      for (const o of sl.objects) if (o.type === 'image') ids.add(o.mediaId);
      // A picture slide draws its page (design/27 §11 "Fix-now"); 'Show PowerPoint picture' its reference.
      if (sl.imported?.imageMediaId) ids.add(sl.imported.imageMediaId);
      if (sl.pptx?.show === 'picture' && sl.pptx.refMediaId) ids.add(sl.pptx.refMediaId);
    }
  const out: Media[] = [];
  for (const id of ids) {
    const m = lookup(id);
    if (m) out.push(m);
  }
  return out;
}

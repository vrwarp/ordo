import type { SlideObject } from '@ordo/domain';
import { useSyncExternalStore } from 'react';
import { useEditor } from './editorStore.ts';
import { subscribeWholeLighter, wholeKeepsLighter, wholeSlideKey } from './wholeState.ts';

/*
 * The one-line note under the Object panel's name row for an object the editor draws as the lighter copy
 * (design/15 "Canvas drawing"; OQ-LE2, the owner's words of 2026-11-20). The canvas's whole drawing
 * (wholeDraw.ts) publishes which candidates keep the copy for a lasting reason (a service is live, a coarse
 * pointer, `?editor=light`, too detailed to build in one piece, too big at this zoom or in all); the note
 * shows for the selected object that is one of them, and is gone once the whole drawing has replaced the copy.
 */

/** What the note says: the owner's words. */
export const WHOLE_NOTE = 'Too detailed to draw here while you edit; the screens draw it whole.';

/** The note, as the panel's other small notes are drawn: muted, small, one paragraph that wraps. */
export function WholeNoteView({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return (
    <div className="muted small" data-whole-note>
      {WHOLE_NOTE}
    </div>
  );
}

/** The note for the selected object of the slide `slideId` (store-bound: it follows the canvas's list). */
export function WholeNote({ o, slideId }: { o: SlideObject; slideId: string }) {
  const presentation = useEditor((s) => s.id);
  const read = () => wholeKeepsLighter(wholeSlideKey(presentation, slideId), o.id);
  return <WholeNoteView shown={useSyncExternalStore(subscribeWholeLighter, read, read)} />;
}

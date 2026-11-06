import type { SlideObject } from '@ordo/domain';
import { useMemo } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { toast } from '../../state/toasts.ts';
import { applyToSimilar, pictureToBackground } from './actions.ts';
import { useEditor } from './editorStore.ts';
import { coversSlide, similarObjects } from './ops/slides.ts';

/*
 * The Object panel's slide-wide actions (M4 item E): 'Apply to similar boxes…' for a box imported from a
 * PowerPoint placeholder or layout shape (design/27 §11 item 10, which replaces master editing), and 'Use
 * as background' for a picture that covers the slide (§11 item 6).
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The confirmation's question: 'Apply to 12 boxes on 12 slides?'. */
export function similarQuestion(boxes: number, slides: number): string {
  return `Apply to ${plural(boxes, 'box', 'boxes')} on ${plural(slides, 'slide')}? They take this box's style and paragraph styles; their text stays as it is.`;
}

export type ObjectSlideOpsViewProps = {
  /** Similar boxes on other slides (`similarObjects`) and the slides they are on. */
  similar: number;
  similarSlides: number;
  /** Whether the object is a picture covering the slide (`coversSlide`). */
  covers: boolean;
  readOnly: boolean;
  onApply: () => void;
  onBackground: () => void;
};

/** The actions, props only; nothing when neither applies. */
export function ObjectSlideOpsView(props: ObjectSlideOpsViewProps) {
  if (!props.similar && !props.covers) return null;
  return (
    <section className="col" style={{ gap: 8 }} data-object-slide-ops>
      {props.similar > 0 && (
        <div className="col" style={{ gap: 2 }}>
          <button type="button" className="small" disabled={props.readOnly} onClick={props.onApply}>
            Apply to similar boxes…
          </button>
          <span className="muted small">
            {plural(props.similar, 'box', 'boxes')} on {plural(props.similarSlides, 'other slide')} come from
            the same PowerPoint placeholder or layout shape.
          </span>
        </div>
      )}
      {props.covers && (
        <div className="col" style={{ gap: 2 }}>
          <button type="button" className="small" disabled={props.readOnly} onClick={props.onBackground}>
            Use as background
          </button>
          <span className="muted small">
            Moves this picture to the slide's background, where Replace background can swap it on every slide.
          </span>
        </div>
      )}
    </section>
  );
}

/** The actions bound to the editor, for the selected object `o` of the open slide. */
export function ObjectSlideOps({ o, readOnly }: { o: SlideObject; readOnly: boolean }) {
  const draft = useEditor((s) => s.draft);
  const slideId = useEditor((s) => s.slideId);
  const similar = useMemo(
    () => (draft && slideId && o.type === 'text' ? similarObjects(draft, slideId, o.id) : []),
    [draft, slideId, o],
  );
  if (!draft || !slideId) return null;
  const slides = new Set(similar.map((x) => x.slideId)).size;
  return (
    <ObjectSlideOpsView
      similar={similar.length}
      similarSlides={slides}
      covers={coversSlide(draft, o)}
      readOnly={readOnly}
      onApply={async () => {
        if (readOnly) return;
        const ok = await confirmDialog(
          'Apply to similar boxes',
          similarQuestion(similar.length, slides),
          'Apply',
        );
        if (!ok) return;
        const n = applyToSimilar(o.id);
        toast(n ? `Applied to ${plural(n, 'box', 'boxes')}.` : 'They already look like this box.', 'ok');
      }}
      onBackground={() => !readOnly && pictureToBackground(o.id)}
    />
  );
}

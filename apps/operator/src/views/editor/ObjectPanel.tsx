import { nearColor, type SlideObject, type TextStyle } from '@ordo/domain';
import { useEffect, useState } from 'react';
import { BoxEditor, Check, ColorField, NumberField, Select } from '../../components/fields.tsx';
import { TextStyleEditor } from '../../components/TextStyleEditor.tsx';
import { useLibrary } from '../../state/library.ts';
import { refit, typeText } from './actions.ts';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import { CropControl } from './CropControl.tsx';
import { change, useEditor } from './editorStore.ts';
import { FormatBar } from './FormatBar.tsx';
import { VideoPanel } from './MediaPanels.tsx';
import { getSlide, markOverride, updateObject, updateSlide } from './ops.ts';
import type { TextRange } from './ops/text.ts';
import { ParagraphStrip } from './ParagraphStrip.tsx';
import { fitMessage } from './textFit.ts';

/** Property panel for the selected object: every TextStyle, ImageObject and ShapeObject field (prd/03). */
export function ObjectPanel({ o, readOnly }: { o: SlideObject; readOnly: boolean }) {
  const slideId = useEditor((s) => s.slideId)!;
  const draft = useEditor((s) => s.draft)!;
  const looks = useLibrary((s) => s.data.settings.looks);
  const media = useLibrary((s) => s.data.media);
  const [picking, setPicking] = useState(false);
  // The text field's selection, for the format bar and the paragraph strip (M4 item C).
  const [range, setRange] = useState<TextRange>({ start: 0, end: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new object starts with a caret at its start
  useEffect(() => setRange({ start: 0, end: 0 }), [o.id]);
  const slide = getSlide(draft, slideId);
  const isLyric =
    slide?.lyricObjectId === o.id ||
    (!slide?.lyricObjectId && slide?.objects.find((x) => x.type === 'text')?.id === o.id);
  const themed = isLyric && !!draft.themeId;
  const set = (fn: (x: SlideObject) => SlideObject, key?: string, overridePath?: string) => {
    if (readOnly) return;
    change((p) => {
      let q = updateObject(p, slideId, o.id, fn);
      if (themed && overridePath) q = updateSlide(q, slideId, (s) => markOverride(s, overridePath));
      return q;
    }, key);
  };
  const marks = new Set(slide?.overrides ?? []);
  const keyLooks = looks.filter(
    (l) => l.kind === 'stream' || (l.clearColor.g > 200 && l.clearColor.r < 60 && l.clearColor.b < 60),
  );
  const keyClash = o.type === 'text' && keyLooks.some((l) => nearColor(o.style.color, l.clearColor));

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row">
        <b className="grow">
          {o.type === 'text'
            ? isLyric
              ? 'Lyric text box'
              : 'Text box'
            : o.type === 'image'
              ? o.play
                ? 'Video'
                : 'Image'
              : `Shape (${o.shape})`}
        </b>
        {o.type === 'text' && !isLyric && (
          <button
            type="button"
            className="small"
            disabled={readOnly}
            onClick={() => change((p) => updateSlide(p, slideId, (s) => ({ ...s, lyricObjectId: o.id })))}
          >
            Make lyric box
          </button>
        )}
      </div>
      {o.type === 'text' && (
        <>
          <FormatBar o={o} range={clampRange(range, o.text.length)} readOnly={readOnly} />
          <textarea
            rows={5}
            value={o.text}
            disabled={readOnly}
            id="ordo-text-editor"
            aria-label="Text"
            onSelect={(e) =>
              setRange({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })
            }
            onChange={(e) => {
              // Runs and paragraph styles follow the edit (design/27 §11): a typo fix keeps the formatting.
              const next = e.target.value;
              const caret = e.target.selectionEnd;
              setRange({ start: e.target.selectionStart, end: caret });
              if (!readOnly) typeText(o.id, next, caret);
            }}
          />
          <ParagraphStrip o={o} range={clampRange(range, o.text.length)} readOnly={readOnly} />
          {keyClash && (
            <div className="banner small">
              This text colour is close to a look's key colour; it may be keyed out on the stream.
            </div>
          )}
        </>
      )}
      <section>
        <h4>
          Position and size{marks.has('box') && <span className="override-mark"> ● overrides theme</span>}
        </h4>
        <BoxEditor value={o.box} onChange={(box) => set((x) => ({ ...x, box }), undefined, 'box')} />
      </section>
      <NumberField
        label="Opacity"
        value={o.opacity}
        min={0}
        max={1}
        step={0.05}
        onChange={(opacity) => set((x) => ({ ...x, opacity }))}
      />
      {o.type === 'text' && (
        <section>
          <h4>Text style</h4>
          <div role="status">
            {fitMessage(o) && (
              <div className="banner small" style={{ marginBottom: 8 }}>
                {fitMessage(o)}
              </div>
            )}
          </div>
          <TextStyleEditor
            value={o.style}
            box
            onRefit={readOnly ? undefined : () => refit(o.id)}
            marks={themed ? marks : undefined}
            onChange={(style: TextStyle, key) =>
              set(
                (x) => ({ ...x, style }) as SlideObject,
                `style:${o.id}:${String(key)}`,
                `style.${String(key)}`,
              )
            }
          />
        </section>
      )}
      {o.type === 'image' && (
        <section className="col">
          <h4>{o.play ? 'Poster' : 'Image'}</h4>
          <div className="row">
            <span className="grow ellipsis small">
              {media.find((m) => m.id === o.mediaId)?.name ?? 'Missing media'}
            </span>
            <button type="button" className="small" disabled={readOnly} onClick={() => setPicking(true)}>
              Replace
            </button>
          </div>
          <Select
            label="Fit"
            value={o.fit}
            options={['contain', 'cover', 'stretch'] as const}
            onChange={(fit) => set((x) => ({ ...x, fit }) as SlideObject)}
          />
          <NumberField
            label="Corner radius"
            value={o.radius}
            min={0}
            onChange={(radius) => set((x) => ({ ...x, radius }) as SlideObject)}
          />
          <CropControl o={o} readOnly={readOnly} />
          {picking && (
            <MediaPickerDialog
              title={o.play ? 'Choose a poster image' : 'Choose an image'}
              kinds={['image']}
              onClose={() => setPicking(false)}
              onPick={(m) => {
                // The old picture's crop does not fit the new one: it is dropped (design/27 §15 M3).
                set((x) => {
                  if (x.type !== 'image') return x;
                  const { crop: _crop, ...rest } = x;
                  return { ...rest, mediaId: m.id };
                });
                setPicking(false);
              }}
            />
          )}
        </section>
      )}
      {o.type === 'image' && slide && (
        <VideoPanel o={o} slide={slide} media={(id) => media.find((m) => m.id === id)} readOnly={readOnly} />
      )}
      {o.type === 'shape' && (
        <section className="col">
          <h4>Shape</h4>
          <Select
            label="Shape"
            value={o.shape}
            options={['rect', 'ellipse', 'line'] as const}
            onChange={(shape) => set((x) => ({ ...x, shape }) as SlideObject)}
          />
          {o.shape !== 'line' && (
            <>
              <Check
                label="Fill"
                value={!!o.fill}
                onChange={(on) =>
                  set((x) => ({ ...x, fill: on ? { r: 40, g: 90, b: 200, a: 1 } : undefined }) as SlideObject)
                }
              />
              {o.fill && (
                <ColorField value={o.fill} onChange={(fill) => set((x) => ({ ...x, fill }) as SlideObject)} />
              )}
            </>
          )}
          <Check
            label="Stroke"
            value={!!o.stroke}
            onChange={(on) =>
              set(
                (x) =>
                  ({
                    ...x,
                    stroke: on ? { width: 4, color: { r: 255, g: 255, b: 255, a: 1 } } : undefined,
                  }) as SlideObject,
              )
            }
          />
          {o.stroke && (
            <div className="row wrap">
              <NumberField
                value={o.stroke.width}
                min={0}
                onChange={(width) => set((x) => ({ ...x, stroke: { ...o.stroke!, width } }) as SlideObject)}
                suffix="px"
                width={60}
              />
              <ColorField
                value={o.stroke.color}
                onChange={(color) => set((x) => ({ ...x, stroke: { ...o.stroke!, color } }) as SlideObject)}
              />
            </div>
          )}
          {o.shape === 'rect' && (
            <NumberField
              label="Corner radius"
              value={o.radius}
              min={0}
              onChange={(radius) => set((x) => ({ ...x, radius }) as SlideObject)}
            />
          )}
        </section>
      )}
    </div>
  );
}

/** A selection kept inside the text (the text can shrink under it: undo, another editor's change). */
function clampRange(r: TextRange, len: number): TextRange {
  const start = Math.max(0, Math.min(len, r.start));
  return { start, end: Math.max(start, Math.min(len, r.end)) };
}

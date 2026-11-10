import { type Box, nearColor, type SlideObject, type TextStyle } from '@ordo/domain';
import { useEffect, useState } from 'react';
import { Check, ColorField, NumberField, Select } from '../../components/fields.tsx';
import { TextStyleEditor } from '../../components/TextStyleEditor.tsx';
import { ObjectSlideOps } from './ObjectSlideOps.tsx';
import { useLibrary } from '../../state/library.ts';
import { refit, replacePictureWith, typeText } from './actions.ts';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import { CropControl } from './CropControl.tsx';
import { change, redo, undo, useEditor } from './editorStore.ts';
import { historyKey } from './editorKeys.ts';
import { FormatBar } from './FormatBar.tsx';
import { GroupNote, LockedNote, SelectionBox } from './GroupPanel.tsx';
import { VideoPanel } from './MediaPanels.tsx';
import {
  ShapeFillFields,
  ShapeGeometryField,
  ShapeLineFields,
  ShapeShadowField,
  shapeName,
} from './ObjectShapeFields.tsx';
import { getSlide, markOverride, updateObject, updateSlide } from './ops.ts';
import { isLocked } from './ops/group.ts';
import type { TextRange } from './ops/text.ts';
import { ParagraphStrip } from './ParagraphStrip.tsx';
import { fitMessage } from './textFit.ts';

const PLACEMENT_PRESETS: { id: string; label: string; desc: string; box: Box }[] = [
  {
    id: 'center',
    label: 'Center Screen',
    desc: 'Auditorium main',
    box: { x: 120, y: 140, w: 1680, h: 800, rotation: 0 },
  },
  {
    id: 'lower-third',
    label: 'Lower Third',
    desc: 'Livestream overlay',
    box: { x: 120, y: 720, w: 1680, h: 280, rotation: 0 },
  },
  {
    id: 'bottom',
    label: 'Bottom Third',
    desc: 'Stage placement',
    box: { x: 120, y: 640, w: 1680, h: 380, rotation: 0 },
  },
  {
    id: 'top',
    label: 'Top Banner',
    desc: 'Top monitor',
    box: { x: 120, y: 80, w: 1680, h: 280, rotation: 0 },
  },
];

/** Property panel for the selected object: every TextStyle, ImageObject and ShapeObject field (prd/03). */
export function ObjectPanel({ o, readOnly: liveLocked }: { o: SlideObject; readOnly: boolean }) {
  // A locked object (PowerPoint art, SmartArt, table grids): its box only; every other field is read-only
  // (design/27 §11 "Locked objects"). `readOnly` below covers both.
  const locked = isLocked(o);
  const readOnly = liveLocked || locked;
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
    if (liveLocked || (locked && overridePath !== 'box')) return;
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
  // A picture cut to a geometry (design/27 §3.1 `ImageObject.mask`: a preset, freeform paths or a geometry
  // file) ignores its corner radius, which stays only for an older build.
  const masked = o.type === 'image' && !!(o.mask?.preset || o.mask?.paths?.length || o.mask?.ref);

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
              : `Shape (${shapeName(o)})`}
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
      <LockedNote o={o} />
      <GroupNote o={o} readOnly={liveLocked} />
      {o.type === 'text' && (
        <>
          <FormatBar o={o} range={clampRange(range, o.text.length)} readOnly={readOnly} />
          <div className="col" style={{ gap: 4 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className="muted small">Text content:</span>
              <span className="muted small" style={{ fontSize: 11 }}>
                Double-click canvas to edit inline
              </span>
            </div>
            <textarea
              rows={4}
              value={o.text}
              disabled={readOnly}
              id="ordo-text-editor"
              aria-label="Text"
              onSelect={(e) =>
                setRange({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })
              }
              onKeyDown={(e) => {
                // Ctrl+Z and Ctrl+Y here are the editor's undo and redo, not the field's own: the field's
                // undo knows nothing of a Bold or a colour and would take typed letters back instead. Typing
                // is one undo step per pause, so the editor's undo covers the text too.
                const step = historyKey(e);
                if (!step) return;
                e.preventDefault();
                e.stopPropagation();
                if (readOnly) return;
                const el = e.currentTarget;
                const at = { start: el.selectionStart, end: el.selectionEnd };
                (step === 'undo' ? undo : redo)();
                // The field shows the restored text on the next render: the caret stays where it was.
                requestAnimationFrame(() => {
                  const f = document.getElementById('ordo-text-editor');
                  if (!(f instanceof HTMLTextAreaElement)) return;
                  const n = f.value.length;
                  const r = { start: Math.min(at.start, n), end: Math.min(at.end, n) };
                  f.setSelectionRange(r.start, r.end);
                  setRange(r);
                });
              }}
              onChange={(e) => {
                // Runs and paragraph styles follow the edit (design/27 §11): a typo fix keeps the formatting.
                const next = e.target.value;
                const caret = e.target.selectionEnd;
                setRange({ start: e.target.selectionStart, end: caret });
                if (!readOnly) typeText(o.id, next, caret);
              }}
            />
          </div>
          <ParagraphStrip o={o} range={clampRange(range, o.text.length)} readOnly={readOnly} />
          {keyClash && (
            <div className="banner small">
              This text colour is close to a look's key colour; it may be keyed out on the stream.
            </div>
          )}
        </>
      )}
      {isLyric && (
        <div className="col" style={{ gap: 6 }}>
          <span
            className="small bold"
            style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
          >
            Screen Placement Presets
          </span>
          <div className="grid2" style={{ gap: 6 }}>
            {PLACEMENT_PRESETS.map((p) => {
              const active =
                Math.abs(o.box.x - p.box.x) < 20 &&
                Math.abs(o.box.y - p.box.y) < 20 &&
                Math.abs(o.box.w - p.box.w) < 30 &&
                Math.abs(o.box.h - p.box.h) < 30;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={active ? 'active' : ''}
                  disabled={readOnly}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: '6px 8px',
                    borderRadius: 8,
                    background: active ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg3)',
                    border: active ? '1.5px solid var(--accent)' : '1px solid var(--line)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  onClick={() => set((x) => ({ ...x, box: p.box }), undefined, 'box')}
                >
                  <span
                    style={{ fontSize: 12, fontWeight: 600, color: active ? 'var(--accent)' : 'var(--fg)' }}
                  >
                    {p.label}
                  </span>
                  <span className="muted" style={{ fontSize: 10 }}>
                    {p.desc}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <section>
        <h4>
          Position and size{marks.has('box') && <span className="override-mark"> ● overrides theme</span>}
        </h4>
        <SelectionBox
          o={o}
          readOnly={liveLocked}
          onChange={(box) => set((x) => ({ ...x, box }), undefined, 'box')}
        />
      </section>
      <NumberField
        label="Opacity"
        value={o.opacity}
        min={0}
        max={1}
        step={0.05}
        disabled={readOnly}
        onChange={(opacity) => set((x) => ({ ...x, opacity }))}
      />
      {o.type === 'text' && (
        <fieldset disabled={readOnly} style={SECTION}>
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
        </fieldset>
      )}
      {o.type === 'image' && (
        <fieldset className="col" disabled={readOnly} style={SECTION}>
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
            disabled={readOnly}
            onChange={(fit) => set((x) => ({ ...x, fit }) as SlideObject)}
          />
          {!masked && (
            <NumberField
              label="Corner radius"
              value={o.radius}
              min={0}
              disabled={readOnly}
              onChange={(radius) => set((x) => ({ ...x, radius }) as SlideObject)}
            />
          )}
          <CropControl o={o} readOnly={readOnly} />
          {picking && !readOnly && (
            <MediaPickerDialog
              title={o.play ? 'Choose a poster image' : 'Choose an image'}
              kinds={['image']}
              needsSize={o.fit !== 'contain' && o.fit !== 'cover'}
              onClose={() => setPicking(false)}
              onPick={(m) => {
                // Re-cropped to the box, never distorted; the mask, flips and the rest stay (design/27 §11).
                if (!readOnly) replacePictureWith(o.id, m);
                setPicking(false);
              }}
            />
          )}
        </fieldset>
      )}
      {o.type === 'image' && slide && (
        <VideoPanel o={o} slide={slide} media={(id) => media.find((m) => m.id === id)} readOnly={readOnly} />
      )}
      <ObjectSlideOps o={o} readOnly={readOnly} />
      {o.type === 'shape' && (
        <fieldset className="col" disabled={readOnly} style={SECTION}>
          <h4>Shape</h4>
          <ShapeGeometryField o={o} disabled={readOnly} set={set} />
          {o.shape !== 'line' && <ShapeFillFields o={o} disabled={readOnly} set={set} />}
          <Check
            label="Stroke"
            value={!!o.stroke}
            disabled={readOnly}
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
                disabled={readOnly}
                onChange={(width) => set((x) => ({ ...x, stroke: { ...o.stroke!, width } }) as SlideObject)}
                suffix="px"
                width={60}
              />
              <ColorField
                value={o.stroke.color}
                disabled={readOnly}
                onChange={(color) => set((x) => ({ ...x, stroke: { ...o.stroke!, color } }) as SlideObject)}
              />
            </div>
          )}
          {o.stroke && <ShapeLineFields o={o} disabled={readOnly} set={set} />}
          <ShapeShadowField o={o} disabled={readOnly} set={set} />
          {o.shape === 'rect' && !o.geom && (
            <NumberField
              label="Corner radius"
              value={o.radius}
              min={0}
              disabled={readOnly}
              onChange={(radius) => set((x) => ({ ...x, radius }) as SlideObject)}
            />
          )}
        </fieldset>
      )}
    </div>
  );
}

/**
 * A panel section as a fieldset, so a locked object (or the live lock) disables every field in it at once;
 * drawn as `.props section` is.
 */
const SECTION = {
  border: 0,
  borderBottom: '1px solid var(--line)',
  margin: 0,
  padding: '8px 0 12px',
  minWidth: 0,
} as const;

/** A selection kept inside the text (the text can shrink under it: undo, another editor's change). */
function clampRange(r: TextRange, len: number): TextRange {
  const start = Math.max(0, Math.min(len, r.start));
  return { start, end: Math.max(start, Math.min(len, r.end)) };
}

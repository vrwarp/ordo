import { type Box, nearColor, type SlideObject, type TextStyle } from '@ordo/domain';
import { useState } from 'react';
import { ColorPill } from '../../components/ColorPicker.tsx';
import { NumberField, Select } from '../../components/fields.tsx';
import { TextStyleEditor } from '../../components/TextStyleEditor.tsx';
import { ObjectSlideOps } from './ObjectSlideOps.tsx';
import { useLibrary } from '../../state/library.ts';
import {
  copyTextSelection,
  cutTextSelection,
  handleTextPaste,
  refit,
  replacePictureWith,
  typeText,
} from './actions.ts';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import { CropControl } from './CropControl.tsx';
import { change, redo, setTextRange, stopInlineEditing, undo, useEditor } from './editorStore.ts';
import { historyKey } from './editorKeys.ts';
import { restoreFieldSelection } from './fieldSelection.ts';
import { GroupNote, LockedNote, SelectionBox } from './GroupPanel.tsx';
import { VideoPanel } from './MediaPanels.tsx';
import {
  ShapeFillFields,
  ShapeGeometryField,
  ShapeLineFields,
  ShapeShadowField,
  shapeName,
} from './ObjectShapeFields.tsx';
import {
  OBJECT_SECTION_ORDER,
  type ObjectSection,
  type ObjectSectionContext,
  objectSectionsFor,
} from './objectSections.ts';
import { getSlide, markOverride, updateObject, updateSlide } from './ops.ts';
import { isLocked } from './ops/group.ts';
import type { TextRange } from './ops/text.ts';
import { ParagraphStrip } from './ParagraphStrip.tsx';
import { fitMessage } from './textFit.ts';
import { UnifiedTypography } from './UnifiedTypography.tsx';

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

/**
 * Property panel for the selected object: every TextStyle, ImageObject and ShapeObject field (prd/03), as
 * sections (objectSections.ts): the built-in ones below, then those M9's editor tracks add, by order.
 */
export function ObjectPanel({ o, readOnly: liveLocked }: { o: SlideObject; readOnly: boolean }) {
  // A locked object (PowerPoint art, SmartArt, table grids): its box only; every other field is read-only
  // (design/27 §11 "Locked objects"). `readOnly` below covers both.
  const locked = isLocked(o);
  const readOnly = liveLocked || locked;
  const slideId = useEditor((s) => s.slideId)!;
  const draft = useEditor((s) => s.draft)!;
  const slide = getSlide(draft, slideId);
  const isSong = draft?.kind === 'song';
  const isLyric =
    isSong &&
    (slide?.lyricObjectId === o.id ||
      (!slide?.lyricObjectId && slide?.objects.find((x) => x.type === 'text')?.id === o.id));
  const themed = isLyric && !!draft?.themeId;
  const set = (fn: (x: SlideObject) => SlideObject, key?: string, overridePath?: string) => {
    if (liveLocked || (locked && overridePath !== 'box')) return;
    change((p) => {
      let q = updateObject(p, slideId, o.id, fn);
      if (themed && overridePath) q = updateSlide(q, slideId, (s) => markOverride(s, overridePath));
      return q;
    }, key);
  };
  const marks = new Set(slide?.overrides ?? []);
  const ctx: ObjectSectionContext = {
    o,
    readOnly,
    liveLocked,
    locked,
    slideId,
    slide,
    draft,
    isLyric,
    themed,
    marks,
    set,
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      {objectSectionsFor(o, BUILTIN_SECTIONS).map((s) => (
        <s.Component key={s.id} {...ctx} />
      ))}
    </div>
  );
}

/** The title row: what the object is, and 'Make lyric box' for another text box of a song. */
function HeadingSection({ o, readOnly, isLyric, slideId, draft }: ObjectSectionContext) {
  const isSong = draft?.kind === 'song';
  return (
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
      {o.type === 'text' && isSong && !isLyric && (
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
  );
}

/** Whether the object is locked, and the group it belongs to. */
function NotesSection({ o, liveLocked }: ObjectSectionContext) {
  return (
    <>
      <LockedNote o={o} />
      <GroupNote o={o} readOnly={liveLocked} />
    </>
  );
}

/**
 * A text object's text: its typography (UnifiedTypography: the whole box, or the selected characters), the
 * text field (its selection shared with the canvas's inline editor, `textRange`) and the paragraph strip under
 * 'Lists, indents & paragraph spacing' (M4 item C).
 */
function TextSection({ o: obj, readOnly, themed, marks, set }: ObjectSectionContext) {
  const o = obj as Extract<SlideObject, { type: 'text' }>;
  const looks = useLibrary((s) => s.data.settings.looks);
  // The text field's selection, for the format bar, paragraph strip, and canvas inline overlay (M4 item C).
  const range = useEditor((s) => s.textRange);
  const setRange = setTextRange;
  const keyLooks = looks.filter(
    (l) => l.kind === 'stream' || (l.clearColor.g > 200 && l.clearColor.r < 60 && l.clearColor.b < 60),
  );
  const keyClash = keyLooks.some((l) => nearColor(o.style.color, l.clearColor));
  return (
    <>
      <UnifiedTypography
        o={o}
        range={clampRange(range, o.text.length)}
        readOnly={readOnly}
        marks={themed ? (marks as Set<string>) : undefined}
        onChangeStyle={(style: TextStyle, key) =>
          set((x) => ({ ...x, style }) as SlideObject, `style:${o.id}:${String(key)}`, `style.${String(key)}`)
        }
      />
      <div className="col" style={{ gap: 4 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="muted small">Text content</span>
          <span className="muted small" style={{ fontSize: 11 }}>
            Double-click slide to edit inline
          </span>
        </div>
        <textarea
          rows={2}
          value={o.text}
          disabled={readOnly}
          id="ordo-text-editor"
          aria-label="Text"
          onSelect={(e) => {
            const el = e.currentTarget;
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const caret = el.selectionDirection === 'backward' ? start : end;
            setRange({ start, end, caret });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && useEditor.getState().inlineEditingId) {
              e.preventDefault();
              stopInlineEditing();
              e.currentTarget.blur();
              return;
            }
            const step = historyKey(e);
            if (!step) return;
            e.preventDefault();
            e.stopPropagation();
            if (readOnly) return;
            const el = e.currentTarget;
            const at = { start: el.selectionStart, end: el.selectionEnd };
            (step === 'undo' ? undo : redo)();
            // At once, not a frame later over a newer selection (`restoreFieldSelection`).
            const r = restoreFieldSelection(at);
            if (r) setRange(r);
          }}
          onChange={(e) => {
            const next = e.target.value;
            const caret = e.target.selectionEnd;
            setRange({ start: e.target.selectionStart, end: caret, caret });
            if (!readOnly) typeText(o.id, next, caret);
          }}
          onCopy={(e) => {
            const el = e.currentTarget;
            if (copyTextSelection(o, el.selectionStart, el.selectionEnd, e.clipboardData)) {
              e.preventDefault();
            }
          }}
          onCut={(e) => {
            if (readOnly) return;
            const el = e.currentTarget;
            const caret = cutTextSelection(o, el.selectionStart, el.selectionEnd, e.clipboardData);
            if (caret !== null) {
              e.preventDefault();
              setRange({ start: caret, end: caret, caret });
              restoreFieldSelection({ start: caret, end: caret });
            }
          }}
          onPaste={(e) => {
            if (readOnly) return;
            const el = e.currentTarget;
            const caret = handleTextPaste(o, el.selectionStart, el.selectionEnd, e.clipboardData);
            if (caret !== null) {
              e.preventDefault();
              setRange({ start: caret, end: caret, caret });
              restoreFieldSelection({ start: caret, end: caret });
            }
          }}
        />
      </div>
      {keyClash && (
        <div className="banner small">
          This text colour is close to a look's key colour; it may be keyed out on the stream.
        </div>
      )}
      <details
        className="ed-collapsible"
        open={
          !!o.paras?.some(
            (p) => p && (p.bullet || p.indentPx || p.level || p.spaceBeforePx || p.spaceAfterPx),
          )
        }
      >
        <summary>Lists, indents &amp; paragraph spacing</summary>
        <div style={{ paddingTop: 8 }}>
          <ParagraphStrip o={o} range={clampRange(range, o.text.length)} readOnly={readOnly} />
        </div>
      </details>
    </>
  );
}

/** A text object's screen placement presets (`PLACEMENT_PRESETS`). */
function PlacementSection({ o, readOnly, set }: ObjectSectionContext) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <span
        className="small bold"
        style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
      >
        Screen placement
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
              <span style={{ fontSize: 12, fontWeight: 600, color: active ? 'var(--accent)' : 'var(--fg)' }}>
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
  );
}

/** The box and the align bar, editable on a locked object (not under the live lock). */
function BoxSection({ o, liveLocked, marks, set }: ObjectSectionContext) {
  return (
    <section>
      <h4>
        Position and size{marks.has('box') && <span className="override-mark"> ● overrides theme</span>}
      </h4>
      <div className="ed-align-bar" role="group" aria-label="Align to slide">
        {(
          [
            ['left', 'Align left', '⇤', (b: typeof o.box) => ({ ...b, x: 0 })],
            [
              'cx',
              'Center horizontally',
              '⇹',
              (b: typeof o.box) => ({ ...b, x: Math.round((1920 - b.w) / 2) }),
            ],
            ['right', 'Align right', '⇥', (b: typeof o.box) => ({ ...b, x: 1920 - b.w })],
            ['top', 'Align top', '⤒', (b: typeof o.box) => ({ ...b, y: 0 })],
            [
              'cy',
              'Center vertically',
              '⇳',
              (b: typeof o.box) => ({ ...b, y: Math.round((1080 - b.h) / 2) }),
            ],
            ['bottom', 'Align bottom', '⤓', (b: typeof o.box) => ({ ...b, y: 1080 - b.h })],
          ] as const
        ).map(([k, title, icon, fn]) => (
          <button
            key={k}
            type="button"
            className="small"
            disabled={liveLocked}
            title={title}
            aria-label={title}
            onClick={() => set((x) => ({ ...x, box: fn(x.box) }), undefined, 'box')}
          >
            {icon}
          </button>
        ))}
      </div>
      <SelectionBox
        o={o}
        readOnly={liveLocked}
        onChange={(box) => set((x) => ({ ...x, box }), undefined, 'box')}
      />
    </section>
  );
}

function OpacitySection({ o, readOnly, set }: ObjectSectionContext) {
  return (
    <NumberField
      label="Opacity"
      value={Math.round(o.opacity * 100)}
      min={0}
      max={100}
      step={5}
      suffix="%"
      width={76}
      disabled={readOnly}
      onChange={(pct) => set((x) => ({ ...x, opacity: Math.max(0, Math.min(1, pct / 100)) }))}
    />
  );
}

/** A text object's readability and box fine-tuning, with the theme's override marks on a themed lyric box. */
function TextStyleSection({ o: obj, readOnly, themed, marks, set }: ObjectSectionContext) {
  const o = obj as Extract<SlideObject, { type: 'text' }>;
  return (
    <fieldset disabled={readOnly} style={SECTION}>
      <h4>Readability &amp; text box</h4>
      <div role="status">
        {fitMessage(o) && (
          <div className="banner small" style={{ marginBottom: 8 }}>
            {fitMessage(o)}
          </div>
        )}
      </div>
      <TextStyleEditor
        value={o.style}
        mode="fineTune"
        box
        onRefit={readOnly ? undefined : () => refit(o.id)}
        marks={themed ? (marks as Set<string>) : undefined}
        onChange={(style: TextStyle, key) =>
          set((x) => ({ ...x, style }) as SlideObject, `style:${o.id}:${String(key)}`, `style.${String(key)}`)
        }
      />
    </fieldset>
  );
}

/** A picture: its media, fit, corner radius and crop, and 'Replace'. */
function PictureSection({ o: obj, readOnly, set }: ObjectSectionContext) {
  const o = obj as Extract<SlideObject, { type: 'image' }>;
  const media = useLibrary((s) => s.data.media);
  const [picking, setPicking] = useState(false);
  // A picture cut to a geometry (design/27 §3.1 `ImageObject.mask`: a preset, freeform paths or a geometry
  // file) ignores its corner radius, which stays only for an older build.
  const masked = !!(o.mask?.preset || o.mask?.paths?.length || o.mask?.ref);
  return (
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
  );
}

/** A picture's video, on a slide (MediaPanels.tsx). */
function VideoSection({ o, slide, readOnly }: ObjectSectionContext) {
  const media = useLibrary((s) => s.data.media);
  if (!slide || o.type !== 'image') return null;
  return (
    <VideoPanel o={o} slide={slide} media={(id) => media.find((m) => m.id === id)} readOnly={readOnly} />
  );
}

function SlideOpsSection({ o, readOnly }: ObjectSectionContext) {
  return <ObjectSlideOps o={o} readOnly={readOnly} />;
}

/** A shape: its geometry, fill, outline, line style, shadow and corner radius (ObjectShapeFields.tsx). */
function ShapeSection({ o: obj, readOnly, set }: ObjectSectionContext) {
  const o = obj as Extract<SlideObject, { type: 'shape' }>;
  return (
    <fieldset className="col" disabled={readOnly} style={{ ...SECTION, gap: 10 }}>
      <h4>Shape</h4>
      <ShapeGeometryField o={o} disabled={readOnly} set={set} />
      {o.shape !== 'line' && <ShapeFillFields o={o} disabled={readOnly} set={set} />}
      <div className="prop-line" data-has-stroke={!!o.stroke}>
        <span className="prop-line-label">Stroke</span>
        {o.stroke ? (
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            <ColorPill
              value={o.stroke.color}
              disabled={readOnly}
              compact
              ariaLabel="Stroke color"
              onChange={(color) => set((x) => ({ ...x, stroke: { ...o.stroke!, color } }) as SlideObject)}
            />
            <NumberField
              value={o.stroke.width}
              min={0}
              disabled={readOnly}
              onChange={(width) => set((x) => ({ ...x, stroke: { ...o.stroke!, width } }) as SlideObject)}
              suffix="px"
              width={54}
            />
            <button
              type="button"
              className="small prop-toggle-btn"
              aria-label="Remove stroke"
              title="Remove stroke"
              disabled={readOnly}
              onClick={() => set((x) => ({ ...x, stroke: undefined }) as SlideObject)}
            >
              −
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="small prop-toggle-btn"
            aria-label="Add stroke"
            title="Add stroke"
            disabled={readOnly}
            onClick={() =>
              set(
                (x) =>
                  ({
                    ...x,
                    stroke: { width: 4, color: { r: 255, g: 255, b: 255, a: 1 } },
                  }) as SlideObject,
              )
            }
          >
            +
          </button>
        )}
      </div>
      {o.stroke && <ShapeLineFields o={o} disabled={readOnly} set={set} />}
      <ShapeShadowField o={o} disabled={readOnly} set={set} />
      {o.shape === 'rect' && !o.geom && (
        <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
          <input
            type="range"
            aria-label="Corner radius slider"
            min={0}
            max={200}
            value={Math.min(200, o.radius)}
            disabled={readOnly}
            style={{ flex: 1, minHeight: 28 }}
            onChange={(e) => set((x) => ({ ...x, radius: Number(e.target.value) }) as SlideObject)}
          />
          <NumberField
            label="Corner radius"
            value={o.radius}
            min={0}
            width={76}
            disabled={readOnly}
            onChange={(radius) => set((x) => ({ ...x, radius }) as SlideObject)}
          />
        </div>
      )}
    </fieldset>
  );
}

const any = () => true;
const isText = (o: SlideObject) => o.type === 'text';
const isImage = (o: SlideObject) => o.type === 'image';
const isShape = (o: SlideObject) => o.type === 'shape';
const O = OBJECT_SECTION_ORDER;

/** The panel's own sections, in today's order; M9's are added by objectSections.ts. */
export const BUILTIN_SECTIONS: readonly ObjectSection[] = [
  { id: 'heading', order: O.heading, applies: any, Component: HeadingSection },
  { id: 'notes', order: O.notes, applies: any, Component: NotesSection },
  { id: 'text', order: O.text, applies: isText, Component: TextSection },
  { id: 'placement', order: O.placement, applies: isText, Component: PlacementSection },
  { id: 'box', order: O.box, applies: any, Component: BoxSection },
  { id: 'opacity', order: O.opacity, applies: any, Component: OpacitySection },
  { id: 'textStyle', order: O.textStyle, applies: isText, Component: TextStyleSection },
  { id: 'picture', order: O.picture, applies: isImage, Component: PictureSection },
  { id: 'video', order: O.video, applies: isImage, Component: VideoSection },
  { id: 'slideOps', order: O.slideOps, applies: any, Component: SlideOpsSection },
  { id: 'shape', order: O.shape, applies: isShape, Component: ShapeSection },
];

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

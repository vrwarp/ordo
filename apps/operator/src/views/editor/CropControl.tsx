import { fileUrl } from '@ordo/client';
import type { ImageCrop, ImageObject, Media, SlideObject } from '@ordo/domain';
import type Konva from 'konva';
import { useEffect, useId, useRef, useState } from 'react';
import { Group, Rect, Shape } from 'react-konva';
import { create } from 'zustand';
import { NumberField } from '../../components/fields.tsx';
import { useCoarsePointer } from '../../components/pointer.ts';
import { stillHash } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import { cropPicture, flipPicture, maskPicture } from './actions.ts';
import {
  cropForFrame,
  dragFrame,
  HANDLES,
  type Handle,
  handlePoint,
  isDistorted,
  mirrorFrame,
  pictureFrame,
  type Rect as Frame,
  type Side,
  sideMax,
  visualCrop,
  withVisualSide,
} from './cropGeometry.ts';
import { useEditor } from './editorStore.ts';
import { coverCrop, type PictureFlip, type PictureMask, ROUND_ADJ_MAX, roundCorner } from './ops/pictures.ts';

/**
 * Cropping a picture (design/27 §11 item 6; M4 item D): numeric first, then handles on the canvas.
 *
 * `CropControl` (Object panel, image section): the four crop shares as percentages (Left, Top, Right,
 * Bottom, the sides as seen on the slide; negative pads transparent), 'Reset crop', and 'Crop on the slide',
 * which turns the canvas handles on (`useCropMode`); also the mask (None, Ellipse, Rounded with its corner
 * size) and Flip horizontal / vertical. A picture stretched out of its proportions offers 'Keep proportions'
 * (a cover crop to its box, centred where it is). Each applies `cropPicture`, `maskPicture`, `flipPicture`
 * (actions.ts), one undo step (the crop fields coalesce per object).
 *
 * `CropHandles` (slide canvas, mounted by `SlideCanvas` over the objects): while `useCropMode` names the
 * selected picture, the whole picture is drawn faintly around its box; dragging it moves the picture behind
 * the box, and eight handles scale it at its own aspect, while the box stays (`cropPicture`, coalesced per
 * drag; `cropGeometry.ts`); the arrow keys move it by 1 px (Shift: 10). Enter or Escape, or a click
 * elsewhere (another object, the slide), ends it.
 *
 * Accessibility (design/15): labelled number fields with units, the mask as a radio group, flips as toggle
 * buttons with `aria-pressed`; every handle drag has its numeric field, so the keyboard and a screen reader
 * can do everything. 30 px handles under a finger.
 */
export function CropControl(props: { o: ImageObject; readOnly: boolean }) {
  const { o } = props;
  const media = useLibrary((s) => s.data.media.find((m) => m.id === o.mediaId));
  const cropping = useCropMode((s) => s.objectId === o.id);
  return (
    <CropControlView
      o={o}
      readOnly={props.readOnly}
      size={media}
      cropping={cropping}
      onCrop={(crop) => cropPicture(o.id, crop)}
      onMask={(mask) => maskPicture(o.id, mask)}
      onFlip={(flip) => flipPicture(o.id, flip)}
      onCropMode={(on) => (on ? startCrop(o.id) : endCrop())}
    />
  );
}

const SIDES: { side: Side; label: string }[] = [
  { side: 'left', label: 'Left' },
  { side: 'right', label: 'Right' },
  { side: 'top', label: 'Top' },
  { side: 'bottom', label: 'Bottom' },
];

type MaskChoice = 'none' | 'ellipse' | 'roundRect';
const MASKS: { value: MaskChoice; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'roundRect', label: 'Rounded' },
];

const FIELDSET = { gap: 6, border: 0, margin: 0, padding: 0 } as const;
const LEGEND = { padding: 0, marginBottom: 4, color: 'var(--fg2)' } as const;

/** A share as a percentage with one decimal. */
const pct = (v: number) => Math.round(v * 1000) / 10;

/** The crop, mask and flip controls of a picture, from props only (the store-bound wrapper is `CropControl`). */
export function CropControlView(props: {
  o: ImageObject;
  readOnly: boolean;
  /** The picture's pixel size, when known: 'Keep proportions' needs it. */
  size?: Pick<Media, 'width' | 'height'>;
  /** The canvas crop handles are on for this picture. */
  cropping: boolean;
  onCrop: (crop: ImageCrop | undefined) => void;
  onMask: (mask: PictureMask | undefined) => void;
  onFlip: (flip: PictureFlip) => void;
  onCropMode: (on: boolean) => void;
}) {
  const { o, size } = props;
  const off = props.readOnly || !!o.locked;
  const name = useId();
  const seen = visualCrop(o);
  const preset = o.mask?.preset;
  // Another geometry (a PowerPoint preset, freeform paths or a geometry file, M6) checks no choice: any of
  // them replaces it.
  const mask: MaskChoice | undefined = !(preset || o.mask?.paths?.length || o.mask?.ref)
    ? 'none'
    : preset === 'ellipse' || preset === 'roundRect'
      ? preset
      : undefined;
  const corner = roundCorner(o);
  const proportions = size?.width && size.height ? coverCrop(o, size) : undefined;
  return (
    <div className="col" style={{ gap: 10 }} data-crop-control>
      <fieldset className="col" style={FIELDSET}>
        <legend className="small" style={LEGEND}>
          Crop
        </legend>
        <div className="grid2">
          {SIDES.map(({ side, label }) => (
            <NumberField
              key={side}
              label={label}
              value={pct(seen[side])}
              min={-100}
              max={Math.floor(sideMax(o, side) * 1000) / 10}
              step={1}
              suffix="%"
              width={70}
              disabled={off}
              onChange={(v) => props.onCrop(withVisualSide(o, side, v / 100))}
            />
          ))}
        </div>
        <span className="muted small">
          How much is cut from each side, as seen on the slide. A negative share leaves that side empty.
        </span>
        <div className="row wrap">
          <button
            type="button"
            className="small"
            disabled={off || !o.crop}
            onClick={() => props.onCrop(undefined)}
          >
            Reset crop
          </button>
          <button
            type="button"
            className={props.cropping ? 'small on' : 'small'}
            aria-pressed={props.cropping}
            disabled={off}
            onClick={() => props.onCropMode(!props.cropping)}
          >
            Crop on the slide
          </button>
        </div>
        {props.cropping && (
          <span className="muted small" role="status">
            Drag the picture (or use the arrow keys) to move it in its box, or a handle to make it larger or
            smaller. Enter or Escape ends.
          </span>
        )}
        {size && isDistorted(o, size) && (
          <div className="banner small col" style={{ gap: 6 }}>
            <span>The picture is stretched out of its proportions to fill its box.</span>
            <button type="button" className="small" disabled={off} onClick={() => props.onCrop(proportions)}>
              Keep proportions
            </button>
          </div>
        )}
      </fieldset>
      <fieldset className="col" style={FIELDSET}>
        <legend className="small" style={LEGEND}>
          Mask
        </legend>
        <div className="row wrap" role="radiogroup" aria-label="Mask">
          {MASKS.map((m) => (
            <label key={m.value} className="check">
              <input
                type="radio"
                name={`${name}-mask`}
                value={m.value}
                checked={mask === m.value}
                disabled={off}
                onChange={() => props.onMask(m.value === 'none' ? undefined : { preset: m.value })}
              />
              <span>{m.label}</span>
            </label>
          ))}
        </div>
        {corner !== undefined && (
          <NumberField
            label="Corner size"
            value={pct(corner / 100_000)}
            min={0}
            max={(ROUND_ADJ_MAX / 100_000) * 100}
            step={1}
            suffix="% of the shorter side"
            width={70}
            disabled={off}
            onChange={(v) => props.onMask({ preset: 'roundRect', adj: [['adj', v * 1000]] })}
          />
        )}
      </fieldset>
      <div className="row wrap" role="group" aria-label="Flip">
        <button
          type="button"
          className={o.flipH ? 'small on' : 'small'}
          aria-pressed={!!o.flipH}
          disabled={off}
          onClick={() => props.onFlip({ flipH: !o.flipH })}
        >
          Flip horizontal
        </button>
        <button
          type="button"
          className={o.flipV ? 'small on' : 'small'}
          aria-pressed={!!o.flipV}
          disabled={off}
          onClick={() => props.onFlip({ flipV: !o.flipV })}
        >
          Flip vertical
        </button>
      </div>
    </div>
  );
}

/** Which picture the canvas crop handles are on (one at a time; none by default). */
export const useCropMode = create<{ objectId?: string }>(() => ({}));

/** Turn the canvas crop handles on for a picture. */
export function startCrop(objectId: string): void {
  useCropMode.setState({ objectId });
}

/** Turn the canvas crop handles off. */
export function endCrop(): void {
  if (useCropMode.getState().objectId !== undefined) useCropMode.setState({ objectId: undefined });
}

type KeyTarget = { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null;

/** Whether a key event comes from a field, which uses the arrows itself. */
function isField(t: EventTarget | null): boolean {
  const el = t as KeyTarget;
  return !!el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '');
}

/** Whether a key event comes from a control that uses Enter itself (a field, a button, a link). */
function ownsEnter(t: EventTarget | null): boolean {
  return isField(t) || /^(BUTTON|A)$/.test((t as KeyTarget)?.tagName ?? '');
}

/** The arrow keys' moves of the picture behind its box (logical px; Shift: 10). */
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The canvas crop handles for the picture `useCropMode` names, inside the canvas's scaled object layer
 * (`objects` are the ones the canvas draws; `scale` is screen px per logical px). They stay only while that
 * picture is on the slide, selected, editable and unlocked.
 */
export function CropHandles(props: { objects: readonly SlideObject[]; scale: number; readOnly: boolean }) {
  const id = useCropMode((s) => s.objectId);
  const selected = useEditor((s) => s.objectId);
  const o = props.objects.find((x): x is ImageObject => x.id === id && x.type === 'image');
  const active = !!o && !props.readOnly && !o.locked && selected === id;
  useEffect(() => {
    if (id !== undefined && !active) endCrop();
  }, [id, active]);
  if (!active || !o) return null;
  return <CropFrame o={o} scale={props.scale} />;
}

// ---- the picture behind the box -------------------------------------------------------------------------

const pictures = new Map<string, HTMLImageElement>();
const pictureListeners = new Set<() => void>();

/** The picture of a file, decoded once; undefined until it has loaded. */
function usePicture(hash: string | undefined): HTMLImageElement | undefined {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    pictureListeners.add(fn);
    return () => {
      pictureListeners.delete(fn);
    };
  }, []);
  if (!hash) return undefined;
  let img = pictures.get(hash);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      for (const l of pictureListeners) l();
    };
    img.src = fileUrl(hash);
    pictures.set(hash, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : undefined;
}

/** Handles on screen: 12 px with a mouse, 30 px under a finger (design/15). */
const HANDLE_PX = 12;
const TOUCH_HANDLE_PX = 30;

function CropFrame({ o, scale }: { o: ImageObject; scale: number }) {
  const media = useLibrary((s) => s.data.media.find((m) => m.id === o.mediaId));
  const img = usePicture(stillHash(media));
  const coarse = useCoarsePointer();
  const group = useRef<Konva.Group>(null);
  /** The frame (as seen) when the current drag started: handles scale about it. */
  const start = useRef<Frame | null>(null);
  /** Where the dragged area was when the drag started (a move goes by the distance from there). */
  const grab = useRef<{ x: number; y: number } | null>(null);
  // The selection's Transformer would sit on the box's edges, over the handles: hidden while cropping.
  useEffect(() => {
    const layer = group.current?.getLayer();
    const shown = (layer?.find('Transformer') ?? []).filter((t) => t.visible());
    for (const t of shown) t.visible(false);
    layer?.batchDraw();
    return () => {
      for (const t of shown) t.visible(true);
      layer?.batchDraw();
    };
  }, []);
  const size = img
    ? { width: img.naturalWidth, height: img.naturalHeight }
    : media?.width && media.height
      ? { width: media.width, height: media.height }
      : undefined;
  const b = o.box;
  const w = Math.abs(b.w);
  const h = Math.abs(b.h);
  const whole = pictureFrame(o, size);
  const seen = mirrorFrame(o, whole);
  const apply = (next: Frame): boolean => {
    const r = cropForFrame(o, mirrorFrame(o, next));
    if (r) cropPicture(o.id, r.crop);
    return !!r;
  };
  // The keys while cropping, before the editor's own (which would move the box or drop the selection):
  // Enter or Escape ends crop mode, the arrows move the picture behind the box. A dialog keeps its keys.
  const keys = useRef({ seen, apply });
  keys.current = { seen, apply };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as KeyTarget)?.closest?.('[role="dialog"]')) return;
      const end = e.key === 'Escape' || (e.key === 'Enter' && !ownsEnter(e.target));
      const d = ARROWS[e.key];
      const move = d && !isField(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!end && !move) return;
      e.preventDefault();
      e.stopPropagation();
      if (end) {
        endCrop();
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const { seen: f, apply: go } = keys.current;
      go({ ...f, x: f.x + d![0] * step, y: f.y + d![1] * step });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const hs = (coarse ? TOUCH_HANDLE_PX : HANDLE_PX) / scale;
  const line = 1.5 / scale;
  return (
    <Group
      ref={group}
      name="crop-handles"
      x={b.x + b.w / 2}
      y={b.y + b.h / 2}
      offsetX={b.w / 2}
      offsetY={b.h / 2}
      rotation={b.rotation ?? 0}
    >
      <Shape
        listening={false}
        sceneFunc={(context) => {
          const ctx = context._context as CanvasRenderingContext2D;
          ctx.save();
          // The whole picture, faint, where it lies outside the box.
          ctx.beginPath();
          ctx.rect(seen.x, seen.y, seen.w, seen.h);
          ctx.rect(0, 0, w, h);
          ctx.clip('evenodd');
          ctx.globalAlpha = 0.45;
          if (img) {
            ctx.translate(w / 2, h / 2);
            ctx.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
            ctx.translate(-w / 2, -h / 2);
            ctx.drawImage(img, whole.x, whole.y, whole.w, whole.h);
          } else {
            ctx.fillStyle = '#888';
            ctx.fillRect(seen.x, seen.y, seen.w, seen.h);
          }
          ctx.restore();
          ctx.save();
          ctx.lineWidth = line;
          ctx.setLineDash([6 / scale, 4 / scale]);
          ctx.strokeStyle = '#3b82f6';
          ctx.strokeRect(seen.x, seen.y, seen.w, seen.h);
          ctx.setLineDash([]);
          ctx.strokeStyle = '#fff';
          ctx.strokeRect(0, 0, w, h);
          ctx.restore();
        }}
      />
      {/* Dragging the picture, or the box where the picture does not reach, moves the picture. */}
      {[
        { name: 'crop-box', at: { x: 0, y: 0, w, h } },
        { name: 'crop-move', at: seen },
      ].map((area) => (
        <Rect
          key={area.name}
          name={area.name}
          x={area.at.x}
          y={area.at.y}
          width={area.at.w}
          height={area.at.h}
          fill="rgba(0,0,0,0)"
          draggable
          onDragStart={(e) => {
            start.current = seen;
            grab.current = e.target.position();
          }}
          onDragMove={(e) => {
            const n = e.target;
            const from = start.current ?? seen;
            const at = grab.current ?? n.position();
            apply({ ...from, x: from.x + n.x() - at.x, y: from.y + n.y() - at.y });
          }}
          onDragEnd={(e) => {
            start.current = null;
            grab.current = null;
            e.target.position({ x: area.at.x, y: area.at.y });
          }}
        />
      ))}
      {HANDLES.map((handle: Handle) => {
        const p = handlePoint(seen, handle);
        return (
          <Rect
            key={handle}
            name={`crop-${handle}`}
            x={p.x}
            y={p.y}
            width={hs}
            height={hs}
            offsetX={hs / 2}
            offsetY={hs / 2}
            fill="#fff"
            stroke="#3b82f6"
            strokeWidth={line}
            hitStrokeWidth={coarse ? 18 / scale : 6 / scale}
            draggable
            onDragStart={() => {
              start.current = seen;
            }}
            onDragMove={(e) => {
              const n = e.target;
              apply(dragFrame(start.current ?? seen, handle, { x: n.x(), y: n.y() }));
            }}
            onDragEnd={(e) => {
              start.current = null;
              e.target.position(p);
            }}
          />
        );
      })}
    </Group>
  );
}

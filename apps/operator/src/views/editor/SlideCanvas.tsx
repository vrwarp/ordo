import { fileUrl } from '@ordo/client';
import {
  type Box,
  GEOM_FILE_MAX_BYTES,
  isGeomFileRef,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Media,
  type Slide,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';
import {
  drawImageFit,
  drawObject,
  drawTextObject,
  geomPending,
  isRichText,
  readGeomFiles,
  slideBudget,
} from '@ordo/renderer';
import type Konva from 'konva';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Layer, Line, Rect, Shape, Stage, Transformer } from 'react-konva';
import { useCoarsePointer } from '../../components/pointer.ts';
import { onFontsChanged } from '../../services/fonts.ts';
import { stillHash } from '../../services/thumbs.ts';
import { CanvasGuides, type SlideRect } from './CanvasGuides.tsx';
import { canvasContent } from './canvasContent.ts';
import { CropHandles } from './CropControl.tsx';
import { change, selectObject, selectObjects, useEditor } from './editorStore.ts';
import { dragSelection, transformSelection } from './actions.ts';
import { updateObject } from './ops.ts';
import { boxFromCorner, clickSelection, groupBox, groupMembers, isLocked, keepsAspect } from './ops/group.ts';
import { useOriginalOver } from './original.ts';
import { snapBox } from './snapping.ts';
import { TEXT_MARGIN, textDensity, textRasterKey } from './textRaster.ts';
import { objectToolsSpot, rotaterAngle } from './touchGeometry.ts';

// ---- image cache (HTMLImageElement per file hash) ----
const images = new Map<string, HTMLImageElement>();
const imageListeners = new Set<() => void>();
function imageFor(hash: string | undefined): HTMLImageElement | undefined {
  if (!hash) return undefined;
  let img = images.get(hash);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      for (const l of imageListeners) l();
    };
    img.src = fileUrl(hash);
    images.set(hash, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : undefined;
}
/**
 * Read the geometry file a shape or a picture's mask names (`ShapeGeom.ref`) if it is not yet; the canvas
 * draws again once it is (the shape draws its fallback meanwhile).
 */
function readGeomOf(o: SlideObject): void {
  const g = o.type === 'shape' ? o.geom : o.type === 'image' ? o.mask : undefined;
  if (!g || !isGeomFileRef(g.ref) || !geomPending(g)) return;
  void readGeomFiles([g.ref], async (hash) => {
    const r = await fetch(fileUrl(hash), { credentials: 'same-origin' });
    if (!r.ok) return undefined;
    // A file larger than a geometry file can be is refused unread, as the workers refuse it (a ref can name
    // any file of the content store).
    if (Number(r.headers.get('content-length')) > GEOM_FILE_MAX_BYTES) {
      void r.body?.cancel();
      return null;
    }
    const b = await r.blob();
    return b.size > GEOM_FILE_MAX_BYTES ? null : b.text();
  }).then((left) => {
    if (!left.size) for (const l of imageListeners) l();
  });
}
function useImageTick(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const fn = () => setN((x) => x + 1);
    imageListeners.add(fn);
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', fn);
    // Canvas text resolves through the page's font resolver: redraw once its faces change.
    const offFonts = onFontsChanged(fn);
    return () => {
      imageListeners.delete(fn);
      fonts?.removeEventListener?.('loadingdone', fn);
      offFonts();
    };
  }, []);
  return n;
}

// ---- text raster cache: the shared rasterizer into an offscreen canvas (WYSIWYG with outputs) ----
const MARGIN = TEXT_MARGIN;
type TextRaster = { key: string; canvas: HTMLCanvasElement; density: number };
const textCache = new WeakMap<TextObject, TextRaster>();
/** A rich object as its raster draws it: unrotated (Konva rotates the node), memoised per stored object. */
const unrotated = new WeakMap<TextObject, TextObject>();
/**
 * `o` drawn into its cached canvas: rich objects through the rich engine at `screen` density (stage scale ×
 * devicePixelRatio), legacy ones through drawText at 1:1 exactly as before (design/27 §6, §7.4).
 *
 * A rich object is drawn as itself (or one unrotated copy kept per object) under a translation, never as a
 * new object per raster: the engine memoises its clamp and layout by object identity, so a new density (a
 * window resize, a zoom) only paints again, and never lays out again on the main thread.
 */
function textCanvas(o: TextObject, tick: number, screen: number): TextRaster {
  const density = textDensity(o, screen);
  const key = textRasterKey(o, tick, density);
  const hit = textCache.get(o);
  if (hit && hit.key === key) return hit;
  const c = hit?.canvas ?? document.createElement('canvas');
  c.width = Math.max(1, Math.ceil((o.box.w + 2 * MARGIN) * density));
  c.height = Math.max(1, Math.ceil((o.box.h + 2 * MARGIN) * density));
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  if (isRichText(o)) {
    let local = o.box.rotation ? unrotated.get(o) : o;
    if (!local) {
      local = { ...o, box: { ...o.box, rotation: 0 } };
      unrotated.set(o, local);
    }
    ctx.save();
    ctx.translate((MARGIN - o.box.x) * density, (MARGIN - o.box.y) * density);
    drawTextObject(ctx, local, density);
    ctx.restore();
  } else
    drawTextObject(
      ctx,
      { ...o, box: { x: MARGIN, y: MARGIN, w: o.box.w, h: o.box.h, rotation: 0 } },
      density,
    );
  const out = { key, canvas: c, density };
  textCache.set(o, out);
  return out;
}

/** A press this long (ms) on a group member under a finger selects that member alone (Alt-click by touch). */
const LONG_PRESS_MS = 500;
const CORNER_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const ALL_ANCHORS = [...CORNER_ANCHORS, 'top-center', 'middle-left', 'middle-right', 'bottom-center'];

/** Transformer anchors under a finger: 30 px on screen, with a hit area wider than the drawn circle. */
const TOUCH_ANCHOR = 30;
/** The rotate handle sits further out under a finger so it is not confused with the top-centre anchor. */
const TOUCH_ROTATE_OFFSET = 64;
function touchAnchor(anchor: Konva.Rect): void {
  anchor.hitStrokeWidth(18);
}

function local(box: Box): Box {
  return { x: 0, y: 0, w: box.w, h: box.h, rotation: 0 };
}

/** The ▶ badge of an object that plays a video in its box (design/27 §7.4), in its bottom-left corner. */
export function drawPlayBadge(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const r = Math.max(8, Math.min(40, Math.min(w, h) * 0.12));
  const cx = Math.min(r * 1.4, w / 2);
  const cy = Math.max(h - r * 1.4, h / 2);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.35, cy - r * 0.5);
  ctx.lineTo(cx + r * 0.55, cy);
  ctx.lineTo(cx - r * 0.35, cy + r * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The lock badge of a locked object (PowerPoint art, SmartArt, table grids: move, resize, delete and z-order
 * only; design/27 §7.4, §11), in its top-right corner, `size` slide px (a constant size on screen).
 */
export function drawLockBadge(ctx: CanvasRenderingContext2D, w: number, size: number): void {
  const s = size;
  const x = w - s * 1.15;
  const y = s * 0.15;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.fillRect(x, y, s, s);
  // The padlock: a shackle over a body.
  ctx.strokeStyle = '#fcd34d';
  ctx.fillStyle = '#fcd34d';
  ctx.lineWidth = s * 0.1;
  ctx.beginPath();
  ctx.arc(x + s / 2, y + s * 0.42, s * 0.18, Math.PI, 0);
  ctx.stroke();
  ctx.fillRect(x + s * 0.24, y + s * 0.42, s * 0.52, s * 0.38);
  ctx.restore();
}

/** The canvas's handlers for one object node: selection, drags and transforms of the whole selection. */
type NodeHandlers = {
  press: (o: SlideObject, e: Konva.KonvaEventObject<Event>, kind: 'pointer' | 'mouse' | 'tap') => void;
  pressMove: (e: Konva.KonvaEventObject<Event>) => void;
  pressEnd: () => void;
  dragStart: (o: SlideObject, e: Konva.KonvaEventObject<DragEvent>) => void;
  dragMove: (o: SlideObject, e: Konva.KonvaEventObject<DragEvent>, others: Box[]) => void;
  dragEnd: (o: SlideObject, e: Konva.KonvaEventObject<DragEvent>) => void;
  transformEnd: (o: SlideObject, e: Konva.KonvaEventObject<Event>) => void;
};

function ObjectNode(props: {
  o: SlideObject;
  media: (id: string) => Media | undefined;
  others: Box[];
  tick: number;
  /** Device px per logical px on screen: the stage scale × devicePixelRatio. */
  density: number;
  /** What the slide's drawing budget draws instead (`slideBudget`), as the outputs draw it. */
  drawAs?: SlideObject;
  readOnly: boolean;
  /** The lock badge's size in slide px (constant on screen). */
  badge: number;
  on: NodeHandlers;
  onEditText?: () => void;
  registerNode: (id: string, n: Konva.Shape | null) => void;
}) {
  const { o, tick, on } = props;
  const b = o.box;
  return (
    <Shape
      ref={(n) => props.registerNode(o.id, n)}
      x={b.x + b.w / 2}
      y={b.y + b.h / 2}
      width={b.w}
      height={b.h}
      offsetX={b.w / 2}
      offsetY={b.h / 2}
      rotation={b.rotation ?? 0}
      draggable={!props.readOnly}
      perfectDrawEnabled={false}
      sceneFunc={(context) => {
        const ctx = context._context as CanvasRenderingContext2D;
        readGeomOf(o);
        const d = props.drawAs ?? o;
        if (o.type === 'text') {
          const t = textCanvas(o, tick, props.density);
          ctx.drawImage(t.canvas, -MARGIN, -MARGIN, t.canvas.width / t.density, t.canvas.height / t.density);
        } else if (o.type === 'image') {
          const img = imageFor(stillHash(props.media(o.mediaId)));
          // Flips and the mask as every drawer applies them (design/27 §3.1); what the slide's drawing budget
          // draws instead when it is past the budget (`drawAs`).
          if (img)
            drawImageFit(
              ctx,
              img,
              local(b),
              1,
              o.fit,
              o.opacity,
              o.radius,
              o.crop,
              undefined,
              d.type === 'image' ? d : o,
            );
          else {
            ctx.fillStyle = '#333';
            ctx.fillRect(0, 0, b.w, b.h);
          }
          if (o.play) drawPlayBadge(ctx, b.w, b.h);
        } else drawObject(ctx, { ...d, box: local(b) }, 1);
        if (o.locked) drawLockBadge(ctx, b.w, Math.min(props.badge, Math.abs(b.w) / 2, Math.abs(b.h) / 2));
      }}
      hitFunc={(context, shape) => {
        context.beginPath();
        context.rect(0, 0, b.w, Math.max(b.h, 12));
        context.closePath();
        context.fillStrokeShape(shape);
      }}
      onMouseDown={(e) => on.press(o, e, 'mouse')}
      onPointerDown={(e) => on.press(o, e, 'pointer')}
      onTap={(e) => on.press(o, e, 'tap')}
      onPointerMove={on.pressMove}
      onPointerUp={on.pressEnd}
      onPointerCancel={on.pressEnd}
      onDblTap={props.onEditText}
      onDragStart={(e) => on.dragStart(o, e)}
      onDragMove={(e) => on.dragMove(o, e, props.others)}
      onDragEnd={(e) => on.dragEnd(o, e)}
      onTransformEnd={(e) => on.transformEnd(o, e)}
    />
  );
}

/** The 1920x1080 slide canvas, scaled to fit, with selection, transforms and snapping guides. */
export function SlideCanvas(props: {
  slide: Slide;
  backgroundMediaId?: string;
  media: (id: string) => Media | undefined;
  readOnly: boolean;
  /** Double-tap on a text box (touch): edit its text. */
  onEditText?: (objectId: string) => void;
  /** Touch: tools for the selected object, floated just above or below it (objectToolsSpot). */
  objectTools?: ReactNode;
  /** The deck's area of an imported deck that is not 16:9 (`source.native.slideRect`): the 4:3 guide. */
  slideRect?: SlideRect;
}) {
  const box = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();
  const [size, setSize] = useState({ w: 960, h: 540 });
  const [pane, setPane] = useState({ w: 984, h: 564 });
  const bar = useRef<HTMLDivElement>(null);
  const [barSize, setBarSize] = useState({ w: 480, h: 52 });
  const objectIds = useEditor((s) => s.objectIds);
  const guides = useEditor((s) => s.guides);
  const tick = useImageTick();
  const nodes = useRef(new Map<string, Konva.Shape>());
  const tr = useRef<Konva.Transformer>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const s = Math.min((r.width - 24) / LOGICAL_WIDTH, (r.height - 24) / LOGICAL_HEIGHT);
      setPane({ w: r.width, h: r.height });
      setSize({ w: Math.max(160, LOGICAL_WIDTH * s), h: Math.max(90, LOGICAL_HEIGHT * s) });
    });
    ro.observe(el);
    // Pinch on the canvas is suppressed, not turned into an editor zoom: the slide is already fitted to the
    // pane, every edit is in slide units with numeric fields and the nudge toolbar for fine work, and a
    // two-finger gesture landing on an object must not also move or resize it. `touch-action: none` on the
    // box (styles.css) keeps Safari from scrolling or zooming the page; its proprietary gesture events and
    // multi-finger touchmoves are cancelled too for older iPadOS versions that ignore touch-action for pinch.
    const stop = (e: Event) => e.preventDefault();
    const multi = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    el.addEventListener('gesturestart', stop);
    el.addEventListener('gesturechange', stop);
    el.addEventListener('touchmove', multi, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('gesturestart', stop);
      el.removeEventListener('gesturechange', stop);
      el.removeEventListener('touchmove', multi);
    };
  }, []);
  const scale = size.w / LOGICAL_WIDTH;
  const density = scale * (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const { slide } = props;
  // What the screens draw (design/27 §5): the slide's picture, then its objects (on a slide set to show its
  // PowerPoint picture, only the ones added in ordo, which are all the canvas can select).
  const drawn = useMemo(() => canvasContent(slide, props.media), [slide, props.media]);
  // The selection (design/27 §11 item 5): every selected object the canvas draws, in z order. The
  // Transformer spans them all (one node per member), so a drag or a transform moves the group as one.
  const selected = useMemo(() => {
    const ids = new Set(objectIds);
    return drawn.objects.filter((o) => ids.has(o.id));
  }, [drawn.objects, objectIds]);
  const lockedSel = selected.some(isLocked);
  // A locked art picture alone keeps its aspect: corner anchors only.
  const aspect = selected.length === 1 && keepsAspect(selected[0]!);
  // Past the slide's drawing budget, stored geometries draw as their legacy shapes and effects are left out,
  // as on the outputs (worked out again when a geometry file arrives: `tick`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick changes when a geometry file is read
  const budget = useMemo(() => slideBudget(drawn.objects), [drawn.objects, tick]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach the transformer when the slide re-renders
  useEffect(() => {
    const t = tr.current;
    if (!t) return;
    const ns = props.readOnly
      ? []
      : objectIds.map((id) => nodes.current.get(id)).filter((n): n is Konva.Shape => !!n);
    t.nodes(ns);
    t.getLayer()?.batchDraw();
  }, [objectIds, slide, props.readOnly]);
  const selBox = selected.length > 1 ? groupBox(selected) : selected[0]?.box;
  // A long press under a finger (Alt-click's touch equivalent) is pending.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | undefined>(undefined);
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = undefined;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear a pending long press on unmount only
  useEffect(() => endPress, []);
  // A drag of a multi-object selection: the node under the pointer leads; the members' start positions.
  const drag = useRef<{ leader: string; from: Map<string, { x: number; y: number }>; box: Box } | undefined>(
    undefined,
  );
  // The group box when a transform of a multi-object selection started (Konva's own measure of it).
  const transformFrom = useRef<Box | undefined>(undefined);
  const inGroup = (id: string) => {
    const st = useEditor.getState();
    return st.objectIds.length > 1 && st.objectIds.includes(id);
  };
  const on: NodeHandlers = {
    press(o, e, kind) {
      const ev = e.evt as MouseEvent;
      const mods = { alt: !!ev.altKey, shift: !!ev.shiftKey };
      // Shift toggles, so it acts once per press: on its pointer event (a mouse press fires mousedown too).
      if (mods.shift && kind !== 'pointer') return;
      const st = useEditor.getState();
      const sel = clickSelection(
        { objects: drawn.objects },
        { ids: st.objectIds, primary: st.objectId },
        o.id,
        mods,
      );
      if (!sel) selectObject(undefined);
      else if (
        sel.primary !== st.objectId ||
        sel.ids.length !== st.objectIds.length ||
        sel.ids.some((id, i) => id !== st.objectIds[i])
      )
        selectObjects(sel.ids, sel.primary);
      const pe = e.evt as PointerEvent;
      if (
        kind === 'pointer' &&
        pe.pointerType === 'touch' &&
        !mods.alt &&
        groupMembers({ objects: drawn.objects }, o.id).length > 1
      ) {
        endPress();
        press.current = {
          x: pe.clientX,
          y: pe.clientY,
          timer: setTimeout(() => {
            press.current = undefined;
            selectObjects([o.id], o.id);
          }, LONG_PRESS_MS),
        };
      }
    },
    pressMove(e) {
      const p = press.current;
      const pe = e.evt as PointerEvent;
      if (p && Math.hypot(pe.clientX - p.x, pe.clientY - p.y) > 10) endPress();
    },
    pressEnd: endPress,
    dragStart(o) {
      endPress();
      if (!inGroup(o.id)) return;
      const d = drag.current;
      if (d && nodes.current.get(d.leader)?.isDragging()) return;
      const ids = useEditor.getState().objectIds;
      const from = new Map<string, { x: number; y: number }>();
      for (const id of ids) {
        const n = nodes.current.get(id);
        if (n) from.set(id, n.position());
      }
      const box = groupBox(drawn.objects.filter((x) => from.has(x.id)));
      drag.current = box ? { leader: o.id, from, box } : undefined;
    },
    dragMove(o, e, others) {
      const n = e.target;
      if (inGroup(o.id)) {
        const d = drag.current;
        if (!d || d.leader !== o.id) return;
        // The group box snaps as one; every member keeps its place in it.
        const p0 = d.from.get(o.id)!;
        const moved = { ...d.box, x: d.box.x + n.x() - p0.x, y: d.box.y + n.y() - p0.y };
        const rest = drawn.objects.filter((x) => !d.from.has(x.id)).map((x) => x.box);
        const snapped = snapBox(moved, rest, 10);
        const dx = snapped.x - d.box.x;
        const dy = snapped.y - d.box.y;
        for (const [id, q] of d.from) {
          const m = nodes.current.get(id);
          // The others follow once they drag (the Transformer starts them on the first move, by this delta).
          if (m && (id === o.id || m.isDragging())) m.position({ x: q.x + dx, y: q.y + dy });
        }
        useEditor.setState({ guides: snapped.guides });
        return;
      }
      const b = o.box;
      const snapped = snapBox(
        { x: n.x() - b.w / 2, y: n.y() - b.h / 2, w: b.w, h: b.h, rotation: 0 },
        others,
        10,
      );
      n.position({ x: snapped.x + b.w / 2, y: snapped.y + b.h / 2 });
      useEditor.setState({ guides: snapped.guides });
    },
    dragEnd(o, e) {
      const n = e.target;
      if (inGroup(o.id)) {
        const d = drag.current;
        if (!d || d.leader !== o.id) return;
        drag.current = undefined;
        useEditor.setState({ guides: { x: [], y: [] } });
        const p0 = d.from.get(o.id)!;
        const dx = Math.round(n.x() - p0.x);
        const dy = Math.round(n.y() - p0.y);
        if (dx || dy) dragSelection(dx, dy);
        else for (const [id, q] of d.from) nodes.current.get(id)?.position(q);
        return;
      }
      const b = o.box;
      useEditor.setState({ guides: { x: [], y: [] } });
      const x = Math.round(n.x() - b.w / 2);
      const y = Math.round(n.y() - b.h / 2);
      if (x === b.x && y === b.y) return;
      change((p) => updateObject(p, slide.id, o.id, (ob) => ({ ...ob, box: { ...ob.box, x, y } })));
    },
    transformEnd(o, e) {
      // A multi-object selection is transformed as one by the Transformer's own end (below).
      if (inGroup(o.id)) return;
      const n = e.target;
      let w = Math.max(8, Math.round(n.width() * n.scaleX()));
      let h = Math.max(8, Math.round(n.height() * n.scaleY()));
      if (keepsAspect(o) && o.box.w > 0 && o.box.h > 0) {
        const k = (Math.abs(n.scaleX()) + Math.abs(n.scaleY())) / 2;
        w = Math.max(8, Math.round(o.box.w * k));
        h = Math.max(8, Math.round(o.box.h * k));
      }
      n.scaleX(1);
      n.scaleY(1);
      const box: Box = {
        x: Math.round(n.x() - w / 2),
        y: Math.round(n.y() - h / 2),
        w,
        h,
        // A locked object does not turn (move, resize, delete and z-order only).
        rotation: isLocked(o) ? (o.box.rotation ?? 0) : Math.round(n.rotation() * 10) / 10,
      };
      change((p) => updateObject(p, slide.id, o.id, (ob) => ({ ...ob, box })));
    },
  };
  /** The Transformer's box over a multi-object selection, as a slide Box (`boxFromCorner`). */
  const trBox = (t: Konva.Transformer) =>
    boxFromCorner(
      { x: t.x(), y: t.y(), width: t.width(), height: t.height(), rotation: t.rotation() },
      scale,
    );
  const rotAngle = coarse && selBox ? rotaterAngle(selBox, scale, TOUCH_ROTATE_OFFSET) : 0;
  const showTools = !!props.objectTools && !!selBox;
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w !== barSize.w || h !== barSize.h) setBarSize({ w, h });
  });
  const toolsAt =
    showTools && selBox
      ? objectToolsSpot(
          selBox,
          scale,
          { x: (pane.w - size.w) / 2, y: (pane.h - size.h) / 2 },
          pane,
          barSize,
          { angle: rotAngle, reach: TOUCH_ROTATE_OFFSET + TOUCH_ANCHOR / 2 },
        )
      : undefined;
  const bg = imageFor(stillHash(props.backgroundMediaId ? props.media(props.backgroundMediaId) : undefined));
  const picture = imageFor(drawn.pictureHash);
  // 'Show original' (PptxSlideCard): the PowerPoint picture over the slide, to compare; it takes the pointer.
  const originalId = useOriginalOver(slide);
  const original = originalId ? imageFor(stillHash(props.media(originalId))) : undefined;
  const othersFor = useMemo(
    () => (id: string) => drawn.objects.filter((o) => o.id !== id).map((o) => o.box),
    [drawn.objects],
  );
  return (
    <div ref={box} className="canvasbox">
      <Stage
        width={size.w}
        height={size.h}
        style={{ background: '#000', boxShadow: '0 0 0 1px #333' }}
        onMouseDown={(e) => {
          if (e.target === e.target.getStage() || e.target.name() === 'bg') selectObject(undefined);
        }}
        onTouchStart={(e) => {
          if (e.target === e.target.getStage() || e.target.name() === 'bg') selectObject(undefined);
        }}
      >
        <Layer scaleX={scale} scaleY={scale} listening={false}>
          <Shape
            name="bg"
            sceneFunc={(context) => {
              const ctx = context._context as CanvasRenderingContext2D;
              ctx.fillStyle = '#000';
              ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
              const full = { x: 0, y: 0, w: LOGICAL_WIDTH, h: LOGICAL_HEIGHT, rotation: 0 };
              if (bg) drawImageFit(ctx, bg, full, 1, 'cover');
              if (picture) drawImageFit(ctx, picture, full, 1, 'contain');
            }}
          />
        </Layer>
        <Layer scaleX={scale} scaleY={scale}>
          <Rect name="bg" x={0} y={0} width={LOGICAL_WIDTH} height={LOGICAL_HEIGHT} fill="rgba(0,0,0,0)" />
          {drawn.objects.map((o) => (
            <ObjectNode
              key={o.id}
              o={o}
              media={props.media}
              others={othersFor(o.id)}
              tick={tick}
              density={density}
              drawAs={budget.get(o)}
              readOnly={props.readOnly}
              badge={22 / scale}
              on={on}
              onEditText={
                o.type === 'text' && !props.readOnly && props.onEditText
                  ? () => props.onEditText?.(o.id)
                  : undefined
              }
              registerNode={(id, n) => {
                if (n) nodes.current.set(id, n);
                else nodes.current.delete(id);
              }}
            />
          ))}
          {guides.x.map((x) => (
            <Line
              key={`gx${x}`}
              points={[x, 0, x, LOGICAL_HEIGHT]}
              stroke="#f0f"
              strokeWidth={2 / scale}
              listening={false}
            />
          ))}
          {guides.y.map((y) => (
            <Line
              key={`gy${y}`}
              points={[0, y, LOGICAL_WIDTH, y]}
              stroke="#f0f"
              strokeWidth={2 / scale}
              listening={false}
            />
          ))}
          <CanvasGuides objects={drawn.objects} slideRect={props.slideRect} scale={scale} />
          <CropHandles objects={drawn.objects} scale={scale} readOnly={props.readOnly} />
          <Transformer
            ref={tr}
            rotateEnabled={!lockedSel}
            keepRatio={aspect}
            enabledAnchors={aspect ? CORNER_ANCHORS : ALL_ANCHORS}
            onTransformStart={() => {
              const t = tr.current;
              transformFrom.current = t && t.nodes().length > 1 ? trBox(t) : undefined;
            }}
            onTransformEnd={() => {
              const t = tr.current;
              const from = transformFrom.current;
              transformFrom.current = undefined;
              if (!t || !from || t.nodes().length < 2) return;
              const to = trBox(t);
              // The nodes back as the store has them (Konva scaled and turned them as a preview); the members'
              // new boxes come with the next render. Re-attaching resets the Transformer's own rotation.
              for (const o of selected) {
                const b = o.box;
                nodes.current.get(o.id)?.setAttrs({
                  x: b.x + b.w / 2,
                  y: b.y + b.h / 2,
                  rotation: b.rotation ?? 0,
                  scaleX: 1,
                  scaleY: 1,
                  skewX: 0,
                  skewY: 0,
                });
              }
              t.nodes(t.nodes());
              transformSelection(from, to);
            }}
            rotationSnaps={[0, 90, 180, 270]}
            boundBoxFunc={(oldB, newB) => (newB.width < 8 || newB.height < 8 ? oldB : newB)}
            anchorSize={coarse ? TOUCH_ANCHOR : 10}
            rotateAnchorOffset={coarse ? TOUCH_ROTATE_OFFSET : 50}
            rotateAnchorAngle={rotAngle}
            anchorCornerRadius={coarse ? TOUCH_ANCHOR / 2 : 0}
            anchorStyleFunc={coarse ? touchAnchor : undefined}
            borderStroke="#3b82f6"
            anchorStroke="#3b82f6"
          />
        </Layer>
        {original && (
          <Layer scaleX={scale} scaleY={scale}>
            <Shape
              name="original"
              sceneFunc={(context) => {
                const ctx = context._context as CanvasRenderingContext2D;
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
                const full = { x: 0, y: 0, w: LOGICAL_WIDTH, h: LOGICAL_HEIGHT, rotation: 0 };
                drawImageFit(ctx, original, full, 1, 'contain');
              }}
              hitFunc={(context, shape) => {
                context.beginPath();
                context.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
                context.closePath();
                context.fillStrokeShape(shape);
              }}
            />
          </Layer>
        )}
      </Stage>
      {toolsAt && (
        <div
          ref={bar}
          className="ed-objtools"
          role="toolbar"
          aria-label="Object tools"
          style={{ left: toolsAt.x, top: toolsAt.y }}
        >
          {props.objectTools}
        </div>
      )}
    </div>
  );
}

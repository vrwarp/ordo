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
import { canvasContent } from './canvasContent.ts';
import { change, selectObject, useEditor } from './editorStore.ts';
import { updateObject } from './ops.ts';
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

function ObjectNode(props: {
  o: SlideObject;
  slideId: string;
  media: (id: string) => Media | undefined;
  others: Box[];
  tick: number;
  /** Device px per logical px on screen: the stage scale × devicePixelRatio. */
  density: number;
  /** What the slide's drawing budget draws instead (`slideBudget`), as the outputs draw it. */
  drawAs?: SlideObject;
  readOnly: boolean;
  onSelect: () => void;
  onEditText?: () => void;
  registerNode: (id: string, n: Konva.Shape | null) => void;
}) {
  const { o, tick } = props;
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
      }}
      hitFunc={(context, shape) => {
        context.beginPath();
        context.rect(0, 0, b.w, Math.max(b.h, 12));
        context.closePath();
        context.fillStrokeShape(shape);
      }}
      onMouseDown={props.onSelect}
      onPointerDown={props.onSelect}
      onTap={props.onSelect}
      onDblTap={props.onEditText}
      onDragMove={(e) => {
        const n = e.target;
        const snapped = snapBox(
          { x: n.x() - b.w / 2, y: n.y() - b.h / 2, w: b.w, h: b.h, rotation: 0 },
          props.others,
          10,
        );
        n.position({ x: snapped.x + b.w / 2, y: snapped.y + b.h / 2 });
        useEditor.setState({ guides: snapped.guides });
      }}
      onDragEnd={(e) => {
        const n = e.target;
        useEditor.setState({ guides: { x: [], y: [] } });
        const x = Math.round(n.x() - b.w / 2);
        const y = Math.round(n.y() - b.h / 2);
        if (x === b.x && y === b.y) return;
        change((p) => updateObject(p, props.slideId, o.id, (ob) => ({ ...ob, box: { ...ob.box, x, y } })));
      }}
      onTransformEnd={(e) => {
        const n = e.target;
        const w = Math.max(8, Math.round(n.width() * n.scaleX()));
        const h = Math.max(8, Math.round(n.height() * n.scaleY()));
        n.scaleX(1);
        n.scaleY(1);
        const box: Box = {
          x: Math.round(n.x() - w / 2),
          y: Math.round(n.y() - h / 2),
          w,
          h,
          rotation: Math.round(n.rotation() * 10) / 10,
        };
        change((p) => updateObject(p, props.slideId, o.id, (ob) => ({ ...ob, box })));
      }}
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
}) {
  const box = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();
  const [size, setSize] = useState({ w: 960, h: 540 });
  const [pane, setPane] = useState({ w: 984, h: 564 });
  const bar = useRef<HTMLDivElement>(null);
  const [barSize, setBarSize] = useState({ w: 480, h: 52 });
  const objectId = useEditor((s) => s.objectId);
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
  // Past the slide's drawing budget, stored geometries draw as their legacy shapes and effects are left out,
  // as on the outputs (worked out again when a geometry file arrives: `tick`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick changes when a geometry file is read
  const budget = useMemo(() => slideBudget(drawn.objects), [drawn.objects, tick]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach the transformer when the slide re-renders
  useEffect(() => {
    const t = tr.current;
    if (!t) return;
    const n = objectId ? nodes.current.get(objectId) : undefined;
    t.nodes(n && !props.readOnly ? [n] : []);
    t.getLayer()?.batchDraw();
  }, [objectId, slide, props.readOnly]);
  const selBox = objectId ? drawn.objects.find((o) => o.id === objectId)?.box : undefined;
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
              slideId={slide.id}
              media={props.media}
              others={othersFor(o.id)}
              tick={tick}
              density={density}
              drawAs={budget.get(o)}
              readOnly={props.readOnly}
              onSelect={() => selectObject(o.id)}
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
          <Transformer
            ref={tr}
            rotateEnabled
            keepRatio={false}
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

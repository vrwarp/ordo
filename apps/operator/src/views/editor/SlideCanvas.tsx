import { fileUrl } from '@ordo/client';
import {
  type Box,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Media,
  type Slide,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';
import { drawImageFit, drawObject, drawText } from '@ordo/renderer';
import type Konva from 'konva';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Line, Rect, Shape, Stage, Transformer } from 'react-konva';
import { stillHash } from '../../services/thumbs.ts';
import { change, selectObject, useEditor } from './editorStore.ts';
import { updateObject } from './ops.ts';
import { snapBox } from './snapping.ts';

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
function useImageTick(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const fn = () => setN((x) => x + 1);
    imageListeners.add(fn);
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', fn);
    return () => {
      imageListeners.delete(fn);
      fonts?.removeEventListener?.('loadingdone', fn);
    };
  }, []);
  return n;
}

// ---- text raster cache: the shared rasterizer into an offscreen canvas (WYSIWYG with outputs) ----
const MARGIN = 80;
const textCache = new WeakMap<TextObject, { key: string; canvas: HTMLCanvasElement }>();
function textCanvas(o: TextObject, tick: number): HTMLCanvasElement {
  const key = `${o.box.w}x${o.box.h}:${tick}`;
  const hit = textCache.get(o);
  if (hit && hit.key === key) return hit.canvas;
  const c = hit?.canvas ?? document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(o.box.w + 2 * MARGIN));
  c.height = Math.max(1, Math.ceil(o.box.h + 2 * MARGIN));
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  drawText(ctx, o.text, o.style, { x: MARGIN, y: MARGIN, w: o.box.w, h: o.box.h, rotation: 0 }, 1, {
    opacity: o.opacity,
  });
  textCache.set(o, { key, canvas: c });
  return c;
}

function local(box: Box): Box {
  return { x: 0, y: 0, w: box.w, h: box.h, rotation: 0 };
}

function ObjectNode(props: {
  o: SlideObject;
  slideId: string;
  media: (id: string) => Media | undefined;
  others: Box[];
  tick: number;
  readOnly: boolean;
  onSelect: () => void;
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
        if (o.type === 'text') {
          ctx.drawImage(textCanvas(o, tick), -MARGIN, -MARGIN);
        } else if (o.type === 'image') {
          const img = imageFor(stillHash(props.media(o.mediaId)));
          if (img) drawImageFit(ctx, img, local(b), 1, o.fit, o.opacity, o.radius);
          else {
            ctx.fillStyle = '#333';
            ctx.fillRect(0, 0, b.w, b.h);
          }
        } else drawObject(ctx, { ...o, box: local(b) }, 1);
      }}
      hitFunc={(context, shape) => {
        context.beginPath();
        context.rect(0, 0, b.w, Math.max(b.h, 12));
        context.closePath();
        context.fillStrokeShape(shape);
      }}
      onMouseDown={props.onSelect}
      onTap={props.onSelect}
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
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 960, h: 540 });
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
      setSize({ w: Math.max(160, LOGICAL_WIDTH * s), h: Math.max(90, LOGICAL_HEIGHT * s) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = size.w / LOGICAL_WIDTH;
  const { slide } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach the transformer when the slide re-renders
  useEffect(() => {
    const t = tr.current;
    if (!t) return;
    const n = objectId ? nodes.current.get(objectId) : undefined;
    t.nodes(n && !props.readOnly ? [n] : []);
    t.getLayer()?.batchDraw();
  }, [objectId, slide, props.readOnly]);
  const bg = imageFor(stillHash(props.backgroundMediaId ? props.media(props.backgroundMediaId) : undefined));
  const imported = slide.imported ? imageFor(stillHash(props.media(slide.imported.imageMediaId))) : undefined;
  const othersFor = useMemo(
    () => (id: string) => slide.objects.filter((o) => o.id !== id).map((o) => o.box),
    [slide.objects],
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
              if (imported) drawImageFit(ctx, imported, full, 1, 'contain');
            }}
          />
        </Layer>
        <Layer scaleX={scale} scaleY={scale}>
          <Rect name="bg" x={0} y={0} width={LOGICAL_WIDTH} height={LOGICAL_HEIGHT} fill="rgba(0,0,0,0)" />
          {slide.objects.map((o) => (
            <ObjectNode
              key={o.id}
              o={o}
              slideId={slide.id}
              media={props.media}
              others={othersFor(o.id)}
              tick={tick}
              readOnly={props.readOnly}
              onSelect={() => selectObject(o.id)}
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
            anchorSize={10}
            borderStroke="#3b82f6"
            anchorStroke="#3b82f6"
          />
        </Layer>
      </Stage>
    </div>
  );
}

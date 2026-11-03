import type { KeyFace } from './deck-model.ts';

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export type Surface = { ctx: Ctx2D; width: number; height: number };

/** A 2D canvas of the given size: OffscreenCanvas where available, else a DOM canvas. */
export function createSurface(width: number, height: number): Surface | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    return ctx ? { ctx, width, height } : null;
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    return ctx ? { ctx, width, height } : null;
  }
  return null;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/** Greedy word wrap into at most `maxLines` lines; the last line is ellipsised. */
export function wrapText(
  measure: (s: string) => number,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next) <= maxWidth || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`;
    while (last.length > 1 && measure(`${last}…`) > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }
  return lines.map((l) => {
    if (measure(l) <= maxWidth) return l;
    let t = l;
    while (t.length > 1 && measure(`${t}…`) > maxWidth) t = t.slice(0, -1);
    return `${t}…`;
  });
}

/** Draw a key face filling the surface. */
export function drawKey(s: Surface, face: KeyFace): void {
  const { ctx, width: w, height: h } = s;
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  if (!face.label && !face.sub) return;
  ctx.globalAlpha = face.dim ? 0.45 : 1;
  ctx.fillStyle = face.bg;
  const r = Math.round(w * 0.12);
  ctx.beginPath();
  if ('roundRect' in ctx) ctx.roundRect(0, 0, w, h, r);
  else (ctx as CanvasRenderingContext2D).rect(0, 0, w, h);
  ctx.fill();
  if (face.ring) {
    ctx.strokeStyle = face.ring;
    ctx.lineWidth = Math.max(2, Math.round(w * 0.06));
    ctx.beginPath();
    const inset = ctx.lineWidth / 2;
    if ('roundRect' in ctx) ctx.roundRect(inset, inset, w - inset * 2, h - inset * 2, r);
    else (ctx as CanvasRenderingContext2D).rect(inset, inset, w - inset * 2, h - inset * 2);
    ctx.stroke();
  }
  const pad = Math.round(w * 0.08);
  const maxW = w - pad * 2;
  ctx.fillStyle = face.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Largest font size (bounded) that fits the label in up to 3 lines.
  const subSize = Math.round(h * 0.15);
  const avail = h - pad * 2 - (face.sub ? subSize * 1.2 : 0);
  let size = Math.round(h * (face.label.length <= 3 ? 0.42 : 0.24));
  let lines: string[] = [];
  for (; size >= Math.round(h * 0.12); size -= 1) {
    ctx.font = `700 ${size}px ${FONT}`;
    const maxLines = Math.max(1, Math.min(3, Math.floor(avail / (size * 1.1))));
    lines = wrapText((t) => ctx.measureText(t).width, face.label, maxW, maxLines);
    const fits = lines.every((l) => ctx.measureText(l).width <= maxW) && lines.length * size * 1.1 <= avail;
    if (fits && !lines.some((l) => l.endsWith('…') && size > h * 0.13)) break;
  }
  const lh = size * 1.1;
  const top = pad + (avail - lines.length * lh) / 2 + lh / 2;
  for (const [i, l] of lines.entries()) ctx.fillText(l, w / 2, top + i * lh);
  if (face.sub) {
    ctx.font = `500 ${subSize}px ${FONT}`;
    ctx.globalAlpha = (face.dim ? 0.45 : 1) * 0.85;
    const [sub] = wrapText((t) => ctx.measureText(t).width, face.sub, maxW, 1);
    ctx.fillText(sub ?? '', w / 2, h - pad - subSize / 2);
  }
  ctx.globalAlpha = 1;
}

/** Draw the Plus touch strip: live label large on the left, details small below. */
export function drawStrip(s: Surface, title: string, sub: string): void {
  const { ctx, width: w, height: h } = s;
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const pad = Math.round(h * 0.12);
  const big = Math.round(h * 0.42);
  ctx.font = `700 ${big}px ${FONT}`;
  const [t] = wrapText((x) => ctx.measureText(x).width, title, w - pad * 2, 1);
  ctx.fillText(t ?? '', pad, pad + big / 2);
  ctx.font = `500 ${Math.round(h * 0.22)}px ${FONT}`;
  ctx.fillStyle = '#b0b4ba';
  const [sb] = wrapText((x) => ctx.measureText(x).width, sub, w - pad * 2, 1);
  ctx.fillText(sb ?? '', pad, h - pad - Math.round(h * 0.11));
}

export function pixels(s: Surface): Uint8ClampedArray {
  return s.ctx.getImageData(0, 0, s.width, s.height).data;
}

const shared = new Map<string, Surface>();
function sharedSurface(w: number, h: number): Surface | null {
  const k = `${w}x${h}`;
  let s = shared.get(k);
  if (!s) {
    const c = createSurface(w, h);
    if (!c) return null;
    s = c;
    shared.set(k, s);
  }
  return s;
}

/** Render one key face to RGBA pixels (worker-safe with OffscreenCanvas). Null when no 2D canvas exists. */
export function renderKeyPixels(face: KeyFace, width: number, height: number): Uint8ClampedArray | null {
  const s = sharedSurface(width, height);
  if (!s) return null;
  drawKey(s, face);
  return pixels(s);
}

/** Render the Plus touch strip to RGBA pixels. Null when no 2D canvas exists. */
export function renderStripPixels(
  title: string,
  sub: string,
  width: number,
  height: number,
): Uint8ClampedArray | null {
  const s = sharedSurface(width, height);
  if (!s) return null;
  drawStrip(s, title, sub);
  return pixels(s);
}

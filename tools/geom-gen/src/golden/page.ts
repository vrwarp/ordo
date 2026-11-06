import { drawGeom } from '../../../../packages/renderer/src/geom/draw.ts';
import { presetGeometry } from '../../../../packages/renderer/src/geom/path.ts';
import { OUTLINE_PX, OUTLINE_RGB, type ProbeShape, SLIDE_H, SLIDE_W } from './probe.ts';

/*
 * Browser side of the preset golden (run.ts bundles this with esbuild and loads it in headless Chromium): draws
 * each probe slide as the deck says, every preset with presetGeometry and drawGeom in its box on a white
 * 1920x1080 OffscreenCanvas, the outline with the deck's round joins and flat caps, and returns the slides as PNG
 * (base64).
 */

export interface PageJob {
  readonly shapes: readonly ProbeShape[];
  readonly slides: number;
}

async function drawSlide(shapes: readonly ProbeShape[]): Promise<string> {
  const canvas = new OffscreenCanvas(SLIDE_W, SLIDE_H);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SLIDE_W, SLIDE_H);
  for (const s of shapes) {
    const g = presetGeometry(s.name, s.box.w, s.box.h);
    if (!g) throw new Error(`no preset ${s.name}`);
    ctx.save();
    ctx.translate(s.box.x, s.box.y);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    drawGeom(ctx, g, { ...s.fill, a: 1 }, { color: { ...OUTLINE_RGB, a: 1 }, width: OUTLINE_PX });
    ctx.restore();
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  return btoa(bin);
}

async function run(job: PageJob): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < job.slides; i++) out.push(await drawSlide(job.shapes.filter((s) => s.slide === i)));
  return out;
}

(window as unknown as { __presetPages: (job: PageJob) => Promise<string[]> }).__presetPages = run;

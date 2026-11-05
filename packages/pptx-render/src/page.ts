import type { RunStyle } from './annotate.ts';

/** What the page needs to render one deck. Plain data: it is sent into the browser as JSON. */
export type PageArgs = {
  /** URL of the (annotated) deck, relative to the harness page. */
  pptxUrl: string;
  /** Rendered slide size in CSS pixels. */
  width: number;
  height: number;
  /** Run styles by marker id; null when ordo leaves the run as pptx-preview draws it. */
  runs: (RunStyle | null)[];
  /** Typeface → the installed family the system substitutes for it (fontconfig), when it is missing. */
  fallbacks: Record<string, string>;
  /** Slide width in points, to convert the shadow offsets (points) into pptx-preview's slide units. */
  slideWidthPt: number;
  /** Apply ordo's corrections (false renders exactly as pptx-preview does, for comparisons). */
  fixes: boolean;
};

export type PageResult = {
  slides: { x: number; y: number; width: number; height: number }[];
  /** Markers found and styled. */
  styled: number;
  /** Markers removed without a style. */
  unstyled: number;
  errors: string[];
};

/**
 * Runs inside the browser (serialized with Function.prototype.toString and evaluated in the harness page),
 * so it must not refer to anything outside its own body. `window.pptxPreview` is the unmodified UMD
 * bundle of pptx-preview, loaded by the harness page.
 */
export async function pageMain(args: PageArgs): Promise<PageResult> {
  const MARK_START = '\u2064';
  const MARK_ALPHABET = '\u2060\u2061\u2062\u2063';
  const MARK_DIGITS = 8;
  const errors: string[] = [];
  const w = window as unknown as {
    pptxPreview: {
      init: (
        el: HTMLElement,
        o: { width: number; height: number; mode: 'list' | 'slide' },
      ) => {
        preview: (b: ArrayBuffer) => Promise<unknown>;
      };
    };
  };
  window.addEventListener('error', (e) => errors.push(String(e.message)));

  const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
    // XMLHttpRequest, not fetch: fetch refuses file:// URLs even with file access allowed.
    const x = new XMLHttpRequest();
    x.open('GET', args.pptxUrl);
    x.responseType = 'arraybuffer';
    x.onload = () => (x.response ? resolve(x.response as ArrayBuffer) : reject(new Error('empty deck')));
    x.onerror = () => reject(new Error(`could not read ${args.pptxUrl}`));
    x.send();
  });

  const root = document.getElementById('root') as HTMLElement;
  const viewer = w.pptxPreview.init(root, { width: args.width, height: args.height, mode: 'list' });
  await viewer.preview(buf);

  const quote = (f: string) => `"${f.replace(/["\\]/g, '')}"`;
  const stackFor = (st: RunStyle): string | undefined => {
    const names: string[] = [];
    for (const f of [st.latin, st.latin && args.fallbacks[st.latin], st.ea, st.ea && args.fallbacks[st.ea]])
      if (f && !names.includes(f)) names.push(f);
    if (!names.length) return undefined;
    return `${names.map(quote).join(', ')}, sans-serif`;
  };
  const scale = (el: Element): number => {
    // pptx-preview lays a slide out in points and scales it: shadow offsets (points) need no conversion
    // unless a renderer version lays out in other units, so derive it from the slide wrapper.
    const wrap = el.closest(
      '.slide-wrapper, .slide-layout-wrapper, .slide-master-wrapper',
    ) as HTMLElement | null;
    const width = wrap ? Number.parseFloat(wrap.style.width) : Number.NaN;
    return Number.isFinite(width) && width > 0 ? width / args.slideWidthPt : 1;
  };

  let styled = 0;
  let unstyled = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if ((n as Text).data.includes(MARK_START)) found.push(n as Text);
  for (const t of found) {
    let data = t.data;
    let id: number | undefined;
    for (let at = data.indexOf(MARK_START); at >= 0; at = data.indexOf(MARK_START)) {
      let v = 0;
      let ok = true;
      for (let i = 1; i <= MARK_DIGITS; i++) {
        const d = MARK_ALPHABET.indexOf(data[at + i] ?? '');
        if (d < 0) {
          ok = false;
          break;
        }
        v = v * 4 + d;
      }
      data = data.slice(0, at) + data.slice(at + (ok ? MARK_DIGITS + 1 : 1));
      if (ok && id === undefined) id = v;
    }
    t.data = data;
    const st = id !== undefined ? args.runs[id] : null;
    const el = t.parentElement;
    if (!st || !el || !args.fixes) {
      unstyled++;
      continue;
    }
    const family = stackFor(st);
    if (family) el.style.fontFamily = family;
    if (st.baseline) {
      // PowerPoint draws a raised or lowered run at about two thirds of its size.
      const k = 0.65;
      el.style.fontSize = `${k}em`;
      el.style.verticalAlign = `${(st.baseline / 100_000 / k).toFixed(3)}em`;
      el.style.lineHeight = '0';
    }
    if (st.shadow) {
      const s = scale(el);
      const sh = st.shadow;
      el.style.textShadow = `${sh.dx * s}px ${sh.dy * s}px ${sh.blur * s}px ${sh.color}`;
    }
    styled++;
  }

  // Wait for what is still loading: pictures, fonts and (with a short grace) animated charts.
  await Promise.all(
    Array.from(root.querySelectorAll('img')).map((img) => img.decode().catch(() => undefined)),
  );
  await document.fonts.ready;
  if (root.querySelector('canvas')) await new Promise((r) => setTimeout(r, 1500));

  const slides = Array.from(root.querySelectorAll('.pptx-preview-slide-wrapper')).map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  });
  return { slides, styled, unstyled, errors };
}

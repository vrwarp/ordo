import type { BodyStyle, ParaStyle, PictureClip, RunStyle } from './annotate.ts';

/** What the page needs to render one deck. Plain data: it is sent into the browser as JSON. */
export type PageArgs = {
  /** URL of the (annotated) deck, relative to the harness page. */
  pptxUrl: string;
  /** Rendered slide size in CSS pixels. */
  width: number;
  height: number;
  /** Run styles by marker id; null when ordo leaves the run as pptx-preview draws it. */
  runs: (RunStyle | null)[];
  /** Paragraph and text box styles the runs point to. */
  paras: ParaStyle[];
  bodies: BodyStyle[];
  /** Pictures to clip to their shape (pptx-preview draws every picture as a rectangle). */
  pictures: PictureClip[];
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
  /** Charts on the slides. */
  charts: number;
  errors: string[];
};

/**
 * A rendered text's run markers removed in one pass, and the id of the first. Only MARK_START followed by
 * MARK_DIGITS alphabet digits is a marker; any other U+2064 is the deck's own text and stays. Runs inside
 * the browser next to `pageMain` (chromium.ts sends both), so it refers to nothing outside its own body.
 */
export function takeMarkers(data: string): { text: string; id?: number } {
  const MARK_START = '\u2064';
  const MARK_ALPHABET = '\u2060\u2061\u2062\u2063';
  const MARK_DIGITS = 8;
  const kept: string[] = [];
  let from = 0;
  let id: number | undefined;
  for (let at = data.indexOf(MARK_START); at >= 0; at = data.indexOf(MARK_START, at + 1)) {
    let v = 0;
    let ok = true;
    for (let i = 1; i <= MARK_DIGITS; i++) {
      // Past the end is not a digit (`indexOf('')` would say 0).
      const ch = data[at + i];
      const d = ch === undefined ? -1 : MARK_ALPHABET.indexOf(ch);
      if (d < 0) {
        ok = false;
        break;
      }
      v = v * 4 + d;
    }
    if (!ok) continue;
    kept.push(data.slice(from, at));
    from = at + MARK_DIGITS + 1;
    if (id === undefined) id = v;
  }
  if (id === undefined) return { text: data };
  kept.push(data.slice(from));
  return { text: kept.join(''), id };
}

/**
 * Runs inside the browser (serialized with Function.prototype.toString and evaluated in the harness page),
 * so it must not refer to anything outside its own body but `takeMarkers`, which is sent with it.
 * `window.pptxPreview` is the unmodified UMD bundle of pptx-preview, loaded by the harness page.
 */
export async function pageMain(args: PageArgs): Promise<PageResult> {
  const MARK_START = '\u2064';
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
  // Own entries only: a typeface may be called "constructor" or "__proto__".
  const fallback = (face: string | undefined) => {
    const v = face && Object.hasOwn(args.fallbacks, face) ? args.fallbacks[face] : undefined;
    return typeof v === 'string' ? v : undefined;
  };
  const stackFor = (st: RunStyle): string | undefined => {
    const names: string[] = [];
    for (const f of [st.latin, fallback(st.latin), st.ea, fallback(st.ea)])
      if (typeof f === 'string' && f && !names.includes(f)) names.push(f);
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

  /** Screen pixels per layout pixel of the slide an element is in (the wrapper is scaled with a transform). */
  const zoom = (el: Element): number => {
    const wrap = el.closest(
      '.slide-wrapper, .slide-layout-wrapper, .slide-master-wrapper',
    ) as HTMLElement | null;
    const width = wrap ? Number.parseFloat(wrap.style.width) : Number.NaN;
    const z = wrap && width > 0 ? wrap.getBoundingClientRect().width / width : 1;
    return Number.isFinite(z) && z > 0 ? z : 1;
  };
  /** An element's height in layout pixels, unrounded (offsetHeight rounds to whole pixels). */
  const heightOf = (el: HTMLElement) => el.getBoundingClientRect().height / zoom(el);

  let styled = 0;
  let unstyled = 0;
  /** Marked runs by paragraph element, in document order. */
  const runsOf = new Map<HTMLElement, [HTMLElement, RunStyle][]>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if ((n as Text).data.includes(MARK_START)) found.push(n as Text);
  for (const t of found) {
    const { text, id } = takeMarkers(t.data);
    if (text !== t.data) t.data = text;
    const st = id !== undefined ? args.runs[id] : null;
    const el = t.parentElement;
    if (!st || !el || !args.fixes) {
      unstyled++;
      continue;
    }
    const family = stackFor(st);
    if (family) el.style.fontFamily = family;
    const s = scale(el);
    // pptx-preview condenses Latin text it has no typeface for by 4 % and never reads `spc`.
    el.style.letterSpacing = `${((st.spc ?? 0) * s).toFixed(2)}px`;
    // Runs of spaces are kept (PowerPoint draws every space); underlines do not skip descenders.
    el.style.whiteSpace = 'pre-wrap';
    el.style.textDecorationSkipInk = 'none';
    if (st.shadows)
      el.style.textShadow = st.shadows
        .map((sh) => `${sh.dx * s}px ${sh.dy * s}px ${sh.blur * s}px ${sh.color}`)
        .join(', ');
    const p = el.closest('p') as HTMLElement | null;
    if (p) {
      const list = runsOf.get(p);
      if (list) list.push([el, st]);
      else runsOf.set(p, [[el, st]]);
    }
    styled++;
  }

  // Paragraphs and text boxes, after every run has its font. LibreOffice (as PowerPoint) makes single
  // spacing 1.2 times the font size whatever the font, puts the baseline one font size below the top of a
  // line, and gives extra spacing to the space above the line; CSS splits it above and below.
  await document.fonts.ready;
  const SINGLE = 1.2;
  /** Raised and lowered runs: their share of the font size (LibreOffice's 58 %). */
  const SCRIPT = 0.58;
  type Entry = {
    /** The shrink scale pptx-preview applied to what it drew (the deck's stored one), to undo it. */
    drawnScale: number;
    block: HTMLElement;
    p: HTMLElement;
    para: ParaStyle;
    first: boolean;
    last: boolean;
    runs: [HTMLElement, RunStyle][];
  };
  const boxes = new Map<HTMLElement, { body: BodyStyle; entries: Entry[] }>();
  const loose: Entry[] = [];
  const blockOf = (p: HTMLElement) => (p.parentElement && p.parentElement !== root ? p.parentElement : p);
  for (const [p, runs] of runsOf) {
    const st = runs[0]![1];
    const body = st.b !== undefined ? args.bodies[st.b] : undefined;
    const box = body ? (p.closest('.text-wrapper') as HTMLElement | null) : null;
    if (body && box) {
      if (!boxes.has(box)) {
        // pptx-preview draws one block per paragraph, empty ones included: match them up when it did.
        const blocks = Array.from(box.children) as HTMLElement[];
        const entries: Entry[] = [];
        if (blocks.length === body.paras.length)
          blocks.forEach((block, i) => {
            const bp = block.querySelector('p') as HTMLElement | null;
            const para = args.paras[body.paras[i]!];
            if (bp && para)
              entries.push({
                drawnScale: body.autofit?.fontScale || 1,
                block,
                p: bp,
                para,
                first: i === 0,
                last: i === blocks.length - 1,
                runs: runsOf.get(bp) ?? [],
              });
          });
        boxes.set(box, { body, entries });
      }
      const known = boxes.get(box)!;
      if (known.entries.some((e) => e.p === p)) continue;
      const para = st.p !== undefined ? args.paras[st.p] : undefined;
      const block = blockOf(p);
      if (para)
        known.entries.push({
          drawnScale: body.autofit?.fontScale || 1,
          block,
          p,
          para,
          first: block === box.firstElementChild,
          last: block === box.lastElementChild,
          runs,
        });
      continue;
    }
    const para = st.p !== undefined ? args.paras[st.p] : undefined;
    const block = blockOf(p);
    if (para)
      loose.push({
        drawnScale: 1,
        block,
        p,
        para,
        first: !block.previousElementSibling,
        last: !block.nextElementSibling,
        runs,
      });
  }

  /** Lay out a paragraph: run sizes, spacing, line height. Returns where its first baseline belongs. */
  const layoutPara = (e: Entry, fontScale: number, spacing: number): number => {
    const s = scale(e.p);
    // A scaled size is rounded to whole points, before and after scaling (LibreOffice's editeng).
    const sized = (pt: number) =>
      fontScale === 1 ? pt : Math.max(1, Math.round(Math.round(pt) * fontScale));
    // Spans ordo did not mark (bullets, numbers) shrink with the text: their size, first seen, scaled.
    const marked = new Set(e.runs.map(([el]) => el));
    if (e.runs.length)
      for (const span of Array.from(e.p.querySelectorAll('span')) as HTMLElement[]) {
        if (marked.has(span) || span.dataset.ordoProbe !== undefined) continue;
        // pptx-preview drew it at the deck's stored shrink scale: undo that first.
        if (span.dataset.ordoSize === undefined)
          span.dataset.ordoSize = String((Number.parseFloat(span.style.fontSize) || 0) / e.drawnScale);
        const own = Number(span.dataset.ordoSize);
        if (own > 0) span.style.fontSize = `${(fontScale === 1 ? own : sized(own / s) * s).toFixed(2)}px`;
      }
    for (const [el, st] of e.runs) {
      const size = sized(st.size ?? 18);
      if (st.baseline) {
        // The shift does not make the line any taller: move the run relatively (vertical-align would).
        el.style.fontSize = `${(size * SCRIPT * s).toFixed(2)}px`;
        el.style.position = 'relative';
        el.style.top = `${(-st.baseline / 100_000 / SCRIPT).toFixed(3)}em`;
      } else el.style.fontSize = `${(size * s).toFixed(2)}px`;
    }
    const main = e.runs.find(([, st]) => !st.baseline) ?? e.runs[0];
    const mainStyle = main?.[1] ?? e.para.end;
    const size = sized(mainStyle?.size ?? 18);
    const px = size * s;
    // The paragraph's own font makes the line's strut: give it the main run's, not the page default.
    const family = mainStyle ? stackFor(mainStyle) : undefined;
    if (family) e.p.style.fontFamily = family;
    e.p.style.fontSize = `${px.toFixed(2)}px`;
    // Alignment as the deck says (pptx-preview centres justified text): justified lines fill the width
    // except the last; distributed ones fill it too.
    if (e.para.align) {
      const a = e.para.align;
      e.p.style.textAlign = a === 'ctr' ? 'center' : a === 'r' ? 'right' : a === 'l' ? 'left' : 'justify';
      e.p.style.textAlignLast = a === 'dist' || a === 'thaiDist' ? 'justify' : '';
    }
    if (!e.runs.length) {
      // An empty paragraph is as tall as its end mark's font (pptx-preview draws a fixed 18 px space).
      for (const span of Array.from(e.p.querySelectorAll('span')) as HTMLElement[]) {
        span.style.fontSize = `${px.toFixed(2)}px`;
        if (family) span.style.fontFamily = family;
      }
    }
    // Space before the first paragraph and after the last one is not drawn.
    const len = (sp: { pt: number } | { em: number }) =>
      'pt' in sp ? sp.pt * s : sp.em * (mainStyle?.size ?? 18) * s;
    e.block.style.margin = '0';
    e.block.style.padding = '0';
    if (!e.first && e.para.spcBef)
      e.block.style.paddingTop = `${(len(e.para.spcBef) * spacing).toFixed(2)}px`;
    if (!e.last && e.para.spcAft)
      e.block.style.paddingBottom = `${(len(e.para.spcAft) * spacing).toFixed(2)}px`;
    // Line height and where the baseline sits in the line, as editeng computes them; `spacing` is the
    // shrink-to-fit spacing scale, which also applies to exact line spacing.
    const natural = SINGLE * px;
    if (e.para.lnSpcPt !== undefined) {
      const h = e.para.lnSpcPt * s * spacing;
      e.p.style.lineHeight = `${h.toFixed(2)}px`;
      return px + (h - natural);
    }
    // Unset spacing is single spacing, which the spacing scale leaves alone (measured: LibreOffice draws
    // an unset and an explicit 100 % alike in a shrunk box).
    const pct = (e.para.lnSpcPct ?? 100_000) / 100_000;
    if (pct === 1 || pct === 0) {
      e.p.style.lineHeight = String(SINGLE);
      return px;
    }
    const h = natural * pct * spacing;
    e.p.style.lineHeight = (SINGLE * pct * spacing).toFixed(4);
    return pct < 1 ? Math.min(px, 0.8 * h) : px + (h - natural);
  };

  /**
   * Shrink text on overflow the way LibreOffice 24.2 re-fits it with the fonts it has
   * (SdrTextObj::autoFitTextForCompatibility): a ten-step search on the font scale, moved by whether the
   * text fits at full spacing, trying 100, 90 and 80 % spacing at each step, keeping the tightest fit.
   * PowerPoint stores the scale it found with its own fonts; with substitutes it may not fit, and
   * LibreOffice does not use it.
   */
  const fitBox = (box: HTMLElement, body: BodyStyle, entries: Entry[]): { font: number; spacing: number } => {
    const s = scale(box);
    const shape = box.parentElement;
    const pad = (body.insets[1] + body.insets[3]) * s;
    const avail = (body.size ? body.size.h * s : (shape?.offsetHeight ?? 0)) - pad;
    const layout = (fontPct: number, spacingPct: number) => {
      for (const e of entries) layoutPara(e, fontPct / 100, spacingPct / 100);
    };
    if (!(avail > 0) || !entries.length) return { font: 1, spacing: 1 };
    const slack = (0.5 / 25.4) * 72 * s; // LibreOffice measures the text 0.5 mm short
    const fit = (fontPct: number, spacingPct: number) => {
      layout(fontPct, spacingPct);
      const content = heightOf(box) - pad;
      return content - slack > 0 ? avail / (content - slack) : Number.POSITIVE_INFINITY;
    };
    // LibreOffice starts from full size whatever scale the deck stored (measured: a stored 92.5 % comes
    // out larger when the text fits larger), and leaves text that fits at full size alone.
    const first = fit(100, 100);
    if (first >= 1) return { font: 1, spacing: 1 };
    let lo = 0;
    let hi = 100;
    let best = { font: 0, spacing: 100, factor: first };
    // The scale is rounded to a tenth of a point of the shape's default size, 18 pt for a PowerPoint deck.
    const OBJECT_PT = 18;
    for (let i = 0; i < 10; i++) {
      const mid = lo + (hi - lo) * 0.5;
      const font = (Math.floor(OBJECT_PT * (mid / 100) * 10) / 10 / OBJECT_PT) * 100;
      let factor = 0;
      for (const spacing of [100, 90, 80]) {
        if (factor >= 1) continue;
        factor = fit(font, spacing);
        if (spacing === 100) {
          if (factor > 1) lo = font;
          else hi = font;
        }
        if ((best.factor < 1 && factor > best.factor) || (factor >= 1 && factor < best.factor))
          best = { font, spacing, factor };
      }
    }
    return { font: best.font / 100, spacing: best.spacing / 100 };
  };

  /** Move each paragraph so its first baseline is where LibreOffice puts it (reads layout once each). */
  const placeBaselines = (items: [Entry, number][]) => {
    const todo = items.filter(([, target]) => Number.isFinite(target));
    const probes: HTMLElement[] = [];
    // Writes, then reads, then writes: one layout for all paragraphs, not one each.
    for (const [e] of todo) {
      e.p.style.position = 'relative';
      e.p.style.top = '0px';
      const probe = document.createElement('span');
      probe.dataset.ordoProbe = '';
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      e.p.insertBefore(probe, e.p.firstChild);
      probes.push(probe);
    }
    const shifts = todo.map(([e, target], i) => {
      const at = (probes[i]!.getBoundingClientRect().bottom - e.p.getBoundingClientRect().top) / zoom(e.p);
      return Number.isFinite(at) ? target - at : 0;
    });
    for (const probe of probes) probe.remove();
    todo.forEach(([e], i) => {
      e.p.style.top = `${shifts[i]!.toFixed(2)}px`;
    });
  };

  // Measurements are taken on screen: undo rotations and flips around text while it is laid out (they
  // are put back below), or a turned box would be measured along the wrong axis.
  const turned: [HTMLElement, string][] = [];
  for (const box of boxes.keys())
    for (let el = box.parentElement; el && !el.classList.contains('slide-wrapper'); el = el.parentElement)
      if (el.style.transform && el.style.transform !== 'none' && !turned.some(([t]) => t === el)) {
        turned.push([el, el.style.transform]);
        el.style.transform = 'none';
      }

  const placed: [Entry, number][] = [];
  for (const [box, { body, entries }] of boxes) {
    if (body.vertical) continue; // vertical text: pptx-preview's layout stands
    if (body.shaped) {
      // A shape whose text area is inset (an arrow, a callout): keep pptx-preview's text rectangle and
      // the deck's stored shrink scale, and lay out only the paragraphs in it.
      const font = body.autofit?.fontScale || 1;
      for (const e of entries) placed.push([e, layoutPara(e, font, 1)]);
      continue;
    }
    const s = scale(box);
    const [l, t, r, b] = body.insets.map((v) => `${(v * s).toFixed(2)}px`);
    box.style.padding = `${t} ${r} ${b} ${l}`;
    // The exact width (pptx-preview rounds it to whole points), so lines break where they should; only for
    // a box whose text area is the whole shape (an ellipse's, say, is inset).
    if (body.size && !(Number.parseFloat(box.style.left) || 0))
      box.style.width = `${(body.size.w * s).toFixed(2)}px`;
    // A line break that ends a paragraph still makes a line in PowerPoint and LibreOffice; in HTML a
    // trailing <br> does not. Give it something to hold, sized like the paragraph's end mark.
    for (const e of entries) {
      // The last node that shows anything (an empty run after the break shows nothing).
      let last = e.p.lastChild;
      while (last && last.nodeName !== 'BR' && !(last.textContent ?? '').trim()) last = last.previousSibling;
      if (last?.nodeName !== 'BR') continue;
      const hold = document.createElement('span');
      hold.textContent = '\u200b';
      const end = e.para.end;
      const family = end ? stackFor(end) : undefined;
      if (family) hold.style.fontFamily = family;
      e.p.appendChild(hold);
      if (end) e.runs.push([hold, { ...end, shadows: undefined } as RunStyle]);
    }
    // The text wrapper is positioned inside the shape's box: put it where the anchor says (pptx-preview
    // centres text whose anchor it does not find, and a box that grows to fit keeps a stale height).
    if (body.anchor === 't') {
      box.style.top = '0px';
      box.style.bottom = '';
      box.style.transform = 'none';
    } else if (body.anchor === 'b') {
      box.style.top = 'auto';
      box.style.bottom = '0px';
      box.style.transform = 'none';
    } else {
      box.style.top = '50%';
      box.style.bottom = '';
      box.style.transform = 'translateY(-50%)';
    }
    const chosen = body.autofit ? fitBox(box, body, entries) : { font: 1, spacing: 1 };
    for (const e of entries) placed.push([e, layoutPara(e, chosen.font, chosen.spacing)]);
  }
  for (const e of loose) placed.push([e, layoutPara(e, 1, 1)]);
  placeBaselines(placed);
  for (const [el, transform] of turned) el.style.transform = transform;

  // Pictures in an ellipse or a rounded rectangle. pptx-preview puts each slide's shapes straight into its
  // slide wrapper, a picture as a positioned box holding a cropping box, at whole points: find it there.
  if (args.fixes && args.pictures.length) {
    const wrappers = Array.from(root.querySelectorAll('.pptx-preview-slide-wrapper'));
    for (const pic of args.pictures) {
      const slide = wrappers[pic.slide]?.querySelector('.slide-wrapper');
      if (!slide) continue;
      const near = (v: string, want: number) => Math.abs(Number.parseFloat(v) - Math.round(want)) <= 1;
      for (const outer of Array.from(slide.children) as HTMLElement[]) {
        const inner = outer.firstElementChild as HTMLElement | null;
        if (!inner?.querySelector('img') || !near(outer.style.left, pic.x) || !near(outer.style.top, pic.y))
          continue;
        if (!near(inner.style.width, pic.w) || !near(inner.style.height, pic.h)) continue;
        const s = scale(inner);
        inner.style.clipPath =
          pic.shape === 'ellipse'
            ? 'ellipse(50% 50% at 50% 50%)'
            : `inset(0 round ${((pic.radius ?? 0) * s).toFixed(2)}px)`;
        break;
      }
    }
  }

  // Video and audio: pptx-preview lays a live <video controls> over the poster picture, so the browser's
  // play bar ends up in the slide picture. A stopped video shows its poster (PowerPoint, LibreOffice):
  // take the player away. The media itself is not part of a slide picture.
  if (args.fixes) for (const m of Array.from(root.querySelectorAll('video, audio'))) m.remove();

  // A background picture: pptx-preview writes its size without units ("1920 1080"), which CSS rejects, so
  // the picture is drawn at its own size in the corner. Stretch it (a fill rectangle other than the whole
  // slide moves it, and is left alone).
  if (args.fixes)
    for (const bg of Array.from(root.querySelectorAll('.slide-background')) as HTMLElement[]) {
      const st = bg.style;
      if (!st.backgroundImage || st.backgroundImage.includes('undefined') || st.backgroundSize) continue;
      if (!st.backgroundPosition || /^0(px)? 0(px)?$/.test(st.backgroundPosition))
        st.backgroundSize = '100% 100%';
    }

  // Wait for what is still loading: pictures, fonts and (with a short grace) charts.
  await Promise.all(
    Array.from(root.querySelectorAll('img')).map((img) => img.decode().catch(() => undefined)),
  );
  await document.fonts.ready;
  // Charts are drawn by ECharts (bundled inside pptx-preview, as SVG) a moment after their slide.
  const charts = root.querySelectorAll('canvas, [_echarts_instance_]').length;
  if (charts) await new Promise((r) => setTimeout(r, 300));

  const slides = Array.from(root.querySelectorAll('.pptx-preview-slide-wrapper')).map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  });
  return { slides, styled, unstyled, errors, charts };
}

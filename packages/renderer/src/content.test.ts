import {
  type ImageObject,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  LOOK_STAGE,
  type Look,
  type Presentation,
  type ResolvedPlaylist,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import { CONTENT_CASES, contentCase } from '@ordo/domain/content.test-util.ts';
import { describe, expect, it } from 'vitest';
import { CLAMP, clampSlide } from './clamp.ts';
import { drawableContent, slideContent } from './content.ts';
import { clipLive, withClips } from './fixtures.scene.test-util.ts';
import { planFrame, planPreview, slideVisible } from './plan.ts';
import type { AssetJob } from './messages.ts';
import { jobFontFamilies, rasterSlide } from './raster.ts';
import { rasterScene, sceneSlides } from './scene-raster.ts';
import type { Ctx2D } from './text2d.ts';

/**
 * The one fallback rule in the renderer's drawers (design/27 §5 "One rule for every drawer"): what
 * `drawSlide2D` draws for each slide class and show mode, the scene split of a slide whose clip plays in
 * place, the planner (slide visibility, the in-slide video), the render clamp's picture budget and the fonts
 * a job reports. A fake 2D context records what is drawn: pictures by their media id, text by its string.
 */

/** A 2D context that logs drawImage (by the picture's tag) and fillText; every glyph is 10 px wide. */
function recorder(): { ctx: Ctx2D; ops: string[]; take: () => string[] } {
  let ops: string[] = [];
  const state: Record<string | symbol, unknown> = { font: '10px x', letterSpacing: '0px', globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k === 'measureText') return (s: string) => ({ width: s.length * 10 });
      if (k in t) return t[k];
      return (...args: unknown[]) => {
        if (k === 'fillText') ops.push(`text:${args[0]}`);
        else if (k === 'drawImage') ops.push(`image:${(args[0] as { tag?: string }).tag}`);
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
    has: () => true,
  }) as unknown as Ctx2D;
  return {
    ctx,
    get ops() {
      return ops;
    },
    take() {
      const out = ops;
      ops = [];
      return out;
    },
  };
}

/** Every picture any case names, tagged with its media id (so a drawer is never short of one). */
const pictures = (id: string) => ({ tag: id, width: 1920, height: 1080 }) as unknown as CanvasImageSource;

/** What a case must draw, as the recorder logs it: its pictures in order, then its texts. */
function expected(c: (typeof CONTENT_CASES)[number]): string[] {
  const out: string[] = [];
  if (c.picture) out.push(`image:${c.picture}`);
  for (const o of slideContent(c.slide).objects) {
    if (o.type === 'image') out.push(`image:${o.mediaId}`);
    else if (o.type === 'text') out.push(`text:${o.text}`);
  }
  return out;
}

describe('drawSlide2D follows slideContent', () => {
  for (const c of CONTENT_CASES)
    it(`${c.name}: draws the picture, then the objects drawn, in z order`, () => {
      const r = recorder();
      rasterSlide(r.ctx, c.slide, LOOK_MAIN, 0.5, pictures, { isSong: false });
      expect(r.ops).toEqual(expected(c));
      const drawn = r.ops.filter((o) => o.startsWith('image:')).map((o) => o.slice(6));
      expect(drawn).toEqual(c.pictures);
      expect(r.ops.filter((o) => o.startsWith('text:')).map((o) => o.slice(5))).toEqual(c.texts);
    });

  it('draws the hybrid art between the native objects under and over it', () => {
    const r = recorder();
    rasterSlide(r.ctx, contentCase('hybrid').slide, LOOK_MAIN, 1, pictures);
    expect(r.ops).toEqual(['text:Under', 'image:art', 'image:photo2', 'text:Over']);
  });

  it("lyric-only looks still show a slide's own text when it shows its PowerPoint picture", () => {
    // The imported title is under the picture on authored looks; bands read the slide's text all the same.
    const slide = contentCase('ref').slide;
    for (const look of [LOOK_LOWER_THIRD, LOOK_STAGE]) {
      const r = recorder();
      rasterSlide(r.ctx, slide, look, 0.5, pictures, { isSong: true });
      expect(r.ops.some((o) => o === 'text:Title' || o.startsWith('text:Title'))).toBe(true);
      expect(r.ops.some((o) => o.startsWith('image:'))).toBe(false);
    }
  });

  it('drawableContent is the clamped content, the same arrays on every call', () => {
    const slide = contentCase('ref').slide;
    const a = drawableContent(slide);
    expect(drawableContent(slide)).toBe(a);
    expect(drawableContent(clampSlide(slide))).toBe(a);
    expect(a.pictureMediaId).toBe('ref');
    expect(a.objects.map((o) => o.id)).toEqual(['mine-o', 'added']);
    expect(drawableContent(undefined)).toEqual({ pictureMediaId: undefined, reference: false, objects: [] });
  });
});

describe('the render clamp counts only the pictures a slide draws', () => {
  const image = (id: string, mediaId: string, imported: boolean): ImageObject => ({
    id,
    type: 'image',
    box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    mediaId,
    fit: 'contain',
    opacity: 1,
    radius: 0,
    ...(imported ? { origin: { src: 'pptx' } } : {}),
  });
  const many = (n: number) => Array.from({ length: n }, (_, i) => image(`p${i}`, `photo${i}`, true));

  it('keeps the operator picture of a slide that shows its PowerPoint picture over many imported ones', () => {
    const slide: Slide = {
      id: 's',
      objects: [...many(CLAMP.maxImagesPerSlide + 4), image('mine-o', 'mine', false)],
      pptx: { fileId: 'f', index: 0, class: 'native', version: 1, refMediaId: 'ref', show: 'picture' },
    };
    const clamped = clampSlide(slide);
    // Everything is kept (the imported objects still hold the text a band reads); only `mine` is drawn.
    expect(clamped.objects).toHaveLength(CLAMP.maxImagesPerSlide + 5);
    expect(drawableContent(slide).objects.map((o) => o.id)).toEqual(['mine-o']);
  });

  it('still drops pictures past the budget on a slide that draws its objects', () => {
    const slide: Slide = {
      id: 's',
      objects: [...many(CLAMP.maxImagesPerSlide + 4), image('m', 'mine', false)],
    };
    const ids = clampSlide(slide).objects.map((o) => o.id);
    expect(ids).toHaveLength(CLAMP.maxImagesPerSlide);
    expect(ids).not.toContain('m');
  });
});

describe('the planner follows slideContent', () => {
  it('a slide is visible as authored when it draws a picture or objects', () => {
    for (const c of CONTENT_CASES)
      expect(slideVisible(LOOK_MAIN, clampSlide(c.slide), false), c.name).toBe(
        !!c.picture || slideContent(c.slide).objects.length > 0,
      );
    expect(slideVisible(LOOK_MAIN, clampSlide(contentCase('compact').slide), false)).toBe(false);
    expect(slideVisible(LOOK_MAIN, clampSlide(contentCase('page-ref').slide), false)).toBe(true);
  });

  it("a preview ('Send to preview') plans the slide layer as a live cue does", () => {
    const deck: Presentation = {
      id: 'deck',
      rev: 1,
      title: 'Deck',
      kind: 'slides',
      meta: { tags: [] },
      sections: [{ id: 's', label: 'S', short: 'S', slides: CONTENT_CASES.map((c) => c.slide) }],
      arrangements: [],
      archived: false,
    };
    for (const c of CONTENT_CASES) {
      const desc = planPreview(deck, c.slide.id, LOOK_MAIN).slide.desc;
      expect(!!desc, c.name).toBe(!!c.picture || slideContent(c.slide).objects.length > 0);
    }
  });

  /** The clips deck with slide c1 set to show its PowerPoint picture; its clip object imported or not. */
  function referenceDeck(importedClip: boolean): ResolvedPlaylist {
    const clips = withClips.presentations.clips!;
    const sec = clips.sections[0]!;
    const c1 = sec.slides[0]!;
    const objects = c1.objects.map((o): SlideObject => {
      if (o.type === 'image') return importedClip ? { ...o, origin: { src: 'pptx', role: 'poster' } } : o;
      return { ...o, origin: { src: 'pptx', role: 'title' } };
    });
    const slide: Slide = {
      ...c1,
      objects,
      pptx: { fileId: 'f', index: 0, class: 'native', version: 1, refMediaId: 'ref', show: 'picture' },
    };
    const deck: Presentation = { ...clips, sections: [{ ...sec, slides: [slide, ...sec.slides.slice(1)] }] };
    return { ...withClips, presentations: { ...withClips.presentations, clips: deck } };
  }

  it('an imported clip under the PowerPoint picture is not drawn: no video in the slide, its sound kept', () => {
    const p = planFrame({ ...clipLive('c1'), resolved: referenceDeck(true) }, LOOK_MAIN);
    expect(p.slide.desc).not.toBeNull();
    expect(p.slide.desc?.video).toBeUndefined();
    // The media desc stays for transport and audio routing; nothing draws it full frame.
    expect(p.media.key).toBe('');
    expect(p.media.desc?.inSlide).toBeUndefined();
  });

  it("the operator's own clip on a slide showing its PowerPoint picture plays in its box", () => {
    const p = planFrame({ ...clipLive('c1'), resolved: referenceDeck(false) }, LOOK_MAIN);
    expect(p.slide.desc?.video).toMatchObject({ objectId: 'v1', mediaId: 'vid' });
    expect(p.media.desc?.inSlide).toEqual({ objectId: 'v1' });
  });
});

describe('the scene split follows slideContent', () => {
  const play = (origin: boolean): ImageObject => ({
    id: 'vid-o',
    type: 'image',
    box: { x: 400, y: 300, w: 800, h: 450, rotation: 0 },
    mediaId: 'poster',
    fit: 'contain',
    opacity: 1,
    radius: 0,
    play: { mediaId: 'clip' },
    ...(origin ? { origin: { src: 'pptx', role: 'poster' } } : {}),
  });

  it('base starts with the slide picture: a page under the clip and the objects', () => {
    const page = contentCase('page').slide;
    const slide: Slide = { ...page, objects: [play(false), ...page.objects] };
    const r = recorder();
    const s = rasterScene(r.ctx, r.take, slide, LOOK_MAIN, 0.5, pictures, 'vid-o');
    expect(s?.base).toEqual(['image:page', 'image:poster', 'text:Added']);
    expect(s?.over).toBeNull();
  });

  it('on a slide that shows its PowerPoint picture, an imported clip is no scene; an added one is', () => {
    const ref = contentCase('ref').slide;
    const imported: Slide = { ...ref, objects: [...ref.objects, play(true)] };
    expect(sceneSlides(recorder().ctx, imported, LOOK_MAIN, 0.5, pictures, 'vid-o')).toBeUndefined();
    const added: Slide = {
      ...ref,
      objects: [...ref.objects.slice(0, 3), play(false), ...ref.objects.slice(3)],
    };
    const r = recorder();
    const s = rasterScene(r.ctx, r.take, added, LOOK_MAIN, 0.5, pictures, 'vid-o');
    // Base: the reference picture, the clip's poster and the operator objects clear of the video; never an
    // imported object (the photo and the title are under the reference picture).
    expect(s?.base).toEqual(['image:ref', 'image:poster', 'image:mine', 'text:Added']);
    expect(s?.over).toBeNull();
    // An operator object over the video goes to over, as on any slide.
    const title = { ...ref.objects[4]!, box: { x: 500, y: 400, w: 600, h: 120, rotation: 0 } } as SlideObject;
    const over: Slide = { ...added, objects: [...added.objects, { ...title, id: 'over-title' }] };
    const o = recorder();
    const so = rasterScene(o.ctx, o.take, over, LOOK_MAIN, 0.5, pictures, 'vid-o');
    expect(so?.over).toEqual(['text:Added']);
  });
});

describe('the fonts a slide job reports follow slideContent', () => {
  it('leaves out the text hidden under a PowerPoint picture', () => {
    const slide = contentCase('ref').slide;
    const withFamily: Slide = {
      ...slide,
      objects: slide.objects.map((o) =>
        o.type === 'text'
          ? { ...o, style: { ...o.style, fontFamily: o.origin ? 'Imported Face' : 'Mine' } }
          : o,
      ),
    };
    const job = (look: Look): AssetJob => ({
      kind: 'slide',
      layer: 1,
      key: 'k',
      cueIndex: 0,
      slide: withFamily,
      isSong: false,
      look,
      images: {},
    });
    expect(jobFontFamilies(job(LOOK_MAIN), { fallbacks: false })).toEqual(['mine']);
  });
});

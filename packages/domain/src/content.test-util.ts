import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import type { ImageObject, ObjectOrigin, ShapeObject, Slide, SlideObject, TextObject } from './schemas.ts';

/**
 * Slides of every class and show mode (design/27 §5 "One rule for every drawer"), each with what every
 * drawer must draw of it: the pictures in drawing order (media ids, the slide's picture first) and the text
 * of the text objects drawn. Every drawer's tests run these (renderer, asset worker, link, thumbnail
 * worker, editor canvas, previews, look previews, goLive), so they all follow the one rule.
 *
 * Media ids name what they are: `page` an imported page picture, `ref` a PowerPoint reference picture,
 * `art` the hybrid art, `photo` and `photo2` imported pictures, `mine` a picture the operator added.
 */
export type ContentCase = {
  name: string;
  slide: Slide;
  /** `slideContent(slide).pictureMediaId`. */
  picture?: string;
  /** The media ids drawn, in order (`drawnMediaIds`). */
  pictures: string[];
  /** The text objects drawn, bottom first. */
  texts: string[];
  /** Media ids the slide references that are not drawn. */
  hidden: string[];
};

const FILE = 'f'.repeat(64);
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });
const pptxOrigin = (role?: string): ObjectOrigin => (role ? { src: 'pptx', role } : { src: 'pptx' });

const background = (id: string): ShapeObject => ({
  id,
  type: 'shape',
  box: box(0, 0, 1920, 1080),
  shape: 'rect',
  fill: { r: 20, g: 40, b: 90, a: 1 },
  opacity: 1,
  radius: 0,
  origin: pptxOrigin('bg'),
});

const picture = (id: string, mediaId: string, origin?: ObjectOrigin, extra: Partial<ImageObject> = {}) =>
  ({
    id,
    type: 'image',
    box: box(200, 200, 600, 400),
    mediaId,
    fit: 'contain',
    opacity: 1,
    radius: 0,
    ...(origin ? { origin } : {}),
    ...extra,
  }) as ImageObject;

const text = (id: string, t: string, origin?: ObjectOrigin, y = 100): TextObject => ({
  id,
  type: 'text',
  box: box(100, y, 1700, 150),
  text: t,
  style: { ...DEFAULT_LYRIC_STYLE, fontSizePx: 60, outline: undefined, shadow: undefined },
  opacity: 1,
  ...(origin ? { origin } : {}),
});

const pptx = (cls: 'native' | 'hybrid' | 'picture', extra: Partial<NonNullable<Slide['pptx']>> = {}) => ({
  fileId: FILE,
  index: 0,
  shown: 0,
  class: cls,
  version: 1,
  ...extra,
});

/** The art of a hybrid slide (design/27 §5): locked, transparent, at its place in the z-order. */
const art = picture('art-o', 'art', pptxOrigin('art'), { fit: 'stretch', locked: true });

const nativeObjects = (): SlideObject[] => [
  background('bg'),
  picture('photo-o', 'photo', pptxOrigin('picture')),
  text('title', 'Title', pptxOrigin('title')),
];

export const CONTENT_CASES: ContentCase[] = [
  {
    name: 'native',
    slide: { id: 'native', objects: nativeObjects(), pptx: pptx('native') },
    pictures: ['photo'],
    texts: ['Title'],
    hidden: [],
  },
  {
    name: 'hybrid (art in the middle of the z-order)',
    slide: {
      id: 'hybrid',
      objects: [
        background('bg'),
        text('under', 'Under', pptxOrigin('title'), 50),
        art,
        picture('photo-o', 'photo2', pptxOrigin('picture'), { box: box(1000, 600, 400, 300) }),
        text('over', 'Over', pptxOrigin('body'), 800),
      ],
      pptx: pptx('hybrid', { artText: 'Chart' }),
    },
    pictures: ['art', 'photo2'],
    texts: ['Under', 'Over'],
    hidden: [],
  },
  {
    name: 'hybrid waiting for LibreOffice (version 1, as stored)',
    slide: {
      id: 'pending',
      objects: [background('bg'), text('under', 'Under', pptxOrigin('title'), 50)],
      pptx: pptx('hybrid', { pending: true }),
    },
    pictures: [],
    texts: ['Under'],
    hidden: [],
  },
  {
    name: 'picture class waiting for LibreOffice (compact version 1)',
    slide: { id: 'compact', objects: [], pptx: pptx('picture', { pending: true, artText: 'Text' }) },
    pictures: [],
    texts: [],
    hidden: [],
  },
  {
    name: 'picture class (page picture under the operator objects)',
    slide: {
      id: 'page',
      objects: [text('added', 'Added', undefined, 900)],
      imported: { fileId: FILE, page: 0, imageMediaId: 'page', textAligned: true },
      pptx: pptx('picture'),
    },
    picture: 'page',
    pictures: ['page'],
    texts: ['Added'],
    hidden: [],
  },
  {
    name: 'shows its PowerPoint picture (reference plus the operator objects)',
    slide: {
      id: 'ref',
      objects: [
        ...nativeObjects(),
        picture('mine-o', 'mine', undefined, { box: box(1400, 700, 300, 200) }),
        text('added', 'Added', undefined, 900),
      ],
      pptx: pptx('native', { refMediaId: 'ref', show: 'picture' }),
    },
    picture: 'ref',
    pictures: ['ref', 'mine'],
    texts: ['Added'],
    hidden: ['photo'],
  },
  {
    name: 'hybrid showing its PowerPoint picture (the art is imported too)',
    slide: {
      id: 'hybrid-ref',
      objects: [background('bg'), art, text('over', 'Over', pptxOrigin('body'), 800)],
      pptx: pptx('hybrid', { refMediaId: 'ref', show: 'picture' }),
    },
    picture: 'ref',
    pictures: ['ref'],
    texts: [],
    hidden: ['art'],
  },
  {
    name: 'picture class showing its PowerPoint picture (the reference replaces the page)',
    slide: {
      id: 'page-ref',
      objects: [text('added', 'Added', undefined, 900)],
      imported: { fileId: FILE, page: 0, imageMediaId: 'page' },
      pptx: pptx('picture', { refMediaId: 'ref', show: 'picture' }),
    },
    picture: 'ref',
    pictures: ['ref'],
    texts: ['Added'],
    hidden: ['page'],
  },
  {
    name: 'has a reference picture but shows its objects',
    slide: {
      id: 'ref-objects',
      objects: nativeObjects(),
      pptx: pptx('native', { refMediaId: 'ref', show: 'objects' }),
    },
    pictures: ['photo'],
    texts: ['Title'],
    hidden: ['ref'],
  },
  {
    name: 'set to show a picture it does not have yet',
    slide: { id: 'no-ref', objects: nativeObjects(), pptx: pptx('native', { show: 'picture' }) },
    pictures: ['photo'],
    texts: ['Title'],
    hidden: [],
  },
  {
    name: 'legacy page slide (no PowerPoint provenance)',
    slide: {
      id: 'legacy',
      objects: [text('added', 'Added', undefined, 900)],
      imported: { fileId: FILE, page: 2, imageMediaId: 'page' },
    },
    picture: 'page',
    pictures: ['page'],
    texts: ['Added'],
    hidden: [],
  },
];

/** A case by its slide id. */
export function contentCase(slideId: string): ContentCase {
  const c = CONTENT_CASES.find((x) => x.slide.id === slideId);
  if (!c) throw new Error(`no content case ${slideId}`);
  return c;
}

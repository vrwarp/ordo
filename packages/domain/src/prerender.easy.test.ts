import { describe, expect, it } from 'vitest';
import { CONTENT_CASES } from './content.test-util.ts';
import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import { canonicalJson } from './palette.ts';
import { drawnPart, type PictureInputs, pictureSource, prerenderKey, standbyId } from './prerender.ts';
import type { ShapeObject, Slide, TextObject } from './schemas.ts';
import { sha256Text } from './sha256.ts';

/*
 * design/29 §1.1, §1.5 (Q24.b, the first pre-render release): which slides get a picture (`easyPlan`) and the
 * helper that writes, refreshes or removes the record (`planRecord`). The builders below are copies of the
 * small ones of prerender.test.ts (test files do not import each other).
 */

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });

function rect(id: string, b = box(0, 0, 10, 10), extra: Partial<ShapeObject> = {}): ShapeObject {
  return {
    id,
    type: 'shape',
    box: b,
    shape: 'rect',
    fill: { r: 200, g: 0, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
    ...extra,
  } as ShapeObject;
}
function text(id: string, t: string, b = box(0, 0, 400, 100), extra: Partial<TextObject> = {}): TextObject {
  return { id, type: 'text', box: b, text: t, style: { ...DEFAULT_LYRIC_STYLE }, opacity: 1, ...extra };
}
const bg = (): ShapeObject =>
  rect('bg', box(0, 0, 1920, 1080), {
    fill: { r: 10, g: 20, b: 30, a: 1 },
    origin: { src: 'pptx', role: 'bg' },
  } as Partial<ShapeObject>);

const FONTS = [
  { family: 'Carlito', file: { hash: 'carlito-regular' } },
  { family: 'Inter', file: { hash: 'inter-regular' } },
  { family: 'Liberation Sans', file: { hash: 'liberation-regular' } },
];
function inputs(over: Partial<PictureInputs> = {}): PictureInputs {
  const files: Record<string, string> = { ref: 'ref-file', mine: 'mine-file', photo: 'photo-file' };
  return { mediaFile: (id) => files[id], fonts: FONTS, ...over };
}

/** A background rect, a title and 18 rects: 20 objects, nothing that moves, nothing that is the lyric box. */
function plainSlide(): Slide {
  return {
    id: 'plain',
    objects: [
      bg(),
      text('title', 'Welcome'),
      ...Array.from({ length: 18 }, (_, i) =>
        rect(`r${i}`, box((i % 6) * 60, Math.floor(i / 6) * 60, 50, 50)),
      ),
    ],
  };
}

/** A background, `n` rects at distinct boxes, a title and a lyric box (`lyricObjectId`). */
function crowdedSlide(n: number): Slide {
  return {
    id: `crowded${n}`,
    objects: [
      bg(),
      ...Array.from({ length: n }, (_, i) =>
        rect(`r${i}`, box((i % 40) * 40, Math.floor(i / 40) * 40, 30, 30)),
      ),
      text('title', 'Welcome', box(100, 20, 800, 80)),
      text('lyric', 'Amazing grace', box(100, 700, 1720, 300)),
    ],
    lyricObjectId: 'lyric',
  };
}

/**
 * The slide of content.test-util.ts "shows its PowerPoint picture (reference plus the operator objects)": it
 * draws the reference picture and the operator's own objects, and stores the imported ones. Its imported
 * picture plays, its imported text is the lyric box, and `extraImported` imported rects are added: none of them
 * is drawn.
 */
function referenceSlide(extraImported = 0): Slide {
  const found = CONTENT_CASES.find((c) => c.name.startsWith('shows its PowerPoint picture'));
  if (!found) throw new Error('the reference-picture case of content.test-util.ts moved');
  const s = structuredClone(found.slide);
  s.objects = s.objects.map((o) =>
    o.id === 'photo-o' && o.type === 'image' ? { ...o, play: { mediaId: 'clip' } } : o,
  );
  s.lyricObjectId = 'title';
  const extra = Array.from({ length: extraImported }, (_, i) =>
    rect(`imp${i}`, box((i % 40) * 40, Math.floor(i / 40) * 40, 30, 30), {
      origin: { src: 'pptx', role: 'shape' },
    } as Partial<ShapeObject>),
  );
  s.objects = [...s.objects.slice(0, 3), ...extra, ...s.objects.slice(3)];
  return s;
}

const pin = (s: Slide, live: string[]) => {
  const src = pictureSource(s, live, inputs());
  const part = drawnPart(s, live);
  return {
    key: prerenderKey(src),
    standby: standbyId(src),
    drawn: { objects: part.objects.length, picture: part.picture, digest: sha256Text(canonicalJson(part)) },
  };
};

describe('the keys do not move (easyPlan changes what gets a record, never what a picture is)', () => {
  // `live` is explicit on purpose: these pins must not depend on `liveSet`, which F6 changes (step 2).
  it('the keys of three fixture slides do not move (a moved key makes every stored picture stale)', () => {
    expect({
      plain: pin(plainSlide(), []),
      crowded: pin(crowdedSlide(300), ['lyric']),
      reference: pin(referenceSlide(), []),
    }).toEqual({
      plain: {
        key: 'b81f265c7353348ca2dc09cfe0442882c10831bb0d5d1765454ff17f6de9ead5',
        standby: '321418a87517f3c42fa27cc5ff7111c2230aef8d0d8b98593d7279204eca81da',
        drawn: {
          objects: 20,
          picture: undefined,
          digest: '4ef9a437aa6540a1bd7483276d818f42b143893b37edf9bebe4b3494169add03',
        },
      },
      crowded: {
        key: '2067db3f67e197307560b780ec91147b713dd59eb836de0b4834b5a411a04e9e',
        standby: '9074a773613130c925625fb8ab2e90ab9f71229274bb350cbc57dcbfdf1bbf13',
        drawn: {
          objects: 302,
          picture: undefined,
          digest: '2e3cefa4467681739e68fe956faa329888728221c97a010526b7af6285043c95',
        },
      },
      reference: {
        key: '26f1da118689a8989379565fe075c3089af04fb00c2cbab95877099601765b65',
        standby: '1578cf1b77874fd4084130868eaa221dc07dab5e4f37b94c3bbce09f56bc2cef',
        drawn: {
          objects: 2,
          picture: 'ref',
          digest: '6316cc23d5728999bd1c8229e590d4a7ac77bc5cf1a367ab3085b38ca23b5f8c',
        },
      },
    });
  });
});

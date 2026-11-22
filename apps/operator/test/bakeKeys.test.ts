/**
 * The keys worker's job (workers/bakeKeys.ts, design/29 section 1.4 D11): the key of a heavy slide worked out away from
 * the main thread must be the key the plan works out on it, for every slide, whatever the library holds.
 */
import { DEFAULT_LYRIC_STYLE, type Font, type Media, type Slide } from '@ordo/domain';
import { drawnMediaIds } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { localKey, slideInputs } from '../src/services/bakePlan.ts';
import { type KeysIn, keysOf } from '../src/workers/bakeKeys.ts';

const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
const file = (hash: string, mime: string) => ({ hash, bytes: 10, mime, path: `files/${hash}` });
const media = (id: string, over: Partial<Media> = {}): Media =>
  ({
    id,
    rev: 1,
    name: id,
    tags: [],
    kind: 'image',
    original: file(`${id}-orig`, 'image/png'),
    state: 'ready',
    loop: false,
    isBackground: false,
    ...over,
  }) as Media;
const MEDIA: Media[] = [
  media('photo'),
  media('clip', {
    kind: 'video',
    original: file('clip-orig', 'video/mp4'),
    poster: file('clip-jpg', 'image/jpeg'),
  }),
];
const FONTS = [
  { id: 'f1', rev: 1, family: 'Inter', weight: 400, style: 'normal', file: file('inter', 'font/ttf') },
  { id: 'f2', rev: 1, family: 'Inter', weight: 700, style: 'normal', file: file('inter-bold', 'font/ttf') },
] as unknown as Font[];

const rect = (i: number) => ({
  id: `r${i}`,
  type: 'shape',
  box: { ...box, x: i },
  shape: 'rect',
  fill: { r: i % 256, g: 0, b: 0, a: 1 },
  opacity: 1,
  radius: 0,
});
const text = (id: string, t: string, fontFamily = 'Inter') => ({
  id,
  type: 'text',
  box,
  text: t,
  style: { ...DEFAULT_LYRIC_STYLE, fontFamily },
  opacity: 1,
});
const image = (id: string, mediaId: string) => ({
  id,
  type: 'image',
  box,
  mediaId,
  fit: 'contain',
  opacity: 1,
  radius: 0,
});
const slide = (id: string, n: number, extra: Partial<Slide> = {}): Slide =>
  ({
    id,
    objects: [
      ...Array.from({ length: n }, (_, i) => rect(i)),
      text('t', `Welcome ${id}`),
      image('i1', 'photo'),
      image('i2', 'clip'),
      image('i3', 'gone'),
    ],
    prerender: { why: ['count'], live: [] },
    ...extra,
  }) as unknown as Slide;

/** What the service posts for these slides. */
function message(slides: Slide[], over: Partial<KeysIn> = {}): KeysIn {
  const inputs = slideInputs({ media: MEDIA, fonts: FONTS });
  return {
    t: 'keys',
    id: 7,
    slides: slides.map((s) => ({
      slide: s,
      files: Object.fromEntries(
        drawnMediaIds(s)
          .map((id) => [id, inputs.mediaFile(id)] as const)
          .filter((e): e is [string, string] => typeof e[1] === 'string'),
      ),
    })),
    fonts: FONTS.map((f) => ({ family: f.family, file: { hash: f.file.hash } })),
    ...over,
  };
}

describe("the keys worker works out the plan's own key (K1-K3)", () => {
  it('K1 equals localKey for a big slide, a small one, a slide with a live set, a media the library lacks and a video poster', () => {
    const inputs = slideInputs({ media: MEDIA, fonts: FONTS });
    const slides = [
      slide('big', 420),
      slide('small', 3),
      slide('live', 320, { prerender: { why: ['count'], live: ['r0', 't'] } } as Partial<Slide>),
      { ...slide('bg', 5), backgroundMediaId: 'photo' } as Slide,
    ];
    const out = keysOf(message(slides));
    expect(out.t).toBe('keys');
    expect(out.id).toBe(7);
    expect(out.keys).toEqual(slides.map((s) => localKey(s, inputs)));
    // the keys differ where the slides do
    expect(new Set(out.keys).size).toBe(4);
  });

  it('K2 follows the library: a face added or a file replaced changes the key exactly as it does on the main thread', () => {
    const s = slide('x', 350);
    const before = keysOf(message([s])).keys[0];
    const moreFonts = [
      ...FONTS,
      {
        id: 'f3',
        rev: 1,
        family: 'Inter',
        weight: 300,
        style: 'normal',
        file: file('inter-light', 'font/ttf'),
      },
    ] as unknown as Font[];
    const fontsMsg = message([s], {
      fonts: moreFonts.map((f) => ({ family: f.family, file: { hash: f.file.hash } })),
    });
    const after = keysOf(fontsMsg).keys[0];
    expect(after).not.toBe(before);
    expect(after).toBe(localKey(s, slideInputs({ media: MEDIA, fonts: moreFonts })));
    const replaced = MEDIA.map((m) =>
      m.id === 'photo' ? media('photo', { original: file('photo-v2', 'image/png') }) : m,
    );
    const inputs = slideInputs({ media: replaced, fonts: FONTS });
    const msg = message([s]);
    (msg.slides[0] as KeysIn['slides'][number]).files.photo = inputs.mediaFile('photo') as string;
    expect(keysOf(msg).keys[0]).toBe(localKey(s, inputs));
    expect(keysOf(msg).keys[0]).not.toBe(before);
  });

  it('K3 a slide that cannot be keyed answers null and the others are still keyed; a hostile message never throws', () => {
    const ok = slide('ok', 310);
    const bad = { id: 'bad', objects: 'nope', prerender: { why: ['count'], live: [] } } as unknown as Slide;
    const out = keysOf(message([bad, ok]));
    expect(out.keys[1]).toBe(localKey(ok, slideInputs({ media: MEDIA, fonts: FONTS })));
    expect(() => keysOf({ t: 'keys', id: 1, slides: null, fonts: 4 } as unknown as KeysIn)).not.toThrow();
    expect(keysOf({ t: 'keys', id: 1, slides: null, fonts: 4 } as unknown as KeysIn).keys).toEqual([]);
    const withNull = { ...message([ok]), slides: [null, ...message([ok]).slides] } as unknown as KeysIn;
    expect(() => keysOf(withNull)).not.toThrow();
    expect(keysOf(withNull).keys).toEqual([null, localKey(ok, slideInputs({ media: MEDIA, fonts: FONTS }))]);
  });
});

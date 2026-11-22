import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE } from './defaults.ts';
import { boundStandIn, type HeavyOk, type HeavyResult, heavyForm } from './heavyform.ts';
import { PICTURE_COUNTS, standInOf } from './prerender.ts';
import * as prev from './schemas.prev.test-util.ts';
import { PRERENDER_LIMITS, Slide, type SlideObject, type TextObject } from './schemas.ts';
import {
  FILE_OBJECTS_MAX,
  FullSlide,
  HEAD_USES_MAX,
  INLINE_OBJECTS_MAX,
  SLIDE_FILE_LIMITS,
  slideFileOf,
  slideFromFile,
  STAND_IN_BYTES_MAX,
  TEXT_DRAWN_MAX,
  slideUsesAll,
} from './slidefile.ts';

/*
 * `heavyForm` (import-files step 1, C-IF1, C-IF3): the full form of a heavy slide: a bounded stand-in with its
 * record, the head and the pages of its slide file, or a refusal with a named reason and a plain stand-in WITHOUT a
 * record (a record without a file would look like an inline whole slide). Pure; never throws.
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const hex = (n: number) => n.toString(16).padStart(64, '0');
const box = (x = 0, y = 0, w = 10, h = 10) => ({ x, y, w, h, rotation: 0 });

const rect = (i: number, extra: Record<string, unknown> = {}): SlideObject =>
  ({
    id: `o${i}`,
    type: 'shape',
    box: box(i % 1900, (i * 7) % 1000),
    shape: 'rect',
    fill: { r: i % 256, g: 0, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
    ...extra,
  }) as SlideObject;
const textBox = (id: string, text: string, extra: Record<string, unknown> = {}): TextObject =>
  ({
    id,
    type: 'text',
    box: box(0, 0, 400, 100),
    text,
    style: { ...DEFAULT_LYRIC_STYLE },
    opacity: 1,
    ...extra,
  }) as TextObject;
const image = (id: string, mediaId: string, w = 10): SlideObject =>
  ({
    id,
    type: 'image',
    box: box(0, 0, w, w),
    mediaId,
    fit: 'contain',
    opacity: 1,
    radius: 0,
  }) as SlideObject;
const bgRect = (): SlideObject =>
  rect(0, {
    id: 'bg',
    box: box(0, 0, 1920, 1080),
    fill: { r: 10, g: 20, b: 30, a: 1 },
    origin: { src: 'pptx', role: 'bg' },
  });
const slideOf = (objects: SlideObject[], extra: Record<string, unknown> = {}): Slide =>
  ({ id: 'big', objects, ...extra }) as Slide;

function must(r: HeavyResult): HeavyOk {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}
const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const textsOf = (s: Slide): string[] =>
  s.objects.filter((o) => o.type === 'text').map((o) => (o as TextObject).text);
const compact = (t: string) => t.replace(/\s+/g, '');
const REFUSAL_CODES = ['objects', 'bytes', 'object', 'uses', 'standin', 'invalid'];

describe('heavyForm (HF1-HF13)', () => {
  it('HF1 round trip: 1,001, 1,357 and 20,000 small objects come back whole from the stand-in, the head and the pages', () => {
    for (const n of [1001, 1357, 20_000]) {
      const objects = Array.from({ length: n }, (_, i) => rect(i));
      const full = slideOf(objects, {
        lyricObjectId: 'o3',
        notes: 'kept on the stand-in',
        imported: { fileId: 'f'.repeat(8), page: 2, imageMediaId: 'page-picture' },
      });
      const r = must(heavyForm(full, { why: ['count'] }));
      const back = slideFromFile(
        r.standIn,
        r.file.head,
        r.file.pages.map((p) => p.page),
      );
      expect(back.objects).toEqual(objects);
      expect(back.objects.map((o) => o.id)).toEqual(objects.map((o) => o.id));
      expect(back.lyricObjectId).toBe('o3');
      expect(back.imported).toEqual(full.imported);
      expect(back.notes).toBe('kept on the stand-in');
      expect(r.file.head.count).toBe(n);
    }
  });

  it('HF2 the stand-in: at most 200 objects, 16 pictures, every word, 192 KiB, and the record names the file', () => {
    const objects: SlideObject[] = [bgRect()];
    for (let i = 0; i < 1300; i++) objects.push(rect(i + 1));
    for (let i = 0; i < 120; i++)
      objects.push(textBox(`t${i}`, `Words number ${i} of the lyric, line a b c`));
    for (let i = 0; i < 40; i++) objects.push(image(`p${i}`, `media-${i % 30}`, 10 + i));
    const full = slideOf(objects);
    const r = must(heavyForm(full, { why: ['count'] }));
    const s = r.standIn;
    expect(s.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects);
    expect(
      new Set(s.objects.filter((o) => o.type === 'image').map((o) => (o as { mediaId: string }).mediaId))
        .size,
    ).toBeLessThanOrEqual(PICTURE_COUNTS.pictures);
    expect(jsonBytes(s)).toBeLessThanOrEqual(STAND_IN_BYTES_MAX);
    expect(r.cut).toBe(false);
    // every word, in z order
    expect(compact(textsOf(s).join(''))).toBe(compact(textsOf(full).join('')));
    // the record: the file's name and bytes, no live set, the reasons as given
    expect(s.prerender?.file).toEqual({ ref: r.file.name, bytes: r.file.bytes });
    expect(s.prerender?.live).toEqual([]);
    expect(s.prerender?.why).toEqual(['count']);
    expect(Slide.safeParse(s).success).toBe(true);
    // and the reasons are the caller's: over 64 KiB says bytes
    expect(must(heavyForm(full, { why: ['bytes'] })).standIn.prerender?.why).toEqual(['bytes']);
    expect(must(heavyForm(full, { why: ['bytes', 'count'] })).standIn.prerender?.why).toEqual([
      'bytes',
      'count',
    ]);
  });

  it('HF3 refusals: 20,001 objects, 17 MiB, one 300 KiB object; each comes with a plain stand-in and no record', () => {
    const cases: [string, Slide][] = [
      ['objects', slideOf([bgRect(), ...Array.from({ length: FILE_OBJECTS_MAX }, (_, i) => rect(i + 1))])],
      [
        'bytes',
        slideOf([
          bgRect(),
          ...Array.from({ length: 80 }, (_, i) => rect(i + 1, { pad: 'x'.repeat(220 * KiB) })),
        ]),
      ],
      ['object', slideOf([bgRect(), rect(1, { pad: 'x'.repeat(300 * KiB) }), textBox('t', 'Kept words')])],
    ];
    expect(FILE_OBJECTS_MAX + 1).toBe(20_001);
    for (const [reason, full] of cases) {
      const r = heavyForm(full, { why: ['count'] });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe(reason);
      expect('standIn' in r).toBe(true);
      const standIn = (r as { standIn: Slide }).standIn;
      expect(standIn.prerender).toBeUndefined();
      expect(standIn.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects);
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('HF4 uses: the head names every media id, shape file and font; the record keeps the first 1,000 / 1,000 / 64 and survives its schema', () => {
    const objects: SlideObject[] = [
      bgRect(),
      ...Array.from({ length: 1357 }, (_, i) => rect(i + 1, { geom: { ref: hex(i + 1) } })),
      ...Array.from({ length: 1200 }, (_, i) => image(`i${i}`, `media-${i}`)),
      ...Array.from({ length: 70 }, (_, i) =>
        textBox(`f${i}`, 'x', { style: { ...DEFAULT_LYRIC_STYLE, fontFamily: `Family ${i}` } }),
      ),
    ];
    const r = must(heavyForm(slideOf(objects), { why: ['count'] }));
    expect(r.uses.files).toHaveLength(1357);
    expect(r.uses.media).toHaveLength(1200);
    expect(r.uses.fonts.length).toBeGreaterThanOrEqual(70);
    expect(r.uses).toEqual(slideUsesAll(slideOf(objects)));
    const rec = r.standIn.prerender!;
    expect(rec.uses?.files).toHaveLength(PRERENDER_LIMITS.files);
    expect(rec.uses?.media).toHaveLength(PRERENDER_LIMITS.media);
    expect(rec.uses?.fonts).toHaveLength(PRERENDER_LIMITS.fonts);
    // the schema keeps the record (a longer list would drop the whole record, silently)
    const parsed = Slide.safeParse(r.standIn);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.prerender?.file?.ref).toBe(r.file.name);
    // past HEAD_USES_MAX a slide is refused for its uses, never cut
    const families = Array.from({ length: HEAD_USES_MAX.fonts + 1 }, (_, i) =>
      textBox(`g${i}`, 'x', { style: { ...DEFAULT_LYRIC_STYLE, fontFamily: `Fam ${i}` } }),
    );
    const refused = heavyForm(slideOf(families), { why: ['count'] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('uses');
  });

  it('HF5 an older build parses the stand-in, strips the record and draws the same objects', () => {
    const objects = [bgRect(), ...Array.from({ length: 1100 }, (_, i) => rect(i + 1)), textBox('t', 'Words')];
    const r = must(heavyForm(slideOf(objects), { why: ['count'] }));
    for (const older of [prev]) {
      const parsed = older.Slide.safeParse(r.standIn);
      expect(parsed.success).toBe(true);
      const data = parsed.data as unknown as Record<string, unknown>;
      expect(data.prerender).toBeUndefined();
      expect((data.objects as unknown[]).length).toBe(r.standIn.objects.length);
    }
  });

  it('HF6 determinism: one slide gives the same names and bytes, whatever the key order of its input', () => {
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverseKeys(x)]),
            )
          : v;
    const objects = [bgRect(), ...Array.from({ length: 1500 }, (_, i) => rect(i + 1)), textBox('t', 'Words')];
    const a = must(heavyForm(slideOf(objects, { lyricObjectId: 't' }), { why: ['count'] }));
    const b = must(
      heavyForm(reverseKeys(slideOf(objects, { lyricObjectId: 't' })) as Slide, { why: ['count'] }),
    );
    const c = must(heavyForm(slideOf(objects, { lyricObjectId: 't' }), { why: ['count'] }));
    expect(b.file.name).toBe(a.file.name);
    expect(b.file.pages.map((p) => p.name)).toEqual(a.file.pages.map((p) => p.name));
    expect(c.file.pages.map((p) => p.bytes)).toEqual(a.file.pages.map((p) => p.bytes));
    expect(c.standIn).toEqual(a.standIn);
  });

  it('HF7 FullSlide takes 20,000 objects and refuses 20,001; Slide still refuses 1,001 (the schema bound did not move)', () => {
    const many = (n: number) => ({ id: 's', objects: Array.from({ length: n }, (_, i) => rect(i)) });
    expect(FullSlide.safeParse(many(FILE_OBJECTS_MAX)).success).toBe(true);
    expect(FullSlide.safeParse(many(FILE_OBJECTS_MAX + 1)).success).toBe(false);
    expect(Slide.safeParse(many(INLINE_OBJECTS_MAX)).success).toBe(true);
    expect(Slide.safeParse(many(INLINE_OBJECTS_MAX + 1)).success).toBe(false);
    // every other field of Slide is as it was: a refused field stays refused
    expect(FullSlide.safeParse({ id: 's', objects: [], notes: 'x'.repeat(200_001) }).success).toBe(false);
    expect(FullSlide.safeParse({ id: 's', objects: [], notes: 'fine' }).success).toBe(true);
    expect(FullSlide.safeParse({ id: '', objects: [] }).success).toBe(false);
  });

  it('HF8 text past the stand-in bound: the first piece and the background stay, it fits, and it says cut', () => {
    const objects: SlideObject[] = [bgRect()];
    for (let i = 0; i < 199; i++) objects.push(textBox(`t${i}`, `Box ${i} ${'x'.repeat(19_990)}`));
    const full = slideOf(objects);
    const r = must(heavyForm(full, { why: ['count'] }));
    expect(r.cut).toBe(true);
    expect(jsonBytes(r.standIn)).toBeLessThanOrEqual(STAND_IN_BYTES_MAX);
    expect(r.standIn.objects.some((o) => o.id === 'bg')).toBe(true);
    const first = textsOf(r.standIn)[0]!;
    expect(first.startsWith('Box 0 ')).toBe(true);
    // the words of the first box are all there (split in boxes of at most 10,000 characters, joined)
    const kept = compact(textsOf(r.standIn).slice(0, 2).join(''));
    expect(kept.startsWith(compact(`Box 0 ${'x'.repeat(19_990)}`))).toBe(true);
    // a stand-in that cannot fit is refused (the slide's own provenance is more than the stand-in may hold)
    const boxes = Array.from({ length: 1000 }, (_, i) => ({ text: `${i} ${'y'.repeat(1000)}` }));
    const heavy = slideOf([bgRect(), textBox('t', 'x')], {
      imported: { fileId: 'f'.repeat(8), page: 1, imageMediaId: 'm', textBoxes: boxes },
    });
    const refused = heavyForm(heavy, { why: ['count'] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('standin');
      expect((refused as { standIn: Slide }).standIn.prerender).toBeUndefined();
    }
  });

  it('HF9 a live set is kept whole in the stand-in and recorded (the hook of Q24.a)', () => {
    const objects = [
      bgRect(),
      ...Array.from({ length: 1100 }, (_, i) => rect(i + 1)),
      textBox('lyric', 'Lyric words'),
    ];
    const full = slideOf(objects, { lyricObjectId: 'lyric' });
    const live = ['o5', 'o9', 'lyric'];
    const r = must(heavyForm(full, { why: ['count'], live }));
    const ids = r.standIn.objects.map((o) => o.id);
    for (const id of live) expect(ids).toContain(id);
    expect(r.standIn.objects.find((o) => o.id === 'o5')).toEqual(objects.find((o) => o.id === 'o5'));
    expect(r.standIn.prerender?.live).toEqual(live);
    expect(r.standIn.prerender?.file?.ref).toBe(r.file.name);
    // the file holds all the objects, the live ones included
    expect(r.file.head.count).toBe(objects.length);
  });

  it("HF10 an empty reason list is nothing to do: no file, no record (eligibility is the caller's)", () => {
    const r = heavyForm(slideOf([bgRect(), ...Array.from({ length: 1100 }, (_, i) => rect(i + 1))]), {
      why: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('nothing-to-do');
    expect('file' in r).toBe(false);
  });

  it('HF11 property: any slide of 0 to 2,500 random objects gives a round trip or a refusal with a code, and never throws', () => {
    const kinds = ['rect', 'text', 'image'] as const;
    fc.assert(
      fc.property(
        fc.record({
          n: fc.integer({ min: 0, max: 2500 }),
          seed: fc.integer({ min: 1, max: 2 ** 30 }),
          why: fc.subarray(['bytes', 'count'] as const),
          live: fc.boolean(),
        }),
        ({ n, seed, why, live }) => {
          let x = seed;
          const rnd = () => {
            x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
            return x / 2 ** 32;
          };
          const objects: SlideObject[] = [];
          for (let i = 0; i < n; i++) {
            // now and then a box of up to 20,000 characters (the schema's bound), which a screen draws 10,000 of
            const kind = rnd() < 0.01 ? 'bigtext' : kinds[Math.floor(rnd() * kinds.length)]!;
            if (kind === 'rect') objects.push(rect(i + 1));
            else if (kind === 'text')
              objects.push(textBox(`o${i + 1}`, `w${i} `.repeat(1 + Math.floor(rnd() * 30))));
            else if (kind === 'image') objects.push(image(`o${i + 1}`, `m${Math.floor(rnd() * 40)}`));
            else objects.push(textBox(`o${i + 1}`, 'z'.repeat(Math.floor(rnd() * 20_000))));
          }
          const full = slideOf(objects);
          const r = heavyForm(full, { why, ...(live && n > 3 ? { live: ['o1', 'o2'] } : {}) });
          if (!r.ok) {
            expect([...REFUSAL_CODES, 'nothing-to-do']).toContain(r.reason);
            if ('standIn' in r) expect((r as { standIn: Slide }).standIn.prerender).toBeUndefined();
            return;
          }
          const back = slideFromFile(
            r.standIn,
            r.file.head,
            r.file.pages.map((p) => p.page),
          );
          expect(back.objects).toEqual(objects);
          expect(r.standIn.prerender?.file?.ref).toBe(r.file.name);
          expect(r.standIn.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects + (live ? 2 : 0));
          // a live box is kept whole (drawn live above the picture, clamped there as it ever was); every other box fits a screen
          for (const o of r.standIn.objects)
            if (o.type === 'text' && !r.standIn.prerender?.live.includes(o.id))
              expect(o.text.length).toBeLessThanOrEqual(TEXT_DRAWN_MAX);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('HF12 the pins: the constants equal the places that hold them (no limit is raised, Q53)', () => {
    expect(FILE_OBJECTS_MAX).toBe(SLIDE_FILE_LIMITS.objects);
    expect(FILE_OBJECTS_MAX).toBe(20_000);
    expect(INLINE_OBJECTS_MAX).toBe(1000);
    expect(STAND_IN_BYTES_MAX).toBe(192 * KiB);
    expect(TEXT_DRAWN_MAX).toBe(10_000);
    expect(TEXT_DRAWN_MAX).toBe(PICTURE_COUNTS.characters);
    expect(SLIDE_FILE_LIMITS).toMatchObject({
      pageObjects: 500,
      pageBytes: 256 * KiB,
      bytes: 16 * MiB,
      pages: 129,
    });
    expect(PRERENDER_LIMITS).toMatchObject({ media: 1000, files: 1000, fonts: 64, live: 1000 });
    expect(HEAD_USES_MAX).toEqual({ media: 20_002, files: 20_000, fonts: 2_048 });
    // the schema bound did not move: 1,000 pass and 1,001 do not
    const objs = (n: number) => Array.from({ length: n }, (_, i) => rect(i));
    expect(Slide.safeParse({ id: 's', objects: objs(1000) }).success).toBe(true);
    expect(Slide.safeParse({ id: 's', objects: objs(1001) }).success).toBe(false);
  });

  it('HF13 the 10,000-character box: pieces of 15,000 and 20,000 characters are split, every word kept, ids unique', () => {
    const lyric = (n: number, len: number) =>
      Array.from({ length: n }, (_, i) => textBox(`t${i}`, `${i}${'w'.repeat(len - 3)}`));
    for (const [n, len] of [
      [323, 120],
      [360, 120],
    ] as const) {
      const full = slideOf([bgRect(), ...lyric(n, len)]);
      // the scenario is real: standInOf merges the words into a piece past what a screen draws of one box
      const raw = standInOf(full, []);
      expect(raw.objects.length).toBe(PICTURE_COUNTS.objects);
      expect(Math.max(...textsOf(raw).map((t) => t.length))).toBeGreaterThan(TEXT_DRAWN_MAX);
      const r = must(heavyForm(full, { why: ['count'] }));
      // the split needs one more box than the 200 a screen draws: a whole box is merged into the words, none is lost
      expect(r.cut).toBe(false);
      const texts = textsOf(r.standIn);
      for (const t of texts) expect(t.length).toBeLessThanOrEqual(TEXT_DRAWN_MAX);
      expect(compact(texts.join(''))).toBe(compact(textsOf(full).join('')));
      const ids = r.standIn.objects.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(r.standIn.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects);
      expect(Slide.safeParse(r.standIn).success).toBe(true);
      // the same words in the same order as the slide's
      expect(texts.join('\n').replace(/\s+/g, '')).toBe(textsOf(full).join('').replace(/\s+/g, ''));
    }
  });

  it('HF13 when no box can be merged the pieces after the cap are cut from the END, the first box stays, and it says so', () => {
    // 197 live boxes, the background and one merged piece of 25,000 characters: its split needs a 201st object
    const live = Array.from({ length: 197 }, (_, i) => textBox(`live${i}`, `Live ${i}`));
    const merged = textBox('big~1', `${'a'.repeat(9_990)}\n${'b'.repeat(9_990)}\n${'c'.repeat(5_000)}`);
    const standIn = slideOf([bgRect(), ...live, merged]);
    expect(standIn.objects.length).toBe(199);
    const whole = new Set(['bg', ...live.map((o) => o.id)]);
    const r = boundStandIn(
      standIn,
      live.map((o) => o.id),
      whole,
    );
    expect(r).toBeDefined();
    expect(r!.cut).toBe(true);
    expect(r!.slide.objects.length).toBeLessThanOrEqual(PICTURE_COUNTS.objects);
    for (const l of live) expect(r!.slide.objects).toContain(l);
    const pieces = r!.slide.objects.filter((o) => o.id.startsWith('big')) as TextObject[];
    expect(pieces.map((p) => p.text.length)).toEqual([9_990, 9_990]);
    expect(pieces[0]!.text.startsWith('aaa')).toBe(true);
    // the words that were cut are the last ones
    expect(pieces.map((p) => p.text[0])).toEqual(['a', 'b']);
  });

  it('HF13 a stand-in with no text over 10,000 characters comes back as standInOf made it (identity of the objects)', () => {
    const full = slideOf([
      bgRect(),
      ...Array.from({ length: 1100 }, (_, i) => rect(i + 1)),
      textBox('t', 'Words'),
    ]);
    const r = must(heavyForm(full, { why: ['count'] }));
    const plain = standInOf({ ...full, prerender: r.standIn.prerender! }, []);
    expect(r.standIn).toEqual(plain);
    expect(r.cut).toBe(false);
  });

  it("is what slideFileOf made: the head, the pages and their names are the file's own", () => {
    const full = slideOf([bgRect(), ...Array.from({ length: 1234 }, (_, i) => rect(i + 1))]);
    const r = must(heavyForm(full, { why: ['count'] }));
    const file = slideFileOf(full);
    expect(r.file.name).toBe(file.name);
    expect(r.file.bytes).toBe(file.bytes);
    expect(r.file.pages.map((p) => p.name)).toEqual(file.pages.map((p) => p.name));
  });
});

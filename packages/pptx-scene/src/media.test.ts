import { type ImageObject, Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { CLIP_PREFIX, type EmittedSlide } from './emit.ts';
import { type ConvertOptions, convertDeck } from './index.ts';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  CLRMAP_OVR,
  chartFrame,
  chartXml,
  clipRels,
  type DeckSpec,
  imageRel,
  type MediaPicSpec,
  type MediaTimingSpec,
  mediaPic,
  para,
  pngHeader,
  type RelSpec,
  run,
  solidBg,
  sp,
  timingXml,
  withPart,
} from './test-util.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const W = 12_192_000;
const H = 6_858_000;
const IN = 914_400;

type Clip = Omit<MediaPicSpec, 'rId' | 'embed' | 'link'> & {
  file: string;
  timing?: Omit<MediaTimingSpec, 'spid' | 'kind'>;
  /** A linked clip: its URL (External). */
  url?: string;
  /** The poster's bytes (default: the head of a 1920x1080 opaque PNG). */
  poster?: Uint8Array;
};

/** A one-slide deck with these clips (each with its own poster) and extra shapes above them. */
function deckWith(
  clips: Clip[],
  o: { above?: string; below?: string; size?: DeckSpec['size']; after?: string; rels?: RelSpec[] } = {},
): Map<string, Uint8Array> {
  const rels: RelSpec[] = [...(o.rels ?? [])];
  const media: Record<string, Uint8Array> = {};
  let shapes = o.below ?? '';
  const timing: MediaTimingSpec[] = [];
  clips.forEach((c, i) => {
    const n = i + 1;
    rels.push(imageRel(`rIdP${n}`, `poster${n}.png`));
    media[`ppt/media/poster${n}.png`] = c.poster ?? pngHeader(1920, 1080, true);
    const kind = c.kind === 'p14' ? 'video' : c.kind;
    if (c.url) rels.push({ id: `rIdL${n}`, type: kind, target: c.url, external: true });
    else {
      rels.push(...clipRels(kind, c.file, { embed: `rIdE${n}`, link: `rIdL${n}` }));
      media[`ppt/media/${c.file}`] ??= new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    }
    shapes += mediaPic({
      ...c,
      rId: `rIdP${n}`,
      ...(c.url ? {} : { embed: `rIdE${n}` }),
      link: `rIdL${n}`,
    });
    if (c.timing) timing.push({ spid: c.id, kind, ...c.timing });
  });
  shapes += o.above ?? '';
  return buildDeck({
    ...(o.size ? { size: o.size } : {}),
    slides: [
      {
        bg: solidBg('204060'),
        shapes,
        rels,
        after: `${CLRMAP_OVR}${o.after ?? ''}${timing.length ? timingXml(timing) : ''}`,
      },
    ],
    media,
  });
}

function convert(parts: Map<string, Uint8Array>, opts: ConvertOptions = {}): EmittedSlide {
  const out = convertDeck(parts, opts);
  const s = out.slides[0]!;
  // What the hub stores must parse.
  expect(Slide.safeParse(s.slide).success).toBe(true);
  return s;
}

const images = (s: EmittedSlide) => s.slide.objects.filter((o): o is ImageObject => o.type === 'image');
const box = { x: 2 * IN, y: IN, cx: 4 * IN, cy: (4 * IN * 9) / 16 };

describe('clips in place (design/27 §4 "Media", §8)', () => {
  it('plays the first slide video in its poster box, with a clip placeholder listed for the hub', () => {
    const s = convert(
      deckWith([
        {
          id: 4,
          kind: 'video',
          file: 'media1.mp4',
          ...box,
          timing: {
            start: 'auto',
            loop: true,
            rewind: true,
            vol: 80_000,
            mute: true,
            showWhenStopped: false,
          },
        },
      ]),
    );
    const [poster] = images(s);
    expect(poster!.mediaId.startsWith(CLIP_PREFIX)).toBe(false); // the poster is a picture placeholder
    expect(poster!.play).toEqual({
      mediaId: `${CLIP_PREFIX}1`,
      start: 'auto',
      loop: true,
      onEnd: 'black',
      gainDb: -1.94,
      muted: true,
      showWhenStopped: false,
    });
    expect(s.clips).toEqual([
      {
        role: 'play',
        kind: 'video',
        id: `${CLIP_PREFIX}1`,
        part: 'ppt/media/media1.mp4',
        objectId: poster!.id,
      },
    ]);
    expect(s.notes.join('\n')).not.toMatch(/poster \(M5\)/);
  });

  it('starts a clip on click when the timing says so, or when nothing in it starts the clip', () => {
    const click = convert(
      deckWith([{ id: 4, kind: 'video', file: 'a.mp4', ...box, timing: { start: 'trigger' } }]),
    );
    expect(images(click)[0]!.play).toEqual({ mediaId: `${CLIP_PREFIX}1`, start: 'click' });
    const none = convert(deckWith([{ id: 4, kind: 'video', file: 'a.mp4', ...box }]));
    expect(images(none)[0]!.play?.start).toBe('click');
  });

  it('makes the first slide sound Slide.audio, with numSld, and draws its icon only when shown on the slide', () => {
    const icon = { x: W - IN, y: H - IN, cx: IN / 2, cy: IN / 2 };
    const shown = convert(
      deckWith([
        {
          id: 5,
          kind: 'audio',
          file: 'song.mp3',
          ...icon,
          timing: { start: 'auto', loop: true, numSld: 3, vol: 50_000 },
        },
      ]),
    );
    expect(shown.slide.audio).toEqual({
      mediaId: `${CLIP_PREFIX}1`,
      start: 'auto',
      loop: true,
      gainDb: -6.02,
      slides: 3,
    });
    expect(images(shown)).toHaveLength(1);
    expect(images(shown)[0]!.play).toBeUndefined();
    expect(shown.clips).toEqual([
      { role: 'sound', kind: 'audio', id: `${CLIP_PREFIX}1`, part: 'ppt/media/song.mp3' },
    ]);

    const hidden = convert(
      deckWith([
        {
          id: 5,
          kind: 'audio',
          file: 'song.mp3',
          ...icon,
          timing: { start: 'click', showWhenStopped: false },
        },
      ]),
    );
    expect(hidden.slide.audio).toEqual({ mediaId: `${CLIP_PREFIX}1`, start: 'click' });
    expect(images(hidden)).toHaveLength(0);

    const offSlide = convert(
      deckWith([
        {
          id: 5,
          kind: 'audio',
          file: 'song.mp3',
          x: W + IN,
          y: 0,
          cx: IN,
          cy: IN,
          timing: { start: 'auto' },
        },
      ]),
    );
    expect(offSlide.slide.audio?.start).toBe('auto');
    expect(images(offSlide)).toHaveLength(0);
  });

  it('plays only the first video and the first sound of a slide; the others keep their posters (noted)', () => {
    const s = convert(
      deckWith([
        { id: 4, kind: 'video', file: 'a.mp4', ...box, timing: { start: 'click' } },
        { id: 5, kind: 'video', file: 'b.mp4', ...box, x: 7 * IN, timing: { start: 'auto' } },
        { id: 6, kind: 'audio', file: 'a.mp3', ...box, y: 5 * IN, timing: { start: 'auto' } },
        { id: 7, kind: 'audio', file: 'b.mp3', ...box, y: 5 * IN, x: 7 * IN, timing: { start: 'auto' } },
      ]),
    );
    const posters = images(s);
    expect(posters.filter((o) => o.play)).toHaveLength(1);
    expect(posters[0]!.play?.start).toBe('click');
    // Placeholders are given to the clips that play only.
    expect(s.slide.audio?.mediaId).toBe(`${CLIP_PREFIX}2`);
    expect(s.clips?.map((c) => c.part)).toEqual(['ppt/media/a.mp4', 'ppt/media/a.mp3']);
    expect(s.notes).toContain('only the first video of a slide plays: another is shown as its poster');
    expect(s.notes).toContain('only the first sound of a slide plays: another is left out');
  });

  it('never fetches a linked clip: its poster stays, a note names the host only', () => {
    const s = convert(
      deckWith([
        {
          id: 4,
          kind: 'video',
          file: '',
          url: 'https://videos.example.org/path/secret?token=1',
          ...box,
          timing: { start: 'auto' },
        },
      ]),
    );
    expect(images(s)).toHaveLength(1);
    expect(images(s)[0]!.play).toBeUndefined();
    expect(s.clips).toEqual([
      { role: 'linked', kind: 'video', external: 'videos.example.org', objectId: images(s)[0]!.id },
    ]);
    expect(s.notes.join('\n')).toContain(
      'a linked video (videos.example.org) is not imported: its poster is shown',
    );
    expect(s.notes.join('\n')).not.toContain('secret');
  });

  it('a clip part missing from the deck keeps the poster and is listed', () => {
    const parts = deckWith([{ id: 4, kind: 'video', file: 'gone.mp4', ...box, timing: { start: 'auto' } }]);
    parts.delete('ppt/media/gone.mp4');
    const s = convert(parts);
    expect(images(s)[0]!.play).toBeUndefined();
    expect(s.clips?.[0]).toMatchObject({ role: 'missing', kind: 'video' });
  });

  it('keeps p14:trim for the hub: one placeholder per part and trim', () => {
    const s = convert(
      deckWith([
        {
          id: 4,
          kind: 'video',
          file: 'a.mp4',
          ...box,
          trim: { st: 1500, end: 250.5 },
          timing: { start: 'auto' },
        },
        { id: 5, kind: 'audio', file: 'a.mp4', ...box, x: 7 * IN, timing: { start: 'auto' } },
      ]),
    );
    expect(s.clips).toEqual([
      expect.objectContaining({
        role: 'play',
        id: `${CLIP_PREFIX}1`,
        trim: { startMs: 1500, endCutMs: 251 },
      }),
      expect.objectContaining({ role: 'sound', id: `${CLIP_PREFIX}2`, part: 'ppt/media/a.mp4' }),
    ]);
    expect(s.clips?.[1]?.trim).toBeUndefined();
  });

  it('decides video or sound by the bytes when the caller can tell (pptxgenjs writes sounds as videos)', () => {
    const parts = deckWith([{ id: 4, kind: 'video', file: 'tune.mp4', ...box, timing: { start: 'auto' } }]);
    const s = convert(parts, { mediaKind: (part) => (part === 'ppt/media/tune.mp4' ? 'audio' : undefined) });
    expect(s.slide.audio).toEqual({ mediaId: `${CLIP_PREFIX}1`, start: 'auto' });
    expect(images(s)[0]?.play).toBeUndefined();
    // The kind also keeps a sound out of the art rule for videos; a p14-only clip takes the timing node's kind.
    const p14 = convert(deckWith([{ id: 4, kind: 'p14', file: 'x.m4a', ...box, timing: { start: 'auto' } }]));
    expect(images(p14)[0]?.play?.start).toBe('auto');
  });

  it('never lets a sniffed video turn a sound element into a video (the sniff calls what it cannot tell a video)', () => {
    // An audio-only MP4 of brand isom, or a WMA whose stream list is past the sniffed head: 'video' to the hub.
    const asVideo = () => 'video' as const;
    const s = convert(
      deckWith([{ id: 4, kind: 'audio', file: 'tune.wma', ...box, timing: { start: 'auto' } }]),
      { mediaKind: asVideo },
    );
    expect(s.slide.audio).toEqual({ mediaId: `${CLIP_PREFIX}1`, start: 'auto' });
    expect(images(s).some((o) => o.play)).toBe(false);
    expect(s.clips).toEqual([expect.objectContaining({ role: 'sound', kind: 'audio' })]);
    // A p14-only clip whose timing node is p:audio stays a sound too.
    const parts = deckWith([{ id: 4, kind: 'p14', file: 'x.m4a', ...box, timing: { start: 'auto' } }]);
    const xml = new TextDecoder().decode(parts.get('ppt/slides/slide1.xml'));
    parts.set(
      'ppt/slides/slide1.xml',
      new TextEncoder().encode(
        xml.replaceAll('<p:video>', '<p:audio>').replaceAll('</p:video>', '</p:audio>'),
      ),
    );
    const p14 = convert(parts, { mediaKind: asVideo });
    expect(p14.slide.audio?.mediaId).toBe(`${CLIP_PREFIX}1`);
  });

  it('plays a full-screen video over the slide, its poster fitted inside', () => {
    const s = convert(
      deckWith([{ id: 4, kind: 'video', file: 'a.mp4', ...box, timing: { start: 'auto', fullScrn: true } }]),
    );
    const [poster] = images(s);
    expect(poster!.box).toEqual({ x: 0, y: 0, w: 1920, h: 1080, rotation: 0 });
    expect(poster!.fit).toBe('contain');
    expect(poster!.play?.start).toBe('auto');
  });

  it('videos and sounds of a layout are posters', () => {
    const parts = buildDeck({
      layouts: [
        {
          shapes: mediaPic({ id: 9, kind: 'video', rId: 'rIdP', embed: 'rIdE', link: 'rIdL', ...box }),
          rels: [imageRel('rIdP', 'p.png'), ...clipRels('video', 'l.mp4', { embed: 'rIdE', link: 'rIdL' })],
        },
      ],
      slides: [{}],
      media: { 'ppt/media/l.mp4': new Uint8Array(8) },
    });
    const s = convert(parts);
    expect(images(s)).toHaveLength(1);
    expect(images(s)[0]!.play).toBeUndefined();
    expect(s.clips).toBeUndefined();
    expect(s.notes).toContain('a video of the layout or master does not play: its poster is shown');
  });

  it('imports a transition sound only with the option, and never animation sounds', () => {
    const transition =
      '<p:transition><p:fade/><p:sndAc><p:stSnd loop="1"><p:snd r:embed="rIdS" name="x.wav"/></p:stSnd></p:sndAc></p:transition>';
    const anim =
      '<p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot"><p:childTnLst><p:audio><p:cMediaNode><p:cTn display="0"/><p:tgtEl><p:sndTgt r:embed="rIdA"/></p:tgtEl></p:cMediaNode></p:audio></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>';
    const parts = deckWith([], {
      after: transition + anim,
      rels: [
        { id: 'rIdS', type: 'audio', target: '../media/chime.wav' },
        { id: 'rIdA', type: 'audio', target: '../media/whoosh.wav' },
      ],
    });
    parts.set('ppt/media/chime.wav', new Uint8Array(8));
    parts.set('ppt/media/whoosh.wav', new Uint8Array(8));
    const off = convert(parts);
    expect(off.slide.audio).toBeUndefined();
    expect(off.notes).toContain("a transition sound is not imported (option 'Import transition sounds')");
    expect(off.notes).toContain('1 animation sound(s) are not imported');
    const on = convert(parts, { transitionSounds: true });
    expect(on.slide.audio).toEqual({ mediaId: `${CLIP_PREFIX}1`, start: 'auto', loop: true });
    expect(on.clips).toEqual([
      { role: 'sound', kind: 'audio', id: `${CLIP_PREFIX}1`, part: 'ppt/media/chime.wav' },
    ]);
  });

  it('a slide sound of its own wins over the transition sound', () => {
    const transition =
      '<p:transition><p:sndAc><p:stSnd><p:snd r:embed="rIdS" name="x.wav"/></p:stSnd></p:sndAc></p:transition>';
    const parts = deckWith([{ id: 5, kind: 'audio', file: 'song.mp3', ...box, timing: { start: 'auto' } }], {
      after: transition,
      rels: [{ id: 'rIdS', type: 'audio', target: '../media/chime.wav' }],
    });
    parts.set('ppt/media/chime.wav', new Uint8Array(8));
    const s = convert(parts, { transitionSounds: true });
    expect(s.slide.audio?.mediaId).toBe(`${CLIP_PREFIX}1`);
    expect(s.clips?.map((c) => c.part)).toEqual(['ppt/media/song.mp3']);
    expect(s.notes).toContain('a transition sound is left out: the slide has a sound of its own');
  });
});

describe('motion backgrounds (design/27 §4: a full-slide, looping, muted video at the bottom)', () => {
  const full = { x: 0, y: -96_252, cx: W, cy: H + 2 * 96_252 };
  const title = sp({
    id: 9,
    x: IN,
    y: IN,
    cx: 8 * IN,
    cy: IN,
    ph: 'title',
    txBody: body(para(run('Welcome'))),
  });
  const motion = {
    id: 4,
    kind: 'video' as const,
    file: 'loop.mp4',
    ...full,
    timing: { start: 'auto' as const, loop: true, mute: true },
  };

  it('becomes the slide background; what it covers is left out and its poster kept for the hub', () => {
    const s = convert(deckWith([motion], { above: title }));
    expect(s.slide.backgroundMediaId).toBe(`${CLIP_PREFIX}1`);
    // The solid background rect and the poster are gone; the title stays (and is the lyric box).
    expect(s.slide.objects.map((o) => o.type)).toEqual(['text']);
    expect(s.slide.lyricObjectId).toBe(s.slide.objects[0]!.id);
    const clip = s.clips?.[0];
    expect(clip).toMatchObject({
      role: 'background',
      kind: 'video',
      id: `${CLIP_PREFIX}1`,
      part: 'ppt/media/loop.mp4',
    });
    expect(clip?.poster?.type).toBe('image');
    expect(clip?.poster?.play).toBeUndefined();
    expect(s.notes).toContain('a looping, muted video over the whole slide is its motion background');
  });

  it('volume 0 counts as muted', () => {
    const s = convert(deckWith([{ ...motion, timing: { start: 'auto', loop: true, vol: 0 } }]));
    expect(s.slide.backgroundMediaId).toBe(`${CLIP_PREFIX}1`);
  });

  it('stays a playing video when it has sound, does not loop, waits for a click or has slide content below it', () => {
    const cases: Clip['timing'][] = [
      { start: 'auto', loop: true },
      { start: 'auto', mute: true },
      { start: 'click', loop: true, mute: true },
    ];
    for (const timing of cases) {
      const s = convert(deckWith([{ ...motion, timing }]));
      expect(s.slide.backgroundMediaId).toBeUndefined();
      expect(images(s)[0]!.play).toBeDefined();
    }
    const below = convert(deckWith([motion], { below: title }));
    expect(below.slide.backgroundMediaId).toBeUndefined();
    expect(images(below)[0]!.play).toMatchObject({ loop: true, muted: true });
  });

  it('only on a 16:9 deck, over the whole slide, at the slide aspect', () => {
    const fourThree = convert(
      deckWith([{ ...motion, x: 0, y: 0, cx: 9_144_000, cy: H }], { size: { cx: 9_144_000, cy: H } }),
    );
    expect(fourThree.slide.backgroundMediaId).toBeUndefined();
    const small = convert(deckWith([{ ...motion, ...box }]));
    expect(small.slide.backgroundMediaId).toBeUndefined();
    const square = convert(deckWith([{ ...motion, poster: pngHeader(1000, 1000, true) }]));
    expect(square.slide.backgroundMediaId).toBeUndefined();
  });

  it('keeps the art and the metafiles of a hybrid slide pointing at the right objects', () => {
    const icon = { x: W + IN, y: 0, cx: IN, cy: IN };
    const parts = deckWith([{ id: 5, kind: 'audio', file: 's.mp3', ...icon, timing: { start: 'auto' } }], {
      above:
        sp({ id: 10, x: IN, y: IN, cx: 2 * IN, cy: IN, txBody: body(para(run('Below the chart'))) }) +
        chartFrame({ id: 11, x: 4 * IN, y: IN, cx: 4 * IN, cy: 3 * IN, rId: 'rIdC' }) +
        sp({ id: 12, x: IN, y: 5 * IN, cx: 2 * IN, cy: IN, txBody: body(para(run('Above'))) }),
      rels: [{ id: 'rIdC', type: 'chart', target: '../charts/chart1.xml' }],
    });
    withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
    const s = convert(parts);
    expect(s.classification.class).toBe('hybrid');
    // The icon (off the slide) is left out; the art still goes just under the text above the chart.
    expect(images(s)).toHaveLength(0);
    const above = s.slide.objects.find((o) => o.type === 'text' && o.text === 'Above');
    expect(s.art?.before).toBe(above?.id);
    expect(
      s.slide.objects.slice(0, s.art!.at).some((o) => o.type === 'text' && o.text === 'Below the chart'),
    ).toBe(true);
  });
});

describe('clips: bounds (design/27 §12)', () => {
  it('a slide of 2,000 videos and sounds converts quickly: one plays, one is the sound, the notes stay few', () => {
    const many: Clip[] = Array.from({ length: 2_000 }, (_, i) => ({
      id: 10 + i,
      kind: i % 2 ? ('audio' as const) : ('video' as const),
      file: `m${i % 50}.mp4`,
      x: (i % 40) * 100_000,
      y: Math.floor(i / 40) * 100_000,
      cx: 90_000,
      cy: 90_000,
      timing: { start: 'auto' },
    }));
    const t0 = performance.now();
    const s = convert(deckWith(many));
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    expect(images(s).filter((o) => o.play)).toHaveLength(1);
    expect(s.slide.audio).toBeDefined();
    expect(s.clips?.filter((c) => c.role === 'play' || c.role === 'sound')).toHaveLength(2);
    expect(s.notes.length).toBeLessThan(20);
  });
});

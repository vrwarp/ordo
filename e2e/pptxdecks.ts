import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import pptxgen from 'pptxgenjs';
import {
  body,
  buildDeck,
  CLRMAP_OVR,
  clipRels,
  esc,
  imageRel,
  NS_A,
  NS_P,
  NS_R,
  para,
  type RelSpec,
  run,
  type SlideSpec,
  solid,
  solidBg,
  sp,
  timingXml,
  type MediaTimingSpec,
  xfrm,
} from '../packages/pptx-scene/src/test-util.ts';

/**
 * Synthetic PowerPoint probe decks for the native import's end-to-end specs (design/27 §14.2, §14.12,
 * §15 M3 and M5 exits): written here, never taken from a real deck. Pictures and clips come from ffmpeg's
 * own test sources; every text is public domain (World English Bible).
 */

export function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
}

// ---- the text deck (pptxgenjs, as tools/pptx-fidelity/src/corpus.ts writes its decks) -------------------

/** John 3:16-17 (WEB), with its verse numbers raised, as worship decks set them. */
export const VERSES: [string, string][] = [
  ['16', ' For God so loved the world, that he gave his one and only Son.'],
  ['17', " For God didn't send his Son into the world to judge the world."],
];
/** The verse slide's text as people read it: the verse numbers are part of the text. */
export const VERSE_TEXT = VERSES.map(([n, t]) => n + t).join('\n');

export type TextDeckSlide = { text: string; notes?: string; hidden?: boolean };

/** What each slide of the text deck holds (its lyric text and notes), in deck order. */
export const TEXT_DECK: TextDeckSlide[] = [
  { text: 'Morning Worship\nSunday service', notes: 'Welcome everyone as they come in.' },
  { text: VERSE_TEXT, notes: 'Read slowly: John 3:16-17.' },
  { text: 'A hidden slide for the second service', notes: 'Notes of the hidden slide.', hidden: true },
  { text: 'After the hidden slide', notes: 'Notes of the fourth slide.' },
  { text: 'Coffee after the service in the hall' },
];

/**
 * The text deck: a title over a full-slide picture, the verse slide (raised verse numbers, notes), a hidden
 * slide, a slide with a picture and shapes, an announcement. Fonts are Calibri, which an output draws with
 * the bundled Carlito where it is installed (else with its fallback chain); pptx-native.spec.ts gives the
 * harness the output's faces, so both draw with the same files.
 */
export async function textDeck(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const bg = join(dir, 'gradient.png');
  const photo = join(dir, 'photo.png');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'gradients=s=1920x1080:c0=0x1f3a5f:c1=0x6b2f4a:x0=0:y0=0:x1=1920:y1=1080',
    '-frames:v',
    '1',
    bg,
  ]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=800x450', '-frames:v', '1', photo]);
  const data = (f: string) => `image/png;base64,${readFileSync(f).toString('base64')}`;
  const p = new pptxgen();
  p.layout = 'LAYOUT_WIDE';
  const font = 'Calibri';

  const s1 = p.addSlide();
  s1.background = { data: data(bg) };
  s1.addText(
    [
      { text: 'Morning Worship', options: { fontSize: 66, bold: true, breakLine: true } },
      { text: 'Sunday service', options: { fontSize: 36 } },
    ],
    { x: 0.8, y: 2.2, w: 11.7, h: 3, fontFace: font, color: 'FFFFFF', align: 'center', valign: 'middle' },
  );
  s1.addNotes(TEXT_DECK[0]!.notes!);

  const s2 = p.addSlide();
  s2.background = { color: 'F2EFE6' };
  s2.addText(
    VERSES.flatMap(([n, t], i) => [
      { text: n, options: { superscript: true } },
      { text: t, options: i < VERSES.length - 1 ? { breakLine: true } : {} },
    ]),
    {
      x: 0.8,
      y: 1.2,
      w: 11.7,
      h: 5,
      fontFace: font,
      fontSize: 44,
      color: '222222',
      align: 'left',
      valign: 'top',
    },
  );
  s2.addNotes(TEXT_DECK[1]!.notes!);

  const s3 = p.addSlide();
  s3.hidden = true;
  s3.background = { color: '3A3A3A' };
  s3.addText(TEXT_DECK[2]!.text, {
    x: 0.8,
    y: 2.5,
    w: 11.7,
    h: 2,
    fontFace: font,
    fontSize: 48,
    color: 'FFFF66',
    align: 'center',
  });
  s3.addNotes(TEXT_DECK[2]!.notes!);

  const s4 = p.addSlide();
  s4.background = { color: 'FFFFFF' };
  s4.addShape(p.ShapeType.roundRect, {
    x: 0.6,
    y: 0.6,
    w: 5.6,
    h: 6.3,
    fill: { color: '1F4E79' },
    rectRadius: 0.4,
  });
  s4.addShape(p.ShapeType.ellipse, { x: 4.6, y: 4.9, w: 2, h: 2, fill: { color: 'C55A11' } });
  s4.addText(TEXT_DECK[3]!.text, {
    x: 0.9,
    y: 1,
    w: 5,
    h: 3,
    fontFace: font,
    fontSize: 44,
    bold: true,
    color: 'FFFFFF',
    valign: 'top',
  });
  s4.addImage({ data: data(photo), x: 6.8, y: 1.6, w: 6, h: 3.375 });
  s4.addNotes(TEXT_DECK[3]!.notes!);

  const s5 = p.addSlide();
  s5.background = { color: '0B3D2E' };
  s5.addText('Announcements', {
    x: 0.8,
    y: 0.6,
    w: 11.7,
    h: 1.2,
    fontFace: font,
    fontSize: 54,
    bold: true,
    color: 'FFFFFF',
  });
  s5.addText(TEXT_DECK[4]!.text, {
    x: 0.8,
    y: 2.4,
    w: 11.7,
    h: 3,
    fontFace: font,
    fontSize: 40,
    color: 'E8F5E9',
    valign: 'top',
  });

  const file = join(dir, 'Probe text.pptx');
  writeFileSync(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  return file;
}

// ---- the media decks (crafted OOXML with p:timing, as apps/hub/test/pptx-clips.test.ts writes them) ------

const IN = 914_400;
const W = 12_192_000;
const H = 6_858_000;

/** A clip in a deck: a `p:pic` poster with its media elements, at a box, turned, cropped, masked. */
export type ProbeClip = {
  id: number;
  kind: 'video' | 'audio';
  /** The clip's part under ppt/media. */
  part: string;
  box: { x: number; y: number; cx: number; cy: number };
  rot?: number;
  /** `a:srcRect` attributes (thousandths of a percent), e.g. `l="10000" r="10000"`. */
  srcRect?: string;
  geom?: 'rect' | 'roundRect';
  trim?: { st?: number; end?: number };
  timing?: Omit<MediaTimingSpec, 'spid' | 'kind'>;
};

/** A video or sound as PowerPoint 2010+ writes it, with a turn, a crop and a preset mask. */
function clipPic(c: ProbeClip, poster: string): string {
  const trim = c.trim
    ? `<p14:trim${c.trim.st !== undefined ? ` st="${c.trim.st}"` : ''}${c.trim.end !== undefined ? ` end="${c.trim.end}"` : ''}/>`
    : '';
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${c.id}" name="${esc(`Media ${c.id}`)}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr>` +
    `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:${c.kind === 'video' ? 'videoFile' : 'audioFile'} r:link="rIdL${c.id}"/>` +
    `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rIdE${c.id}">${trim}</p14:media></p:ext></p:extLst></p:nvPr></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${poster}"/>${c.srcRect ? `<a:srcRect ${c.srcRect}/>` : ''}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(c.box.x, c.box.y, c.box.cx, c.box.cy, { rot: c.rot })}<a:prstGeom prst="${c.geom ?? 'rect'}"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

/** A filled band with dark text in it (a title over a clip). */
function band(id: number, text: string, box: { x: number; y: number; cx: number; cy: number }): string {
  return sp({
    id,
    ...box,
    fill: solid('EBEBEB'),
    txBody: body(para(run(text, 'sz="4400" b="1"', solid('141414')), 'algn="ctr"'), 'anchor="ctr"'),
  });
}

/** A text box (white on the slide's colour). */
function textBox(id: number, text: string, y = 2.5 * IN): string {
  return sp({
    id,
    x: IN,
    y,
    cx: W - 2 * IN,
    cy: 1.5 * IN,
    fill: '<a:noFill/>',
    txBox: true,
    txBody: body(para(run(text, 'sz="4800" b="1"', solid('FFFFFF')), 'algn="ctr"'), 'wrap="square"'),
  });
}

/** A slide with these clips (each with its poster) and `shapes` above them, `extra` after its timing. */
function clipSlide(
  clips: ProbeClip[],
  shapes = '',
  o: { bg?: string; transition?: string; hidden?: boolean; poster?: string } = {},
): SlideSpec {
  const poster = o.poster ?? 'poster.png';
  const rels: RelSpec[] = [imageRel('rIdP', poster)];
  let xml = '';
  const timing: MediaTimingSpec[] = [];
  for (const c of clips) {
    rels.push(...clipRels(c.kind, c.part, { embed: `rIdE${c.id}`, link: `rIdL${c.id}` }));
    xml += clipPic(c, 'rIdP');
    if (c.timing) timing.push({ spid: c.id, kind: c.kind, ...c.timing });
  }
  return {
    bg: solidBg(o.bg ?? '282828'),
    shapes: xml + shapes,
    rels,
    hidden: o.hidden,
    after: `${CLRMAP_OVR}${o.transition ?? ''}${timing.length ? timingXml(timing) : ''}`,
  };
}

const enc = new TextEncoder();

/** The deck's parts zipped into `file`, with a looping show (`p:showPr loop`) when asked. */
function zip(parts: Map<string, Uint8Array>, file: string, loopShow = false): string {
  if (loopShow) {
    const relsPart = 'ppt/_rels/presentation.xml.rels';
    const rels = new TextDecoder()
      .decode(parts.get(relsPart)!)
      .replace(
        '</Relationships>',
        `<Relationship Id="rId90" Type="${NS_R}/presProps" Target="presProps.xml"/></Relationships>`,
      );
    parts.set(relsPart, enc.encode(rels));
    parts.set(
      'ppt/presProps.xml',
      enc.encode(
        `<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:showPr loop="1"/></p:presentationPr>`,
      ),
    );
  }
  writeFileSync(file, zipParts(parts));
  return file;
}

/** A zip of `parts` (deflated entries, no zip64): what the hub's zip reader takes as a deck. */
export function zipParts(parts: ReadonlyMap<string, Uint8Array>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of parts) {
    const n = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    local.push(head, n, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += head.length + n.length + packed.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.size, 8);
  end.writeUInt16LE(parts.size, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** The test clips of the media decks, made by ffmpeg. */
export type ProbeMedia = Record<
  'sweep' | 'magenta' | 'motion' | 'tone' | 'music' | 'quarters' | 'poster' | 'trimPoster',
  string
>;

export function probeMedia(dir: string): ProbeMedia {
  mkdirSync(dir, { recursive: true });
  const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
  const out = (n: string) => join(dir, n);
  // A 6 s hue sweep (red to cyan) with a tone, black bars on its outer tenths (the deck crops them away):
  // the boxed autoplay clip.
  ffmpeg([
    ...[
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=640x360:r=30:d=6,hue=h=30*t,drawbox=x=0:y=0:w=64:h=360:color=black:t=fill,drawbox=x=576:y=0:w=64:h=360:color=black:t=fill',
    ],
    ...['-f', 'lavfi', '-i', 'sine=frequency=330:duration=6'],
    ...['-shortest', ...h264, '-c:a', 'aac', out('sweep.mp4')],
  ]);
  // A 5 s magenta clip: the click-start clip.
  ffmpeg([
    ...['-f', 'lavfi', '-i', 'color=c=magenta:s=640x360:r=30:d=5'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=550:duration=5'],
    ...['-shortest', ...h264, '-c:a', 'aac', out('magenta.mp4')],
  ]);
  // A 4 s blue clip with a white box moving across it and a tone the slide mutes: the motion background.
  ffmpeg([
    ...['-f', 'lavfi', '-i', 'color=c=0x0030c0:s=960x540:r=30:d=4'],
    ...['-f', 'lavfi', '-i', 'color=c=white:s=120x140:r=30:d=4'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=990:duration=4'],
    ...['-filter_complex', "[0:v][1:v]overlay=x='mod(t*240,840)':y=200[v]", '-map', '[v]', '-map', '2:a'],
    ...['-shortest', ...h264, '-c:a', 'aac', out('motion.mp4')],
  ]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-c:a', 'libmp3lame', out('tone.mp3')]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=523:duration=40', '-c:a', 'libmp3lame', out('music.mp3')]);
  // Four 1 s quarters, red, green, blue, yellow: the trimmed looping clip keeps green and blue only.
  ffmpeg([
    ...['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=1'],
    ...['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=640x360:r=30:d=1'],
    ...['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=1'],
    ...['-f', 'lavfi', '-i', 'color=c=yellow:s=640x360:r=30:d=1'],
    ...[
      '-filter_complex',
      '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]',
      '-map',
      '[v]',
      ...h264,
      out('quarters.mp4'),
    ],
  ]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff8000:s=640x360', '-frames:v', '1', out('poster.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x808080:s=640x360', '-frames:v', '1', out('trim-poster.png')]);
  return {
    sweep: out('sweep.mp4'),
    magenta: out('magenta.mp4'),
    motion: out('motion.mp4'),
    tone: out('tone.mp3'),
    music: out('music.mp3'),
    quarters: out('quarters.mp4'),
    poster: out('poster.png'),
    trimPoster: out('trim-poster.png'),
  };
}

/** The boxed clip of the media deck's first slide (EMU) and the title band over its top. */
export const BOXED = { x: 2.25 * IN, y: 1.375 * IN, cx: 7.5 * IN, cy: 3.75 * IN };
export const BOXED_ROT = 8;
export const TITLE_BAND = { x: 1.25 * IN, y: 0.875 * IN, cx: 9.5 * IN, cy: IN };

/** What the media deck's slides are (cue order when the deck is the playlist's first item). */
export const MEDIA_SLIDES = [
  'boxed',
  'click',
  'after-click',
  'motion',
  'sound',
  'hidden-in-sound',
  'sound-2',
  'sound-3',
  'after-sound',
  'not-a-clip',
  'broken-clip',
  'trimmed-loop',
] as const;

/**
 * The media probe deck (design/27 §15 M5 exit): a boxed autoplay MP4 turned, cropped and rounded under an
 * overlapping title; a click-start video; a looping muted full-slide motion background; a `numSld=3` sound
 * across shown slides with a hidden slide among them; a clip that is not a video (a `[warn]` and its poster);
 * a clip whose processing fails (its poster); a looping clip trimmed by `p14:trim`.
 */
export function mediaDeck(dir: string, m: ProbeMedia): string {
  const full = { x: 0, y: 0, cx: W, cy: H };
  const boxFull = { x: IN, y: 0.5 * IN, cx: W - 2 * IN, cy: H - IN };
  const icon = { x: W - IN, y: H - IN, cx: IN / 2, cy: IN / 2 };
  const slides: SlideSpec[] = [
    clipSlide(
      [
        {
          id: 4,
          kind: 'video',
          part: 'sweep.mp4',
          box: BOXED,
          rot: BOXED_ROT,
          srcRect: 'l="10000" r="10000"',
          geom: 'roundRect',
          timing: { start: 'auto', loop: true },
        },
      ],
      band(20, 'Welcome', TITLE_BAND),
    ),
    clipSlide([{ id: 4, kind: 'video', part: 'magenta.mp4', box: boxFull, timing: { start: 'click' } }]),
    clipSlide([], textBox(2, 'After the clip')),
    clipSlide(
      [
        {
          id: 4,
          kind: 'video',
          part: 'motion.mp4',
          box: full,
          timing: { start: 'auto', loop: true, mute: true },
        },
      ],
      textBox(20, 'Over the motion background'),
    ),
    clipSlide(
      [
        {
          id: 4,
          kind: 'audio',
          part: 'tone.mp3',
          box: icon,
          timing: { start: 'auto', numSld: 3, showWhenStopped: false },
        },
      ],
      textBox(20, 'Sound one'),
      { bg: '203040' },
    ),
    clipSlide([], textBox(2, 'Hidden among the sound'), { bg: '203040', hidden: true }),
    clipSlide([], textBox(2, 'Sound two'), { bg: '203040' }),
    clipSlide([], textBox(2, 'Sound three'), { bg: '203040' }),
    clipSlide([], textBox(2, 'After the sound'), { bg: '203040' }),
    clipSlide([{ id: 4, kind: 'video', part: 'not-a-clip.mp4', box: boxFull, timing: { start: 'auto' } }]),
    clipSlide([{ id: 4, kind: 'video', part: 'broken.mp4', box: boxFull, timing: { start: 'auto' } }]),
    clipSlide(
      [
        {
          id: 4,
          kind: 'video',
          part: 'quarters.mp4',
          box: boxFull,
          trim: { st: 1000, end: 1000 },
          timing: { start: 'auto', loop: true },
        },
      ],
      '',
      { poster: 'trim-poster.png' },
    ),
  ];
  // An MP4 header over nothing: sniffed as a video, so it is stored; its media job fails.
  const broken = new Uint8Array(4096);
  broken.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
  const media: Record<string, Uint8Array> = {
    'ppt/media/poster.png': readFileSync(m.poster),
    'ppt/media/trim-poster.png': readFileSync(m.trimPoster),
    'ppt/media/sweep.mp4': readFileSync(m.sweep),
    'ppt/media/magenta.mp4': readFileSync(m.magenta),
    'ppt/media/motion.mp4': readFileSync(m.motion),
    'ppt/media/tone.mp3': readFileSync(m.tone),
    'ppt/media/quarters.mp4': readFileSync(m.quarters),
    'ppt/media/not-a-clip.mp4': enc.encode('this is not a video at all, only text'),
    'ppt/media/broken.mp4': broken,
  };
  return zip(buildDeck({ slides, media }), join(dir, 'Probe media.pptx'));
}

/** The announcement loop's slide texts. */
export const LOOP_SLIDES = [
  'Welcome to our church',
  'Youth group on Friday',
  'Prayer meeting',
  'Coffee in the hall',
];

/**
 * A 4-slide looping announcement deck (`p:showPr loop`, every slide timed by `advTm`) whose first slide's
 * music plays across the slides (PowerPoint's "Play across slides": `numSld=999`), looping.
 */
export function loopDeck(dir: string, m: ProbeMedia, advanceMs = 2000): string {
  const icon = { x: W - IN, y: H - IN, cx: IN / 2, cy: IN / 2 };
  const transition = `<p:transition advTm="${advanceMs}"><p:fade/></p:transition>`;
  const slides = LOOP_SLIDES.map((t, i) =>
    clipSlide(
      i === 0
        ? [
            {
              id: 4,
              kind: 'audio',
              part: 'music.mp3',
              box: icon,
              timing: { start: 'auto', loop: true, numSld: 999, showWhenStopped: false },
            },
          ]
        : [],
      textBox(20, t),
      { bg: ['5B2C6F', '1A5276', '117864', '7E5109'][i], transition },
    ),
  );
  const media: Record<string, Uint8Array> = {
    'ppt/media/poster.png': readFileSync(m.poster),
    'ppt/media/music.mp3': readFileSync(m.music),
  };
  return zip(buildDeck({ slides, media }), join(dir, 'Probe loop.pptx'), true);
}

/** The lyric loop's slide texts. */
export const LYRIC_LOOP = [
  'Amazing grace, how sweet the sound',
  'That saved a wretch like me',
  'I once was lost',
];

/**
 * A worship lyric deck as some churches save it: a looping show (`p:showPr loop`) with every slide timed by
 * `advTm`, so the import makes it an announcement loop (a1-prep: the import report explains it and treats it
 * as slides in one tap).
 */
export function lyricLoopDeck(dir: string, advanceMs = 4000): string {
  mkdirSync(dir, { recursive: true });
  const slides: SlideSpec[] = LYRIC_LOOP.map((text, i) => ({
    bg: solidBg('102040'),
    shapes: sp({
      id: 2,
      x: IN,
      y: 2.5 * IN,
      cx: 11.33 * IN,
      cy: 2 * IN,
      txBox: true,
      txBody: body(para(run(text, 'sz="4400"', solid('FFFFFF')))),
      name: `Lyric ${i + 1}`,
    }),
    after: `${CLRMAP_OVR}<p:transition advTm="${advanceMs}"><p:fade/></p:transition>`,
  }));
  return zip(buildDeck({ slides }), join(dir, 'Amazing Grace.pptx'), true);
}

// ---- the line-art deck (raw XML: custom geometry past the slide's drawing budget, M9 geometry units) -------

/** EMU per inch. */
const LINE_ART_IN = 914_400;
/** The line art's path space (`a:path` w and h). */
const LINE_ART_W = 40_000;
const LINE_ART_H = 30_000;
/** Holes of a line-art path: 20 x 16 ovals, 13 points each, so the path has 4,164 points (past 4,096). */
const LINE_ART_COLS = 20;
const LINE_ART_ROWS = 16;

/** Each hole of the line art: its centre and radii in path units. */
function lineArtHoles(wall: number): { cx: number; cy: number; rx: number; ry: number }[] {
  const cw = LINE_ART_W / LINE_ART_COLS;
  const ch = LINE_ART_H / LINE_ART_ROWS;
  const out: { cx: number; cy: number; rx: number; ry: number }[] = [];
  for (let r = 0; r < LINE_ART_ROWS; r++)
    for (let c = 0; c < LINE_ART_COLS; c++)
      out.push({
        cx: Math.round((c + 0.5) * cw),
        cy: Math.round((r + 0.5) * ch),
        rx: Math.round((cw / 2) * (1 - wall) * (0.9 + 0.1 * Math.sin(r * 7 + c * 3))),
        ry: Math.round((ch / 2) * (1 - wall) * (0.9 + 0.1 * Math.cos(r * 5 + c * 11))),
      });
  return out;
}

/**
 * One `a:path` of line art (as the leaf template's: one outline holding 320 oval holes of four cubic curves each,
 * wound against it), in the line art's path space.
 */
function lineArtPathXml(wall: number, layer = 0): string {
  const pt = (x: number, y: number) => `<a:pt x="${Math.round(x)}" y="${Math.round(y)}"/>`;
  const k = 0.5523;
  let xml = `<a:path w="${LINE_ART_W}" h="${LINE_ART_H}"><a:moveTo>${pt(0, 0)}</a:moveTo>`;
  xml += `<a:lnTo>${pt(LINE_ART_W, 0)}</a:lnTo><a:lnTo>${pt(LINE_ART_W, LINE_ART_H)}</a:lnTo>`;
  xml += `<a:lnTo>${pt(0, LINE_ART_H)}</a:lnTo><a:close/>`;
  // Every layer the same outline and holes (strokes drawn over strokes, as traced line art has them), each from
  // another starting hole, so the three paths are three paths and their ink is one layer's.
  const holes = lineArtHoles(wall);
  for (let i = 0; i < holes.length; i++) {
    const { cx, cy, rx, ry } = holes[(i + layer * 107) % holes.length]!;
    const cubic = (a: [number, number], b: [number, number], c: [number, number]) =>
      `<a:cubicBezTo>${pt(...a)}${pt(...b)}${pt(...c)}</a:cubicBezTo>`;
    xml += `<a:moveTo>${pt(cx + rx, cy)}</a:moveTo>`;
    xml += cubic([cx + rx, cy - k * ry], [cx + k * rx, cy - ry], [cx, cy - ry]);
    xml += cubic([cx - k * rx, cy - ry], [cx - rx, cy - k * ry], [cx - rx, cy]);
    xml += cubic([cx - rx, cy + k * ry], [cx - k * rx, cy + ry], [cx, cy + ry]);
    xml += cubic([cx + k * rx, cy + ry], [cx + rx, cy + k * ry], [cx + rx, cy]);
    xml += '<a:close/>';
  }
  return `${xml}</a:path>`;
}

/** The share of its box the black line art inks (even-odd: the outline less its holes, ovals of π·rx·ry). */
export function lineArtInk(): number {
  const holes = lineArtHoles(LINE_ART_BLACK_WALL).reduce((a, h) => a + Math.PI * h.rx * h.ry, 0);
  return 1 - holes / (LINE_ART_W * LINE_ART_H);
}

const LINE_ART_BLACK_WALL = 0.06;

/** Where the black line art is on the slide, in logical px (16:9 at 1920 px wide). */
export const LINE_ART_BLACK_BOX = { x: 120, y: 90, w: 1680, h: 900 } as const;

/**
 * A one-slide deck of line art past the slide's drawing budget (design/27 §12-13, M9 geometry units): on a pale
 * blue background, a white and a navy line art, then a black one on top (each one custom geometry of one path of
 * 320 holes and 4,164 points). Each alone is within `GEOM_COST.geometry`; together they pass `GEOM_COST.slide`,
 * so a drawer without geometry units draws the black one as its legacy copy (a black rect at b50d486, nothing
 * once the legacy kind is a line), and with them draws it whole. No text: the comparison is about the art.
 */
export function lineArtDeck(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const px = (v: number) => Math.round((v / 1920) * 13.333 * LINE_ART_IN);
  const art = (
    id: number,
    name: string,
    box: { x: number; y: number; w: number; h: number },
    color: string,
    wall: number,
  ) =>
    sp({
      id,
      name,
      x: px(box.x),
      y: px(box.y),
      cx: px(box.w),
      cy: px(box.h),
      geom: 'none',
      fill:
        `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/>` +
        `<a:pathLst>${lineArtPathXml(wall)}${lineArtPathXml(wall, 1)}${lineArtPathXml(wall, 2)}</a:pathLst></a:custGeom>${solid(color)}`,
    });
  const shapes =
    art(2, 'White line art', { x: 860, y: 380, w: 1000, h: 650 }, 'FFFFFF', 0.08) +
    art(3, 'Navy line art', { x: 60, y: 160, w: 1000, h: 650 }, '1F3864', 0.07) +
    art(4, 'Black line art', LINE_ART_BLACK_BOX, '000000', LINE_ART_BLACK_WALL);
  return zip(buildDeck({ slides: [{ bg: solidBg('C9D9EE'), shapes }] }), join(dir, 'Line art.pptx'));
}

// ---- the crowded deck (M9 decorations, decor-render) ----------------------------------------------------

/** The crowded deck's grid: 230 squares in 10 rows of 23 under a title band, in logical px (1920 x 1080). */
export const CROWDED = { count: 230, cols: 23, x0: 30, y0: 190, pitch: 82, side: 60 } as const;

/** The colour of square `i` of the crowded deck: 230 distinct ones (hue steps, two lightnesses). */
export function crowdedColor(i: number): [number, number, number] {
  const h = (i * 137.508) % 360;
  const l = i % 2 ? 0.42 : 0.6;
  const s = 0.85;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** The centre of square `i` of the crowded deck, in logical px. */
export function crowdedCentre(i: number): [number, number] {
  const c = i % CROWDED.cols;
  const r = Math.floor(i / CROWDED.cols);
  return [
    CROWDED.x0 + c * CROWDED.pitch + CROWDED.side / 2,
    CROWDED.y0 + r * CROWDED.pitch + CROWDED.side / 2,
  ];
}

/**
 * One slide of 230 text-less squares, each its own colour (no two merge by look), bottom first, under a title:
 * past the slide budgets' 190 objects and the render clamp's 200 (design/27 §15 M9 "the steps"), so an import
 * keeps them only as decorations (`ShapeObject.decor`, in decoration files); without them the guard leaves the
 * topmost out and lists them missing. Written with the converter's raw-XML test helpers; a white background.
 */
export function crowdedDeck(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const EMU = 6_350; // EMU per logical px (12,192,000 / 1,920)
  const hex = (c: [number, number, number]) => c.map((v) => v.toString(16).padStart(2, '0')).join('');
  let shapes = '';
  for (let i = 0; i < CROWDED.count; i++) {
    const [cx, cy] = crowdedCentre(i);
    shapes += sp({
      id: 10 + i,
      x: (cx - CROWDED.side / 2) * EMU,
      y: (cy - CROWDED.side / 2) * EMU,
      cx: CROWDED.side * EMU,
      cy: CROWDED.side * EMU,
      fill: solid(hex(crowdedColor(i))),
    });
  }
  shapes += sp({
    id: 2,
    x: 60 * EMU,
    y: 30 * EMU,
    cx: 1800 * EMU,
    cy: 130 * EMU,
    txBox: true,
    txBody: body(para(run('A crowded slide', 'sz="4400"', solid('202020')))),
  });
  const parts = buildDeck({ slides: [{ shapes, bg: solidBg('FFFFFF') }] });
  const file = join(dir, 'Crowded.pptx');
  writeFileSync(file, zipParts(parts));
  return file;
}

// ---- the guard deck (M9, lo-forms) ------------------------------------------------------------------------

/** The guard deck: 24 full-slide pictures, each its own colour, past the render clamp's 16 distinct ones. */
export const GUARD = { pictures: 24, title: 'Pictures past the guard' } as const;

/** The colour of picture `i` of the guard deck (bottom first): 24 hues 15 degrees apart. */
export function guardColor(i: number): [number, number, number] {
  const h = (i * 15) % 360;
  const l = 0.5;
  const s = 0.8;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** An opaque PNG of one colour: its rows deflated in a zlib stream (header and Adler-32). */
function solidPng(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + 3 * w);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + 3 * x);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  let s1 = 1;
  let s2 = 0;
  for (const v of raw) {
    s1 = (s1 + v) % 65_521;
    s2 = (s2 + s1) % 65_521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((s2 << 16) | s1) >>> 0);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.concat([Buffer.from([0x78, 0x01]), deflateRawSync(raw), adler])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * One slide of a title over 24 distinct full-slide pictures (`GUARD`), past the render clamp's 16 distinct
 * pictures with decorations on and no picture sheets (the hub stores none), so the slide budgets' guard leaves
 * the topmost pictures out (`budget.ts` P): on a hub with LibreOffice they are its art (`budget:pictures`,
 * version 2), on one without it they are listed missing. Written with pptxgenjs; the title on top.
 */
export async function guardDeck(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const p = new pptxgen();
  p.layout = 'LAYOUT_WIDE';
  const s = p.addSlide();
  for (let i = 0; i < GUARD.pictures; i++)
    s.addImage({
      data: `data:image/png;base64,${solidPng(64, 36, guardColor(i)).toString('base64')}`,
      x: 0,
      y: 0,
      w: 13.333,
      h: 7.5,
    });
  s.addText(GUARD.title, { x: 0.5, y: 0.3, w: 12.3, h: 1, fontSize: 40, color: 'FFFFFF', bold: true });
  const file = join(dir, 'Pictures.pptx');
  writeFileSync(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  return file;
}

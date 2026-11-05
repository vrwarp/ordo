import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pptxgen from 'pptxgenjs';
import { run } from '../../../apps/hub/src/media/tools.ts';
import { dataUri, testPicture } from './png.ts';

/**
 * Synthetic decks, one per area, each slide exercising one PowerPoint feature, so a score can say which
 * feature a renderer gets wrong. Written with pptxgenjs (what PowerPoint itself writes differs in detail;
 * real decks belong in the local corpus, outside the repository). Every text is public domain: World English
 * Bible verses, the 1919 Chinese Union Version, hymn titles.
 */
type Deck = { name: string; build: (p: pptxgen, media: TestMedia) => void };

/** Test media made by ffmpeg from its own test patterns, as pptxgenjs data (`type;base64,...`). */
type TestMedia = { clip: string; poster: string; loop: string; tone: string };

async function testMedia(dir: string): Promise<TestMedia> {
  await mkdir(dir, { recursive: true });
  const ff = (args: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...args], { timeoutMs: 120_000 });
  const clip = join(dir, 'clip.mp4');
  const loop = join(dir, 'loop.mp4');
  const tone = join(dir, 'tone.mp3');
  const poster = join(dir, 'poster.png');
  const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '32'];
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3', ...h264, '-an', clip]);
  await ff([
    '-f',
    'lavfi',
    '-i',
    'gradients=size=640x360:rate=24:duration=3:speed=0.02',
    ...h264,
    '-an',
    loop,
  ]);
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', '-b:a', '48k', tone]);
  await ff(['-ss', '1', '-i', clip, '-frames:v', '1', poster]);
  const b64 = async (f: string) => (await readFile(f)).toString('base64');
  return {
    clip: `video/mp4;base64,${await b64(clip)}`,
    poster: `image/png;base64,${await b64(poster)}`,
    loop: `video/mp4;base64,${await b64(loop)}`,
    tone: `audio/mp3;base64,${await b64(tone)}`,
  };
}

const W = 13.333;
const PIC = dataUri(testPicture(640, 360));
const PIC_SQ = dataUri(testPicture(400, 400, 0.4));

function title(s: pptxgen.Slide, text: string): void {
  s.addText(text, { x: 0.4, y: 0.2, w: W - 0.8, h: 0.6, fontSize: 20, color: '666666', fontFace: 'Arial' });
}

const DECKS: Deck[] = [
  {
    name: 'typography',
    build(p) {
      p.theme = { headFontFace: 'Georgia', bodyFontFace: 'Verdana' };
      let s = p.addSlide();
      title(s, 'Theme fonts (no font named on the runs)');
      s.addText('Body text in the theme body font', { x: 0.5, y: 1.2, w: 12, h: 1, fontSize: 36 });
      s = p.addSlide();
      title(s, 'Named fonts, most of them not installed on a server');
      for (const [i, f] of [
        'Arial',
        'Tahoma',
        'Century Gothic',
        'Times New Roman',
        'Courier New',
        'Calibri',
      ].entries())
        s.addText(`${f}: The quick brown fox jumps over the lazy dog`, {
          x: 0.5,
          y: 1.1 + i * 0.95,
          w: 12.3,
          h: 0.8,
          fontSize: 28,
          fontFace: f,
        });
      s = p.addSlide();
      title(s, 'Bold, italic, underline, strike, colour');
      s.addText(
        [
          { text: 'Bold ', options: { bold: true } },
          { text: 'italic ', options: { italic: true } },
          { text: 'underlined ', options: { underline: { style: 'sng' } } },
          { text: 'struck ', options: { strike: 'sngStrike' } },
          { text: 'red', options: { color: 'C00000' } },
        ],
        { x: 0.5, y: 1.5, w: 12, h: 1.5, fontSize: 44, fontFace: 'Arial' },
      );
      s = p.addSlide();
      title(s, 'Superscript verse numbers and subscripts');
      s.addText(
        [
          { text: '18', options: { superscript: true } },
          { text: ' Now when Jesus saw great multitudes around him, ', options: { breakLine: true } },
          { text: '19', options: { superscript: true } },
          { text: ' A scribe came, and said to him, ', options: { breakLine: true } },
          { text: 'H' },
          { text: '2', options: { subscript: true } },
          { text: 'O and E = mc' },
          { text: '2', options: { superscript: true } },
        ],
        { x: 0.5, y: 1.2, w: 12, h: 3, fontSize: 36, fontFace: 'Tahoma', align: 'center' },
      );
      s = p.addSlide();
      title(s, 'Alignment and vertical anchoring');
      for (const [i, a] of (['left', 'center', 'right'] as const).entries())
        s.addText(`${a}`, {
          x: 0.5 + i * 4.2,
          y: 1.2,
          w: 4,
          h: 2.5,
          fontSize: 32,
          align: a,
          valign: 'top',
          line: { color: '999999', width: 1 },
        });
      for (const [i, v] of (['top', 'middle', 'bottom'] as const).entries())
        s.addText(`${v}`, {
          x: 0.5 + i * 4.2,
          y: 4,
          w: 4,
          h: 3,
          fontSize: 32,
          align: 'center',
          valign: v,
          line: { color: '999999', width: 1 },
        });
      s = p.addSlide();
      title(s, 'Line and paragraph spacing');
      s.addText('Line spacing 1.0\nsecond line\nthird line', {
        x: 0.5,
        y: 1.2,
        w: 4,
        h: 4,
        fontSize: 28,
        lineSpacingMultiple: 1.0,
        valign: 'top',
      });
      s.addText('Line spacing 1.5\nsecond line\nthird line', {
        x: 4.7,
        y: 1.2,
        w: 4,
        h: 4,
        fontSize: 28,
        lineSpacingMultiple: 1.5,
        valign: 'top',
      });
      s.addText('Space after 24 pt\nsecond paragraph\nthird paragraph', {
        x: 8.9,
        y: 1.2,
        w: 4,
        h: 4,
        fontSize: 28,
        paraSpaceAfter: 24,
        valign: 'top',
      });
      s = p.addSlide();
      title(s, 'Bullets and numbering');
      s.addText(
        [
          { text: 'First point', options: { bullet: true, breakLine: true } },
          { text: 'Second point', options: { bullet: true, breakLine: true } },
          { text: 'Indented', options: { bullet: true, indentLevel: 1, breakLine: true } },
          { text: 'Numbered one', options: { bullet: { type: 'number' }, breakLine: true } },
          { text: 'Numbered two', options: { bullet: { type: 'number' } } },
        ],
        { x: 0.5, y: 1.2, w: 12, h: 5, fontSize: 32, valign: 'top' },
      );
      s = p.addSlide();
      title(s, 'Letter spacing, text shadow, outline, highlight');
      s.addText('WIDE LETTER SPACING', {
        x: 0.5,
        y: 1.1,
        w: 12,
        h: 1,
        fontSize: 36,
        charSpacing: 8,
        fontFace: 'Arial',
      });
      s.background = { color: '2F3B52' };
      s.addText('WHITE WITH A DROP SHADOW', {
        x: 0.5,
        y: 2.4,
        w: 12,
        h: 1.2,
        fontSize: 44,
        bold: true,
        color: 'FFFFFF',
        fontFace: 'Arial',
        shadow: { type: 'outer', angle: 45, blur: 3, offset: 4, color: '000000', opacity: 0.8 },
      });
      s.addText('OUTLINED HEADLINE', {
        x: 0.5,
        y: 3.8,
        w: 12,
        h: 1.2,
        fontSize: 44,
        bold: true,
        color: 'FFFFFF',
        outline: { size: 1.5, color: '000000' },
        fontFace: 'Arial',
      });
      s.addText('Highlighted words', {
        x: 0.5,
        y: 5.2,
        w: 12,
        h: 1,
        fontSize: 36,
        highlight: 'FFFF00',
        color: '000000',
      });
      s = p.addSlide();
      title(s, 'Shrink text on overflow');
      s.addText(
        'This paragraph is much longer than its box and PowerPoint shrinks it to fit: Now in a large house there are not only vessels of gold and of silver, but also of wood and of clay. Some are for honor, and some for dishonor.',
        {
          x: 0.5,
          y: 1.2,
          w: 6,
          h: 2,
          fontSize: 32,
          fit: 'shrink',
          valign: 'top',
          line: { color: '999999', width: 1 },
        },
      );
      s = p.addSlide();
      title(s, 'Chinese and English in one box');
      s.addText(
        'For God so loved the world\n神愛世人\nthat he gave his one and only Son\n甚至將他的獨生子賜給他們',
        {
          x: 0.5,
          y: 1.2,
          w: 12,
          h: 5,
          fontSize: 40,
          align: 'center',
          fontFace: 'Microsoft JhengHei',
        },
      );
    },
  },
  {
    name: 'shapes',
    build(p) {
      let s = p.addSlide();
      title(s, 'Basic shapes, fills and outlines');
      s.addShape(p.ShapeType.rect, { x: 0.5, y: 1.2, w: 3, h: 2, fill: { color: '4472C4' } });
      s.addShape(p.ShapeType.roundRect, {
        x: 4,
        y: 1.2,
        w: 3,
        h: 2,
        fill: { color: 'ED7D31' },
        rectRadius: 0.4,
      });
      s.addShape(p.ShapeType.ellipse, {
        x: 7.5,
        y: 1.2,
        w: 3,
        h: 2,
        fill: { color: '70AD47' },
        line: { color: '000000', width: 3 },
      });
      s.addShape(p.ShapeType.triangle, { x: 0.5, y: 4, w: 3, h: 2.5, fill: { color: 'FFC000' } });
      s.addShape(p.ShapeType.rect, { x: 4, y: 4, w: 3, h: 2.5, fill: { color: '5B9BD5', transparency: 50 } });
      s.addShape(p.ShapeType.rect, { x: 7.5, y: 4, w: 3, h: 2.5, fill: { color: 'A5A5A5' }, rotate: 20 });
      s = p.addSlide();
      title(s, 'Lines, dashes and arrows');
      s.addShape(p.ShapeType.line, { x: 0.5, y: 1.5, w: 12, h: 0, line: { color: '000000', width: 2 } });
      s.addShape(p.ShapeType.line, {
        x: 0.5,
        y: 2.5,
        w: 12,
        h: 0,
        line: { color: 'C00000', width: 4, dashType: 'dash' },
      });
      s.addShape(p.ShapeType.line, {
        x: 0.5,
        y: 3.5,
        w: 12,
        h: 0,
        line: { color: '0070C0', width: 3, endArrowType: 'triangle', beginArrowType: 'oval' },
      });
      s.addShape(p.ShapeType.line, { x: 0.5, y: 4.5, w: 6, h: 2, line: { color: '00B050', width: 3 } });
      s = p.addSlide();
      title(s, 'Text in shapes');
      s.addText('Centred in a rounded box', {
        shape: p.ShapeType.roundRect,
        x: 1,
        y: 1.5,
        w: 5,
        h: 2.5,
        fill: { color: '203864' },
        color: 'FFFFFF',
        fontSize: 28,
        align: 'center',
        valign: 'middle',
        rectRadius: 0.3,
      });
      s.addText('In an ellipse', {
        shape: p.ShapeType.ellipse,
        x: 7,
        y: 1.5,
        w: 5,
        h: 2.5,
        fill: { color: 'C55A11' },
        color: 'FFFFFF',
        fontSize: 28,
        align: 'center',
      });
    },
  },
  {
    name: 'pictures',
    build(p) {
      let s = p.addSlide();
      title(s, 'Picture stretched, kept in proportion, cropped');
      s.addImage({ data: PIC, x: 0.5, y: 1.2, w: 4, h: 4 });
      s.addImage({ data: PIC, x: 4.7, y: 1.2, w: 4, h: 4, sizing: { type: 'contain', w: 4, h: 4 } });
      s.addImage({ data: PIC, x: 8.9, y: 1.2, w: 4, h: 4, sizing: { type: 'cover', w: 4, h: 4 } });
      s = p.addSlide();
      title(s, 'Round picture, transparent picture, rotated picture');
      s.addImage({ data: PIC_SQ, x: 0.5, y: 1.2, w: 4, h: 4, rounding: true });
      s.addImage({ data: PIC, x: 4.7, y: 1.2, w: 4, h: 2.25, transparency: 50 });
      s.addImage({ data: PIC, x: 8.9, y: 1.5, w: 4, h: 2.25, rotate: 15 });
      s = p.addSlide();
      s.background = { data: PIC };
      s.addText('Text over a background picture', {
        x: 0.5,
        y: 2.5,
        w: 12.3,
        h: 2,
        fontSize: 54,
        bold: true,
        color: 'FFFFFF',
        align: 'center',
      });
    },
  },
  {
    name: 'tables-charts',
    build(p) {
      let s = p.addSlide();
      title(s, 'A table with borders, fills and merged cells');
      s.addTable(
        [
          [
            { text: 'Song', options: { bold: true, fill: { color: '203864' }, color: 'FFFFFF' } },
            { text: 'Key', options: { bold: true, fill: { color: '203864' }, color: 'FFFFFF' } },
            { text: 'Leader', options: { bold: true, fill: { color: '203864' }, color: 'FFFFFF' } },
          ],
          [{ text: 'Amazing Grace' }, { text: 'G' }, { text: 'Sam' }],
          [{ text: 'How Great Thou Art' }, { text: 'Bb' }, { text: 'Lee' }],
          [
            {
              text: 'Offering and announcements',
              options: { colspan: 3, align: 'center', fill: { color: 'F2F2F2' } },
            },
          ],
        ],
        { x: 0.8, y: 1.3, w: 11.5, fontSize: 24, border: { type: 'solid', pt: 1, color: '7F7F7F' } },
      );
      s = p.addSlide();
      title(s, 'Bar and pie charts');
      s.addChart(
        p.ChartType.bar,
        [{ name: 'Attendance', labels: ['Jan', 'Feb', 'Mar', 'Apr'], values: [120, 135, 128, 150] }],
        { x: 0.5, y: 1.2, w: 6, h: 5 },
      );
      s.addChart(
        p.ChartType.pie,
        [{ name: 'Giving', labels: ['General', 'Missions', 'Building'], values: [60, 25, 15] }],
        {
          x: 6.8,
          y: 1.2,
          w: 6,
          h: 5,
          showPercent: true,
        },
      );
    },
  },
  {
    // Slide pictures of media: a stopped video shows its poster; nothing of a player belongs in them.
    name: 'media',
    build(p, m) {
      let s = p.addSlide();
      title(s, 'Embedded video with a poster frame');
      s.addMedia({ type: 'video', data: m.clip, cover: m.poster, x: 1.7, y: 1.2, w: 9.9, h: 5.6 });
      s = p.addSlide();
      s.addMedia({ type: 'video', data: m.loop, x: 0, y: 0, w: W, h: 7.5 });
      s.addText('Amazing grace! how sweet the sound,\nThat saved a wretch like me!', {
        x: 0.8,
        y: 2.5,
        w: W - 1.6,
        h: 2.5,
        fontSize: 40,
        bold: true,
        color: 'FFFFFF',
        align: 'center',
        fontFace: 'Arial',
      });
      s = p.addSlide();
      title(s, 'Embedded audio');
      s.addMedia({ type: 'audio', data: m.tone, x: 6.2, y: 3.3, w: 1, h: 1 });
      s = p.addSlide();
      title(s, 'Linked online video (no network: its placeholder)');
      s.addMedia({
        type: 'online',
        link: 'https://www.youtube.com/embed/aqz-KE-bpKQ',
        x: 1.7,
        y: 1.2,
        w: 9.9,
        h: 5.6,
      });
    },
  },
];

/** Write the synthetic decks into `dir`; returns their paths. */
export async function buildCorpus(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const out: string[] = [];
  const media = await testMedia(join(dir, 'media'));
  for (const d of DECKS) {
    const p = new pptxgen();
    p.layout = 'LAYOUT_WIDE';
    d.build(p, media);
    const file = join(dir, `corpus-${d.name}.pptx`);
    await writeFile(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
    out.push(file);
  }
  return out;
}

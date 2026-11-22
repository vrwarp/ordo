import { describe, expect, it } from 'vitest';
import {
  body,
  buildDeck,
  denseDeckParts,
  imageRel,
  para,
  pic,
  run,
  solid,
  sp,
} from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import {
  assemblePptxScene,
  CONVERTER_VERSION,
  importPptxClient,
  LOOP_IMPORT_NOTE,
  parsePptxScene,
} from './pptx-client.ts';
import { WHOLE_BACKGROUND_ANCHORS } from './pptx-core.ts';
import { pictureGuardDeck } from './pptx-guard.test-util.ts';
import { remapMediaIds } from './remap.ts';
import { zipDeclared } from './zip-declared.test-util.ts';

const IN = 914_400;
const CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

// Minimal 1x1 transparent PNG
const PNG_1X1_ALPHA = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

async function makeDeck(shapes: string[] = []): Promise<Uint8Array> {
  const parts = buildDeck({
    slides: [
      {
        shapes: shapes.length
          ? shapes.join('\n')
          : sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('336699') }),
      },
    ],
  });
  const z = new JSZip();
  for (const [k, v] of parts) z.file(k, v);
  return z.generateAsync({ type: 'uint8array' });
}

describe('importPptxClient', () => {
  it('imports a synthetic pptx into an editable presentation on the client', async () => {
    const bytes = await makeDeck();
    const result = await importPptxClient(bytes, 'test.pptx');

    expect(result.presentation.title).toBe('test');
    expect(result.presentation.sections.length).toBe(1);
    expect(result.presentation.sections[0]!.slides.length).toBe(1);
    const slide = result.presentation.sections[0]!.slides[0]!;
    expect(slide.pptx?.class).toBe('native');
    expect(slide.objects.length).toBeGreaterThan(0);
    expect(result.classes).toEqual(['native']);
    expect(result.deckHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.loSlides.length).toBe(0);
    expect(result.clientScene.version).toBe(CONVERTER_VERSION);
    // 3 since Q24.b: the converter keeps a heavy slide whole and the import writes its pre-render record.
    expect(CONVERTER_VERSION).toBe(3);
    expect(result.clientScene.libreoffice).toBeUndefined();
    expect(result.clientScene.slides.length).toBe(1);
  });

  it('parses for a hub without LibreOffice as the hub does (M9): nothing pending, what is not drawn listed', async () => {
    const chart =
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart 9"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${4 * IN}" y="${IN}"/><a:ext cx="${3 * IN}" cy="${2 * IN}"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="${CHART}"/></a:graphic></p:graphicFrame>`;
    const bytes = await makeDeck([
      sp({ id: 4, x: IN, y: IN, cx: 4 * IN, cy: IN, txBody: body(para(run('Hybrid Slide'))) }),
      chart,
    ]);
    const withLo = await importPptxClient(bytes, 'chart.pptx');
    expect(withLo.classes).toEqual(['hybrid']);
    expect(withLo.pending).toBe(1);

    const lite = await importPptxClient(bytes, 'chart.pptx', { libreoffice: false });
    expect(lite.clientScene.libreoffice).toBe(false);
    expect(lite.clientScene.slides[0]!.art).toBeUndefined();
    expect(lite.clientScene.slides[0]!.missing?.length).toBeGreaterThan(0);
    expect(lite.pending).toBe(0);
    expect(lite.loSlides).toEqual([]);
    const slide = lite.presentation.sections[0]!.slides[0]!;
    expect(slide.pptx?.class).toBe('hybrid');
    expect(slide.pptx?.pending).toBeUndefined();
    expect(slide.pptx?.missing).toEqual(lite.clientScene.slides[0]!.missing);
    expect(slide.objects.some((o) => o.type === 'text' && o.text === 'Hybrid Slide')).toBe(true);
  });

  it("gives the guard's left-outs to LibreOffice's art with it, and lists them without it (lo-forms)", async () => {
    const z = new JSZip();
    for (const [k, v] of pictureGuardDeck()) z.file(k, v);
    const bytes = await z.generateAsync({ type: 'uint8array' });
    const withLo = await importPptxClient(bytes, 'pictures.pptx');
    const s = withLo.presentation.sections[0]!.slides[0]!;
    // 15 pictures drawn and LibreOffice's art for the five topmost; nothing listed, the slide waits for it.
    expect(s.objects.filter((o) => o.type === 'image')).toHaveLength(15);
    expect(s.pptx).toMatchObject({ class: 'hybrid', pending: true });
    expect(s.pptx?.missing).toBeUndefined();
    expect(withLo.loSlides[0]?.art?.elements).toHaveLength(5);
    const lite = await importPptxClient(bytes, 'pictures.pptx', { libreoffice: false });
    const t = lite.presentation.sections[0]!.slides[0]!;
    expect(t.objects.filter((o) => o.type === 'image')).toHaveLength(16);
    expect(t.pptx).toMatchObject({ class: 'hybrid', missing: ['decoration'] });
    expect(t.pptx?.pending).toBeUndefined();
    expect(lite.loSlides).toEqual([]);
  });

  it('extracts embedded pictures with remappable placeholders and plans loSlides for hybrid slides', async () => {
    const chartFrame =
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart 9"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${4 * IN}" y="${IN}"/><a:ext cx="${3 * IN}" cy="${2 * IN}"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="${CHART}"/></a:graphic></p:graphicFrame>`;
    const parts = buildDeck({
      slides: [
        {
          shapes: [
            sp({ id: 2, x: IN, y: IN, cx: 4 * IN, cy: IN, txBody: body(para(run('Editable Title'))) }),
            pic({ id: 3, x: IN, y: 2 * IN, cx: 2 * IN, cy: 2 * IN, rId: 'rId2' }),
          ].join(''),
          rels: [imageRel('rId2', '../media/image1.png')],
        },
        {
          shapes: [
            sp({ id: 4, x: IN, y: IN, cx: 4 * IN, cy: IN, txBody: body(para(run('Hybrid Slide'))) }),
            chartFrame,
          ].join(''),
        },
      ],
      media: { 'ppt/media/image1.png': PNG_1X1_ALPHA },
    });
    const z = new JSZip();
    for (const [k, v] of parts) z.file(k, v);
    const bytes = await z.generateAsync({ type: 'uint8array' });

    const result = await importPptxClient(bytes, 'deck-with-media.pptx');
    expect(result.classes).toEqual(['native', 'hybrid']);
    expect(result.pictures.size).toBe(1);
    const picEntry = result.pictures.get('ppt/media/image1.png')!;
    expect(picEntry).toBeDefined();
    expect(picEntry.key).toBe('pptxmedia:0');
    expect(picEntry.width).toBe(1);
    expect(picEntry.height).toBe(1);
    expect(picEntry.hasAlpha).toBe(true);

    // Remapping via remapMediaIds replaces pptxmedia:0 with stored media ID
    const remapped = remapMediaIds(result.presentation, new Map([[picEntry.key, 'stored-media-1']]));
    const slide1 = remapped.sections[0]!.slides[0]!;
    const imgObj = slide1.objects.find((o) => o.type === 'image');
    expect(imgObj?.type === 'image' && imgObj.mediaId).toBe('stored-media-1');

    // Hybrid slide generates loSlides entry for LibreOffice / demo fallback
    expect(result.loSlides).toHaveLength(1);
    expect(result.loSlides[0]!.class).toBe('hybrid');
    expect(result.loSlides[0]!.art).toBeDefined();
    expect(result.pending).toBe(1);
  });
});

describe('heavy slides kept whole in the browser parse (Q24.b, step 5)', () => {
  const zipped = async (parts: Map<string, Uint8Array>) => {
    const z = new JSZip();
    for (const [k, v] of parts) z.file(k, v);
    return z.generateAsync({ type: 'uint8array' });
  };
  const images = (s: { objects: readonly { type: string }[] }) => s.objects.filter((o) => o.type === 'image');
  const keysOf = (o: object) => Object.keys(o).sort();

  it('writes wholeSlides: true into the scene only when the option is on (the libreoffice pattern)', async () => {
    const bytes = await makeDeck();
    const off = (await parsePptxScene(bytes)).scene;
    const falsy = (await parsePptxScene(bytes, { wholeSlides: false })).scene;
    const on = (await parsePptxScene(bytes, { wholeSlides: true })).scene;
    expect(keysOf(off)).not.toContain('wholeSlides');
    expect(keysOf(falsy)).not.toContain('wholeSlides');
    expect(on.wholeSlides).toBe(true);
    // Nothing else of the scene's head moves with it for a deck that has nothing heavy.
    const { wholeSlides: _, ...rest } = on;
    expect(rest).toEqual(off);
  });

  it('keeps a slide of 400 pictures whole when asked, the guard\u2019s 15 (16 without LibreOffice) when not (the converter option reaches convertDeck)', async () => {
    const bytes = await zipped(pictureGuardDeck(400));
    const base = (await parsePptxScene(bytes)).scene.slides[0]!.slide;
    const lite = (await parsePptxScene(bytes, { libreoffice: false })).scene.slides[0]!.slide;
    const whole = (await parsePptxScene(bytes, { wholeSlides: true })).scene.slides[0]!.slide;
    const wholeLite = (await parsePptxScene(bytes, { wholeSlides: true, libreoffice: false })).scene
      .slides[0]!.slide;
    expect(images(base)).toHaveLength(15);
    expect(images(lite)).toHaveLength(16);
    expect(images(whole)).toHaveLength(400);
    expect(images(wholeLite)).toHaveLength(400);
  });

  it('builds the record and counts the slide: the assembly reads the scene, not the options of the call', async () => {
    const bytes = await zipped(pictureGuardDeck(24));
    const on = await importPptxClient(bytes, 'pictures.pptx', { wholeSlides: true });
    const s = on.presentation.sections[0]!.slides[0]!;
    // All 24 pictures, no art waiting for LibreOffice, and the record (the slide is stored inline: no file).
    expect(images(s)).toHaveLength(24);
    expect(s.pptx).toMatchObject({ class: 'native' });
    expect(s.pptx?.pending).toBeUndefined();
    expect(on.loSlides).toEqual([]);
    expect(s.prerender?.why.length).toBeGreaterThan(0);
    expect(s.prerender?.live).toEqual([]);
    expect(keysOf(s.prerender!)).toEqual(['live', 'why']);
    expect(on.whole).toBe(1);
    expect(on.log.join('\n')).toMatch(/1 slide is very detailed and was kept whole/);
    expect(on.clientScene.wholeSlides).toBe(true);
    // The same scene assembled apart from its parse is the same import (ids aside).
    const parse = await parsePptxScene(bytes, { wholeSlides: true });
    const apart = await assemblePptxScene(parse, bytes, { fileName: 'pictures.pptx' });
    expect(apart.whole).toBe(1);
    expect(images(apart.presentation.sections[0]!.slides[0]!)).toHaveLength(24);
    // A scene that does not say it was parsed whole is assembled by the plan of before, whatever the caller meant.
    const plain = await parsePptxScene(bytes);
    const base = await assemblePptxScene(plain, bytes, { fileName: 'pictures.pptx' });
    expect(base.whole).toBe(0);
    expect(base.presentation.sections[0]!.slides[0]!.prerender).toBeUndefined();
    expect(base.log.join('\n')).not.toMatch(/kept whole/);
  });

  it('keeps the base plan for a caller that passes no option (T6): nothing recorded, 15 pictures and the art', async () => {
    const bytes = await zipped(pictureGuardDeck(24));
    const base = await importPptxClient(bytes, 'pictures.pptx');
    const s = base.presentation.sections[0]!.slides[0]!;
    expect(images(s)).toHaveLength(15);
    expect(s.pptx).toMatchObject({ class: 'hybrid', pending: true });
    expect(s.prerender).toBeUndefined();
    expect(base.whole).toBe(0);
    expect(base.clientScene).not.toHaveProperty('wholeSlides');
  });

  it('uses the decided anchor answer: a video background keeps a slide out, a picture background does not (Q25.c.b)', () => {
    expect(WHOLE_BACKGROUND_ANCHORS).toBe('motion');
  });
});

describe('a looping PowerPoint show with every slide timed (the client path)', () => {
  it('reads a slide part of 12 MiB and lists one of 33 MiB as left out, with the 32 MB it says (design/29 B5)', async () => {
    const zip = async (parts: Map<string, Uint8Array>) => {
      const z = new JSZip();
      for (const [k, v] of parts) z.file(k, v);
      return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    };
    // 12 MiB of traced artwork: read (the base listed it as over 8 MB), objects and no oversized part.
    const dense = denseDeckParts({ shapes: 150, points: 1800 });
    expect(dense.get('ppt/slides/slide1.xml')!.length).toBeGreaterThan(9 * 1024 * 1024);
    const read = await importPptxClient(await zip(dense), 'dense.pptx');
    expect(read.clientScene.oversized).toEqual([]);
    expect(read.presentation.sections[0]!.slides[0]!.objects.length).toBeGreaterThan(100);
    // 33 MiB of text in one box: past the part cap, listed, said in the import log in the cap's own number.
    const huge = buildDeck({
      slides: [
        {
          shapes: sp({
            id: 2,
            x: 0,
            y: 0,
            cx: IN,
            cy: IN,
            txBody: body(para(run('x'.repeat(33 * 1024 * 1024)))),
          }),
        },
      ],
    });
    const left = await importPptxClient(await zip(huge), 'huge.pptx');
    expect(left.clientScene.oversized).toEqual(['ppt/slides/slide1.xml']);
    expect(left.log.join('\n')).toContain('ppt/slides/slide1.xml is over 32 MB: not read');
  });

  it('refuses a deck that declares more than 64 MiB of XML from its directory, before reading a part (the hub takes it then)', async () => {
    // Four entries of 20 MiB (each within the part cap) whose bytes are garbage: the refusal comes from the sum of the declared
    // sizes; a reader that inflated the first entry would fail with an inflate error instead.
    const entries = Array.from({ length: 4 }, (_, i) => ({
      name: `ppt/slides/slide${i + 1}.xml`,
      declared: 20 * 1024 * 1024,
    }));
    await expect(parsePptxScene(zipDeclared(entries))).rejects.toThrow(
      'The deck holds more than 64 MB of slide XML',
    );
    // Parts left out for their size (past the part cap) and pictures are not in the total.
    const left = [
      { name: 'ppt/slides/slide1.xml', declared: 40 * 1024 * 1024 },
      { name: 'ppt/slides/slide2.xml', declared: 40 * 1024 * 1024 },
      { name: 'ppt/media/image1.png', declared: 400 * 1024 * 1024 },
    ];
    await expect(parsePptxScene(zipDeclared(left))).rejects.not.toThrow(
      'The deck holds more than 64 MB of slide XML',
    );
  });

  it('says a slide past the reader\u2019s bounds in the import log, as the hub does (W9)', async () => {
    const parts = buildDeck({
      slides: [
        {
          shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('336699') }) + '<a:b/>'.repeat(500_001),
        },
      ],
    });
    const z = new JSZip();
    for (const [k, v] of parts) z.file(k, v);
    const r = await importPptxClient(
      await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
      'heavy.pptx',
    );
    const line =
      'Slide 1 has too much drawing detail for ordo to read, so only its text was imported. In PowerPoint, save the artwork as a picture and import again.';
    expect(r.log.filter((l) => l.includes(line))).toHaveLength(1);
  });

  it('imports an announcement loop and says so in the import log, as the hub does', async () => {
    const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const timed = (text: string) => ({
      shapes: sp({ id: 2, x: IN, y: IN, cx: 6 * IN, cy: IN, txBody: body(para(run(text))) }),
      after: '<p:transition advTm="5000"><p:fade/></p:transition>',
    });
    const parts = buildDeck({ slides: [timed('Amazing grace'), timed('How sweet the sound')] });
    const enc = new TextEncoder();
    const rels = new TextDecoder()
      .decode(parts.get('ppt/_rels/presentation.xml.rels')!)
      .replace(
        '</Relationships>',
        `<Relationship Id="rId90" Type="${NS_R}/presProps" Target="presProps.xml"/></Relationships>`,
      );
    parts.set('ppt/_rels/presentation.xml.rels', enc.encode(rels));
    parts.set(
      'ppt/presProps.xml',
      enc.encode(
        '<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' +
          NS_R +
          '" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:showPr loop="1"/></p:presentationPr>',
      ),
    );
    const z = new JSZip();
    for (const [k, v] of parts) z.file(k, v);
    const result = await importPptxClient(await z.generateAsync({ type: 'uint8array' }), 'Grace.pptx');
    expect(result.presentation.kind).toBe('loop');
    expect(result.presentation.loop).toEqual({ defaultSlideMs: 5000 });
    expect(result.presentation.source?.log).toContain(LOOP_IMPORT_NOTE);
  });
});

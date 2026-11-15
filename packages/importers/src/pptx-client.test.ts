import { describe, expect, it } from 'vitest';
import { body, buildDeck, imageRel, para, pic, run, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { CONVERTER_VERSION, importPptxClient, LOOP_IMPORT_NOTE } from './pptx-client.ts';
import { pictureGuardDeck } from './pptx-guard.test-util.ts';
import { remapMediaIds } from './remap.ts';

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
    expect(CONVERTER_VERSION).toBe(2);
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

describe('a looping PowerPoint show with every slide timed (the client path)', () => {
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

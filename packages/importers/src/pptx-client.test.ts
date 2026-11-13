import { describe, expect, it } from 'vitest';
import { body, buildDeck, imageRel, para, pic, run, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { CONVERTER_VERSION, importPptxClient } from './pptx-client.ts';
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

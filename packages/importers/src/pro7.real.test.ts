import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importPro7, PRO7_MEDIA_PREFIX, readZip } from './index.ts';

/**
 * Files ProPresenter 7 wrote (test-fixtures/pro7/NOTICE.md says where each came from). The other pro7
 * tests encode documents with the vendored schema, which proves the reader against our own writing; these
 * prove it against ProPresenter's.
 */
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'pro7');
const bytes = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));
const text = (o: { type: string }): string =>
  o.type === 'text' ? (o as unknown as { text: string }).text : '';

describe('files written by ProPresenter 7', () => {
  it('a bundle exported by ProPresenter keeps its background picture', async () => {
    const files = await readZip(bytes('RestBildExportFromPP.probundle'));
    expect([...files.keys()].sort()).toEqual(['Media/sample-media.png', 'TestBild.pro']);
    const r = importPro7(files);
    expect(r.log.filter((l) => l.level !== 'info')).toEqual([]);
    const [p] = r.presentations;
    expect(p).toMatchObject({
      id: 'pro7-8e1b9f20-19d7-45ec-a81f-1f9abb3979f7',
      title: 'TestBild',
      kind: 'song',
    });
    // The one media action is an image, although ProPresenter writes an empty `audio` playback block on it.
    const key = `${PRO7_MEDIA_PREFIX}Library/Application Support/RenewedVision/ProPresenter/Sample/Media/sample-media.png`;
    expect(p!.backgroundMediaId).toBe(key);
    expect(r.media).toEqual([{ key, path: 'Media/sample-media.png', background: true }]);
    // The empty chord-chart URL every ProPresenter document carries is not reported.
    expect(r.log.map((l) => l.message).join('\n')).not.toMatch(/chord charts|audio cues/);
  });

  it('a playlist export: two embedded songs, arrangements found by name, header and placeholder noted', async () => {
    const r = importPro7(await readZip(bytes('TestPlaylist.proplaylist')));
    expect(r.presentations.map((p) => p.title)).toEqual(['Embedded Song One', 'Embedded Song Two']);
    expect(r.playlists).toHaveLength(1);
    const [pl] = r.playlists;
    expect(pl!.name).toBe('TestPlaylist');
    const items = pl!.items.map((i) =>
      i.kind === 'presentation' ? [i.presentationId, i.arrangementId] : [i.kind],
    );
    const [one, two] = r.presentations;
    // The items' arrangement UUIDs do not match the documents; `arrangement_name` ("normal", "short") does.
    expect(items).toEqual([
      [one!.id, one!.arrangements.find((a) => a.name === 'normal')!.id],
      [two!.id, two!.arrangements.find((a) => a.name === 'short')!.id],
    ]);
    const msgs = r.log.map((l) => l.message);
    expect(msgs).toContain('playlist "TestPlaylist": header "Songs" before item 1 not imported');
    expect(msgs).toContain('playlist "TestPlaylist": skipped placeholders (1)');
    expect(text(one!.sections[0]!.slides[0]!.objects[0]!)).toBe(
      'First song verse line one\nFirst song verse line two',
    );
  });

  it('RTF with Windows-1252 escapes on one line and raw UTF-8 on the next', () => {
    const r = importPro7(new Map([['Café Über Test.pro', bytes('Café Über Test.pro')]]));
    const [p] = r.presentations;
    expect(p!.title).toBe('Café Über Test');
    expect(text(p!.sections[0]!.slides[0]!.objects[0]!)).toBe(
      'Zeile mit Umlauten: ä ö ü ß\nWeitere Zeile: é è à',
    );
  });

  it('a song ProPresenter 7.9 saved: order, caps, outline, gradient, credits', () => {
    const r = importPro7(new Map([['Rock Of Ages (Toplady).pro', bytes('Rock Of Ages (Toplady).pro')]]));
    const [p] = r.presentations;
    expect(p).toMatchObject({
      id: 'pro7-0f03246a-8154-438e-ac94-98b96a4b7a63',
      title: 'Rock Of Ages (Toplady)',
      kind: 'song',
      meta: { ccli: '40588', author: 'Augustus Montague Toplady, Thomas Hastings' },
    });
    // The cues are stored out of group order; slides follow the groups.
    expect(p!.sections.map((s) => [s.label, s.slides.length])).toEqual([
      ['Verse 1', 3],
      ['Verse 2', 3],
      ['Verse 3', 3],
      ['Verse 4', 3],
    ]);
    // The element has textLineMask (LINE_MASK_STYLE_MAX_LINE_WIDTH) with a 315° (45° CW) gradient fill.
    const [first] = p!.sections[0]!.slides[0]!.objects;
    expect(p!.sections[0]!.slides[0]!.objects).toHaveLength(1);
    if (!first) throw new Error('no text');
    expect(first.type).toBe('text');
    if (first.type !== 'text') return;
    // ALL CAPS is a transform; the words keep their casing.
    expect(first.text).toBe('Rock of Ages cleft for me\nLet me hide myself in thee');
    expect(first.style).toMatchObject({
      fontFamily: 'Century Gothic',
      fontSizePx: 67,
      transform: 'uppercase',
      align: 'center',
      valign: 'top',
      padding: 0,
      insets: { l: 5, t: 20, r: 5, b: 0 },
      // strokeWidth -3 is 3% of the font size, as Cocoa stores it.
      outline: { width: 2, color: { r: 0, g: 0, b: 0, a: 1 } },
      lineMask: {
        style: 'maxLineWidth',
        heightOffsetPx: -8,
        widthOffsetPx: 97,
        fill: { r: 88, g: 13, b: 114, a: 1 },
        gradient: {
          kind: 'linear',
          angle: 45,
          stops: [
            { at: 0, color: { r: 88, g: 13, b: 114, a: 1 } },
            { at: 1, color: { r: 252, g: 16, b: 26, a: 1 } },
          ],
        },
      },
    });
    expect(first.style.fill).toBeUndefined();
    expect(first.box).toEqual({ x: 0, y: 409.76, w: 1920, h: 207.52, rotation: 0 });
    // The visibility link on every box is not "linked text"; nothing else is reported for this song.
    const msgs = r.log.map((l) => l.message);
    expect(msgs.filter((m) => /skipped|approx/.test(m))).toEqual([]);
    expect(p!.sections.flatMap((s) => s.slides)).toHaveLength(12);
  });
});

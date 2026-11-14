import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { importPro7, PRO7_MEDIA_PREFIX, readZip, remapMediaIds } from './index.ts';
import { pro7Type } from './proto.ts';

const enc = new TextEncoder();

function rtf(
  text: string,
  opts: { font?: string; fs?: number; rgb?: [number, number, number] } = {},
): Uint8Array {
  const [r, g, b] = opts.rgb ?? [255, 255, 255];
  const body = text
    .split('\n')
    .map((l) =>
      l.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/[^ -~\n]/g, (c) => `\\uc0\\u${c.charCodeAt(0)} `),
    )
    .join('\\\n');
  return enc.encode(
    `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639\n{\\fonttbl\\f0\\fnil\\fcharset0 ${opts.font ?? 'HelveticaNeue-Bold'};}\n` +
      `{\\colortbl;\\red255\\green255\\blue255;\\red${r}\\green${g}\\blue${b};}\n` +
      `{\\*\\expandedcolortbl;;\\csgenericrgb\\c100000\\c100000\\c100000;}\n` +
      `\\pard\\pardeftab1680\\qc\\partightenfactor0\n\n\\f0\\fs${opts.fs ?? 160} \\cf2 ${body}}`,
  );
}

const uuid = (s: string) => ({ string: s });

let n = 0;
function textCue(id: string, text: string, size = { width: 1920, height: 1080 }) {
  n++;
  return {
    uuid: uuid(id),
    name: '',
    isEnabled: true,
    actions: [
      {
        uuid: uuid(`A-${id}`),
        type: 'ACTION_TYPE_PRESENTATION_SLIDE',
        isEnabled: true,
        slide: {
          presentation: {
            baseSlide: {
              size,
              uuid: uuid(`S-${id}`),
              elements: [
                {
                  element: {
                    uuid: uuid(`E-${id}`),
                    name: 'Lyrics',
                    bounds: { origin: { x: 100, y: 150 }, size: { width: 1720, height: 780 } },
                    opacity: 1,
                    text: { rtfData: rtf(text), verticalAlignment: 'VERTICAL_ALIGNMENT_MIDDLE' },
                  },
                  ...(n === 2 ? { buildIn: { uuid: uuid('B1'), start: 'START_ON_CLICK' } } : {}),
                },
              ],
            },
          },
        },
      },
    ],
  };
}

function mediaAction(
  path: string,
  layer: 'LAYER_TYPE_BACKGROUND' | 'LAYER_TYPE_FOREGROUND' = 'LAYER_TYPE_BACKGROUND',
) {
  return {
    uuid: uuid(`M-${path}`),
    type: 'ACTION_TYPE_MEDIA',
    isEnabled: true,
    media: {
      layerType: layer,
      element: {
        uuid: uuid(`ME-${path}`),
        url: {
          absoluteString: `file:///Users/worship/Documents/ProPresenter/Media/${encodeURI(path)}`,
          platform: 'PLATFORM_MACOS',
          local: { root: 'ROOT_USER_DOCUMENTS', path: `ProPresenter/Media/${path}` },
        },
        ...(/\.(mp4|mov|webm)$/i.test(path) ? { video: {} } : { image: {} }),
      },
      // As ProPresenter writes it: a picture action carries an empty `audio` playback block.
      ...(/\.(mp4|mov|webm)$/i.test(path)
        ? { video: { playbackBehavior: 'PLAYBACK_BEHAVIOR_LOOP' } }
        : { audio: {} }),
    },
  };
}

function encodePresentation(obj: Record<string, unknown>): Uint8Array {
  const T = pro7Type('rv.data.Presentation');
  const err = T.verify(T.fromObject(obj));
  if (err) throw new Error(err);
  return T.encode(T.fromObject(obj)).finish();
}

function amazingGrace(): Uint8Array {
  n = 0;
  const v1a = textCue('C-1', 'Amazing grace, how sweet the sound\nThat saved a wretch like me');
  const v1b = textCue('C-2', 'I once was lost, but now am found\nWas blind but now I see');
  const ch = textCue('C-3', '’Twas grace that taught my heart to fear');
  // First slide also starts a looping background video; the third slide fires a macro.
  (v1a.actions as unknown[]).push(mediaAction('Motion Backgrounds/Blue Waves.mp4'));
  (ch.actions as unknown[]).push({
    uuid: uuid('MAC'),
    type: 'ACTION_TYPE_MACRO',
    isEnabled: true,
    macro: {},
  });
  const blank = {
    uuid: uuid('C-4'),
    isEnabled: true,
    actions: [
      {
        uuid: uuid('A-4'),
        type: 'ACTION_TYPE_PRESENTATION_SLIDE',
        slide: { presentation: { baseSlide: { size: { width: 1920, height: 1080 }, elements: [] } } },
      },
    ],
  };
  return encodePresentation({
    applicationInfo: { platform: 'PLATFORM_MACOS', application: 'APPLICATION_PROPRESENTER' },
    uuid: uuid('P-GRACE'),
    name: 'Amazing Grace',
    category: 'Hymns',
    selectedArrangement: uuid('ARR-2'),
    cues: [v1a, v1b, ch, blank],
    cueGroups: [
      {
        group: { uuid: uuid('G-V1'), name: 'Verse 1', color: { red: 0, green: 0, blue: 1, alpha: 1 } },
        cueIdentifiers: [uuid('C-1'), uuid('C-2')],
      },
      { group: { uuid: uuid('G-C'), name: 'Chorus' }, cueIdentifiers: [uuid('C-3')] },
      { group: { uuid: uuid('G-BL'), name: 'Blank Slide' }, cueIdentifiers: [uuid('C-4')] },
    ],
    arrangements: [
      { uuid: uuid('ARR-1'), name: 'Short', groupIdentifiers: [uuid('G-V1'), uuid('G-C')] },
      {
        uuid: uuid('ARR-2'),
        name: 'Full',
        groupIdentifiers: [uuid('G-V1'), uuid('G-C'), uuid('G-V1'), uuid('G-C'), uuid('G-BL')],
      },
    ],
    ccli: {
      author: 'John Newton',
      songTitle: 'Amazing Grace',
      publisher: 'Public Domain',
      copyrightYear: 1779,
      songNumber: 22025,
    },
    timeline: { duration: 10, cues: [{ triggerTime: 1, cueId: uuid('C-1') }] },
  });
}

function announcements(): Uint8Array {
  const cue = {
    uuid: uuid('AN-1'),
    actions: [
      {
        type: 'ACTION_TYPE_PRESENTATION_SLIDE',
        slide: {
          presentation: {
            baseSlide: {
              size: { width: 1280, height: 720 },
              elements: [
                {
                  element: {
                    name: 'Logo',
                    bounds: { origin: { x: 40, y: 40 }, size: { width: 200, height: 100 } },
                    fill: {
                      enable: true,
                      media: {
                        url: { absoluteString: 'file:///Volumes/Media/logos/church%20logo.png' },
                        image: { drawing: { scaleBehavior: 'SCALE_BEHAVIOR_FILL' } },
                      },
                    },
                  },
                },
                {
                  element: {
                    name: 'Title',
                    bounds: { origin: { x: 64, y: 360 }, size: { width: 1152, height: 200 } },
                    text: { rtfData: rtf('Welcome {home}', { fs: 120, rgb: [10, 20, 30] }) },
                  },
                },
                {
                  element: {
                    name: 'Missing',
                    bounds: { origin: { x: 0, y: 0 }, size: { width: 10, height: 10 } },
                    fill: { enable: true, media: { url: { absoluteString: 'file:///nowhere/gone.jpg' } } },
                  },
                },
              ],
            },
          },
        },
      },
    ],
  };
  return encodePresentation({
    uuid: uuid('P-ANN'),
    name: 'Announcements',
    cues: [cue],
    cueGroups: [{ group: { uuid: uuid('G-A'), name: 'Welcome' }, cueIdentifiers: [uuid('AN-1')] }],
  });
}

function playlistDoc(): Uint8Array {
  const T = pro7Type('rv.data.PlaylistDocument');
  const obj = {
    type: 'TYPE_PRESENTATION',
    rootNode: {
      uuid: uuid('ROOT'),
      name: 'PRESENTATIONS',
      type: 'TYPE_ROOT',
      playlists: {
        playlists: [
          {
            uuid: uuid('PL-1'),
            name: 'Sunday 3 Nov',
            type: 'TYPE_PLAYLIST',
            items: {
              items: [
                { uuid: uuid('I-H'), name: 'Worship', header: { color: { red: 1, alpha: 1 } } },
                {
                  uuid: uuid('I-1'),
                  name: 'Announcements',
                  presentation: {
                    documentPath: {
                      absoluteString:
                        'file:///Users/worship/Documents/ProPresenter/Libraries/Default/Announcements.pro',
                    },
                  },
                },
                {
                  uuid: uuid('I-2'),
                  name: 'Amazing Grace',
                  presentation: {
                    documentPath: {
                      absoluteString:
                        'file:///Users/worship/Documents/ProPresenter/Libraries/Default/Amazing%20Grace.pro',
                    },
                    arrangement: uuid('ARR-1'),
                  },
                },
                {
                  uuid: uuid('I-3'),
                  name: 'Walk-in loop',
                  cue: { uuid: uuid('CU-1'), actions: [mediaAction('Motion Backgrounds/Blue Waves.mp4')] },
                },
                {
                  uuid: uuid('I-4'),
                  name: 'Not here',
                  presentation: { documentPath: { absoluteString: 'file:///x/Unknown.pro' } },
                },
              ],
            },
          },
          {
            uuid: uuid('PL-G'),
            name: 'Archive',
            type: 'TYPE_GROUP',
            playlists: {
              playlists: [
                {
                  uuid: uuid('PL-2'),
                  name: 'Easter',
                  type: 'TYPE_PLAYLIST',
                  items: { items: [{ uuid: uuid('I-5'), name: 'Amazing Grace', presentation: {} }] },
                },
              ],
            },
          },
        ],
      },
    },
  };
  const err = T.verify(T.fromObject(obj));
  if (err) throw new Error(err);
  return T.encode(T.fromObject(obj)).finish();
}

async function fixtureZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('Libraries/Default/Amazing Grace.pro', amazingGrace());
  zip.file('Libraries/Default/Announcements.pro', announcements());
  zip.file('Playlists/PRESENTATIONS', playlistDoc());
  zip.file('Media/Motion Backgrounds/Blue Waves.mp4', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
  zip.file('Media/elsewhere/church logo.png', new Uint8Array([137, 80, 78, 71]));
  zip.file('__MACOSX/._Amazing Grace.pro', new Uint8Array([1]));
  return zip.generateAsync({ type: 'uint8array' });
}

describe('importPro7', () => {
  it('imports presentations, sections, arrangements, media and playlists from a zip', async () => {
    const files = await readZip(await fixtureZip());
    expect([...files.keys()].some((k) => k.includes('__MACOSX'))).toBe(false);
    const res = importPro7(files);
    expect(res.protoVersion).toMatch(/ProPresenter7-Proto@/);
    expect(res.presentations).toHaveLength(2);

    const grace = res.presentations.find((p) => p.title === 'Amazing Grace')!;
    expect(grace.kind).toBe('song');
    expect(grace.source?.kind).toBe('pro7');
    expect(grace.meta).toMatchObject({
      author: 'John Newton',
      ccli: '22025',
      copyright: '1779 Public Domain',
      tags: ['Hymns'],
    });
    expect(grace.sections.map((s) => [s.label, s.short, s.slides.length])).toEqual([
      ['Verse 1', 'V1', 2],
      ['Chorus', 'C', 1],
      ['Blank Slide', 'BS', 1],
    ]);
    const s1 = grace.sections[0]!.slides[0]!;
    const t = s1.objects[0]!;
    expect(t.type).toBe('text');
    if (t.type !== 'text') throw new Error();
    expect(s1.lyricObjectId).toBe(t.id);
    expect(t.text).toBe('Amazing grace, how sweet the sound\nThat saved a wretch like me');
    expect(t.box).toEqual({ x: 100, y: 150, w: 1720, h: 780, rotation: 0 });
    expect(t.style).toMatchObject({
      fontFamily: 'Helvetica Neue',
      fontWeight: 700,
      fontSizePx: 80,
      align: 'center',
      valign: 'middle',
    });
    const chorus = grace.sections[1]!.slides[0]!.objects[0]!;
    expect(chorus.type === 'text' && chorus.text).toBe('’Twas grace that taught my heart to fear');

    // Selected arrangement ("Full") first; group uuids map to section ids.
    expect(grace.arrangements.map((a) => a.name)).toEqual(['Full', 'Short']);
    const [v1, c, bl] = grace.sections.map((s) => s.id);
    expect(grace.arrangements[0]!.sectionIds).toEqual([v1, c, v1, c, bl]);

    // The only background video starts on the first slide: lifted to the presentation.
    const bgKey = `${PRO7_MEDIA_PREFIX}Users/worship/Documents/ProPresenter/Media/Motion Backgrounds/Blue Waves.mp4`;
    expect(grace.backgroundMediaId).toBe(bgKey);
    expect(res.media).toContainEqual({
      key: bgKey,
      path: 'Media/Motion Backgrounds/Blue Waves.mp4',
      background: true,
    });

    const ann = res.presentations.find((p) => p.title === 'Announcements')!;
    expect(ann.kind).toBe('slides');
    const objs = ann.sections[0]!.slides[0]!.objects;
    // ProPresenter lists the logo first (frontmost); ordo draws back to front, so it comes last.
    expect(objs.map((o) => o.type)).toEqual(['text', 'image']);
    const img = objs[1]!;
    if (img.type !== 'image') throw new Error();
    // 1280x720 slide scaled to 1920x1080.
    expect(img.box).toEqual({ x: 60, y: 60, w: 300, h: 150, rotation: 0 });
    expect(img.fit).toBe('cover');
    expect(res.media.find((m) => m.key === img.mediaId)?.path).toBe('Media/elsewhere/church logo.png');
    const title = objs[0]!;
    if (title.type !== 'text') throw new Error();
    expect(title.text).toBe('Welcome {home}');
    expect(title.style.fontSizePx).toBe(90);
    expect(title.style.color).toEqual({ r: 10, g: 20, b: 30, a: 1 });

    // Playlists: header skipped, presentation refs resolved, media cue imported, missing presentation logged.
    expect(res.playlists.map((p) => p.name)).toEqual(['Sunday 3 Nov', 'Archive / Easter']);
    const sun = res.playlists[0]!;
    expect(sun.items.map((i) => i.kind)).toEqual(['presentation', 'presentation', 'media']);
    const [i1, i2, i3] = sun.items;
    expect(i1!.kind === 'presentation' && i1!.presentationId).toBe(ann.id);
    expect(i2!.kind === 'presentation' && i2!.presentationId).toBe(grace.id);
    expect(i2!.kind === 'presentation' && i2!.arrangementId).toBe(grace.arrangements[1]!.id);
    expect(i3!.kind === 'media' && i3!.mediaId).toBe(bgKey);
    expect(i3!.kind === 'media' && i3!.loop).toBe(true);
    // Matched by item name when there is no document path.
    const easter = res.playlists[1]!.items[0]!;
    expect(easter.kind === 'presentation' && easter.presentationId).toBe(grace.id);

    const msgs = res.log.map((l) => `${l.level}:${l.item ?? ''}:${l.message}`);
    expect(msgs.some((m) => /skipped macros \(1\)/.test(m))).toBe(true);
    expect(msgs.some((m) => /skipped builds and animations/.test(m))).toBe(true);
    expect(msgs.some((m) => /skipped timelines/.test(m))).toBe(true);
    expect(
      msgs.some((m) => /^warn:Announcements.pro:media file not found in import: nowhere\/gone.jpg/.test(m)),
    ).toBe(true);
    expect(msgs.some((m) => /presentation "Not here" was not in the import/.test(m))).toBe(true);
    expect(msgs.some((m) => /header "[^"]+" before item 1 not imported/.test(m))).toBe(true);
  });

  it('remaps placeholder media ids and drops unresolved ones', async () => {
    const res = importPro7(await readZip(await fixtureZip()));
    const map = new Map<string, string>();
    const bg = res.media.find((m) => m.path.endsWith('.mp4'))!;
    map.set(bg.key, 'MEDIA-BG');
    const out = remapMediaIds({ presentations: res.presentations, playlists: res.playlists }, map);
    const grace = out.presentations.find((p) => p.title === 'Amazing Grace')!;
    expect(grace.backgroundMediaId).toBe('MEDIA-BG');
    const ann = out.presentations.find((p) => p.title === 'Announcements')!;
    // The logo was not mapped: its image object is removed.
    expect(ann.sections[0]!.slides[0]!.objects.map((o) => o.type)).toEqual(['text']);
    const media = out.playlists[0]!.items.find((i) => i.kind === 'media')!;
    expect(media.kind === 'media' && media.mediaId).toBe('MEDIA-BG');
    expect(JSON.stringify(out)).not.toContain(PRO7_MEDIA_PREFIX);
    // Input untouched.
    expect(res.presentations[0]!.backgroundMediaId).toContain(PRO7_MEDIA_PREFIX);
  });

  it('logs undecodable files instead of throwing', () => {
    const res = importPro7(new Map([['broken.pro', new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f])]]));
    expect(res.presentations).toHaveLength(0);
    expect(res.log.some((l) => l.level === 'error' && l.item === 'broken.pro')).toBe(true);
  });

  it('reads playlists inside an exported .proPlaylist bundle', async () => {
    const inner = new JSZip();
    inner.file('data', playlistDoc());
    inner.file('Amazing Grace.pro', amazingGrace());
    const outer = new JSZip();
    outer.file('Sunday.proPlaylist', await inner.generateAsync({ type: 'uint8array' }));
    const files = await readZip(await outer.generateAsync({ type: 'uint8array' }));
    expect([...files.keys()].sort()).toEqual([
      'Sunday.proPlaylist/Amazing Grace.pro',
      'Sunday.proPlaylist/data',
    ]);
    const res = importPro7(files);
    expect(res.presentations).toHaveLength(1);
    expect(res.playlists[0]!.items.filter((i) => i.kind === 'presentation')).toHaveLength(1);
  });

  it('imports a document present twice only once', async () => {
    const files = new Map([
      ['Library/Amazing Grace.pro', amazingGrace()],
      ['Sunday.proPlaylist/Amazing Grace.pro', amazingGrace()],
    ]);
    const res = importPro7(files);
    expect(res.presentations).toHaveLength(1);
    expect(res.log.some((l) => /imported once/.test(l.message))).toBe(true);
  });

  it('keeps a copied document that shares a UUID but differs in name or slides (item 37)', () => {
    const renamed = encodePresentation({
      uuid: uuid('P-ANN'),
      name: 'Announcements (Easter)',
      cues: [textCue('X-1', 'Easter')],
    });
    const extraSlide = encodePresentation({
      uuid: uuid('P-ANN'),
      name: 'Announcements',
      cues: [textCue('X-1', 'one'), textCue('X-2', 'two')],
    });
    const files = new Map([
      ['Library/Announcements.pro', announcements()],
      ['Library/Announcements (Easter).pro', renamed],
      ['Old/Announcements.pro', extraSlide],
    ]);
    const res = importPro7(files);
    expect(res.presentations.map((p) => p.title).sort()).toEqual([
      'Announcements',
      'Announcements',
      'Announcements (Easter)',
    ]);
    const warns = res.log.filter((l) => /same ProPresenter UUID/.test(l.message));
    expect(warns.map((l) => l.level)).toEqual(['warn', 'warn']);
    expect(warns.some((l) => /different name/.test(l.message))).toBe(true);
    expect(warns.some((l) => /different slide count/.test(l.message))).toBe(true);
    expect(res.log.some((l) => /imported once/.test(l.message))).toBe(false);
  });

  it('applies ALL CAPS, logs other transforms and empty text boxes, keeps plain-text line breaks (item 37)', () => {
    const cue = textCue('T-1', 'Shout it');
    const base = (cue.actions[0] as { slide: { presentation: { baseSlide: { elements: unknown[] } } } }).slide
      .presentation.baseSlide;
    const el = (base.elements[0] as { element: Record<string, unknown> }).element;
    el.text = {
      rtfData: rtf('Shout it'),
      attributes: {
        capitalization: 'CAPITALIZATION_ALL_CAPS',
        customAttributes: [{ range: { start: 0, end: 2 }, capitalization: 'CAPITALIZATION_TITLE_CASE' }],
      },
      transform: 'TRANSFORM_ONE_WORD_PER_LINE',
    };
    base.elements.push(
      {
        element: {
          uuid: uuid('E-EMPTY'),
          name: 'Empty',
          bounds: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
          text: { rtfData: new Uint8Array(0) },
        },
      },
      {
        element: {
          uuid: uuid('E-PLAIN'),
          name: 'Plain',
          bounds: { origin: { x: 0, y: 500 }, size: { width: 1920, height: 300 } },
          text: {
            rtfData: enc.encode('first line\r\nsecond line\nthird line'),
            attributes: { capitalization: 'CAPITALIZATION_SMALL_CAPS' },
          },
        },
      },
    );
    const doc = encodePresentation({ uuid: uuid('P-T'), name: 'Transforms', cues: [cue] });
    const res = importPro7(new Map([['Library/Transforms.pro', doc]]));
    const slide = res.presentations[0]!.sections[0]!.slides[0]!;
    const texts = slide.objects.filter((o) => o.type === 'text').map((o) => (o as { text: string }).text);
    // ALL CAPS is carried as a style transform; the words keep their authored casing.
    expect(texts).toEqual(['first line\nsecond line\nthird line', 'Shout it']);
    const shout = slide.objects.findLast((o) => o.type === 'text') as { style: { transform: string } };
    expect(shout.style.transform).toBe('uppercase');
    const messages = res.log.filter((l) => l.item === 'Transforms.pro').map((l) => l.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'skipped capitalization of part of a text (1)',
        'skipped text transform one word per line (1)',
        'skipped empty text elements (1)',
        'skipped small caps capitalization (1)',
        'plain-text (non-RTF) elements imported with the attribute style only (1)',
      ]),
    );
  });
});

describe('readZip', () => {
  it('rejects path traversal', async () => {
    const zip = new JSZip();
    zip.file('ok.txt', 'x');
    zip.file('../../etc/passwd', 'x');
    await expect(readZip(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      /escapes|traversal/,
    );
  });
});

/** What ProPresenter 7 writes on export, reproduced with synthetic content (2026-11-05 church playlist). */
describe('ProPresenter export details', () => {
  const pictureElement = (name: string, path: string, box = { x: 0, y: 0, w: 1920, h: 1080 }) => ({
    element: {
      uuid: uuid(`E-${name}`),
      name,
      bounds: { origin: { x: box.x, y: box.y }, size: { width: box.w, height: box.h } },
      opacity: 1,
      fill: {
        enable: true,
        media: {
          url: { absoluteString: `file:///Users/worship/Documents/ProPresenter/Media/${encodeURI(path)}` },
          image: {},
        },
      },
      // Every element carries a text block; a picture's is empty.
      text: { rtfData: rtf('') },
    },
  });
  const textElement = (name: string, text: string) => ({
    element: {
      uuid: uuid(`E-${name}`),
      name,
      bounds: { origin: { x: 100, y: 150 }, size: { width: 1720, height: 780 } },
      opacity: 1,
      text: { rtfData: rtf(text) },
    },
  });
  const cue = (id: string, elements: unknown[], extra: unknown[] = []) => ({
    uuid: uuid(id),
    isEnabled: true,
    actions: [
      {
        uuid: uuid(`A-${id}`),
        type: 'ACTION_TYPE_PRESENTATION_SLIDE',
        isEnabled: true,
        slide: { presentation: { baseSlide: { size: { width: 1920, height: 1080 }, elements } } },
      },
      ...extra,
    ],
  });
  const clearBackground = {
    uuid: uuid('CL'),
    type: 'ACTION_TYPE_CLEAR',
    isEnabled: true,
    clear: { targetLayer: 'CLEAR_TARGET_LAYER_BACKGROUND' },
  };
  const clearAll = {
    uuid: uuid('CG'),
    type: 'ACTION_TYPE_CLEAR_GROUP',
    isEnabled: true,
    clearGroup: { identification: { parameterName: 'Clear All' } },
  };

  it('keeps pictures that carry an empty text block, stacks front to back, runs the background until cleared', () => {
    const doc = encodePresentation({
      uuid: uuid('P-X'),
      name: 'Sermon',
      cues: [
        // The verse is listed first: in front of the full-screen picture.
        cue(
          'C1',
          [textElement('Verse', 'Rest for your souls'), pictureElement('Faded', 'faded.png')],
          [mediaAction('series.png'), clearAll],
        ),
        cue('C2', [pictureElement('Map', 'map.png', { x: 480, y: 0, w: 960, h: 1080 })]),
        cue('C3', [textElement('Point', 'Point one')], [clearBackground]),
        cue('C4', [textElement('Point', 'Point two')]),
        cue('C5', [textElement('Close', 'Amen')], [mediaAction('series.png'), clearAll]),
      ],
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const res = importPro7(
      new Map([
        ['Sermon.pro', doc],
        ['ProPresenter/Media/series.png', png],
        ['ProPresenter/Media/faded.png', png],
        ['ProPresenter/Media/map.png', png],
      ]),
    );
    const p = res.presentations[0]!;
    const slides = p.sections.flatMap((s) => s.slides);
    // Picture behind (drawn first), verse in front; the picture's empty text block is not an object.
    expect(slides[0]!.objects.map((o) => o.type)).toEqual(['image', 'text']);
    expect(slides[1]!.objects.map((o) => o.type)).toEqual(['image']);
    const bg = `${PRO7_MEDIA_PREFIX}Users/worship/Documents/ProPresenter/Media/series.png`;
    // Started on slide 1, still running on 2, cleared on 3 (and so absent on 4), started again on 5.
    expect(p.backgroundMediaId).toBeUndefined();
    expect(slides.map((s) => s.backgroundMediaId)).toEqual([bg, bg, undefined, undefined, bg]);
    // Slide 3 stops it on the output (ordo, like ProPresenter, keeps a background running otherwise).
    expect(slides.map((s) => s.clearBackground ?? false)).toEqual([false, false, true, false, false]);
    expect(res.media.map((m) => m.path).sort()).toEqual([
      'ProPresenter/Media/faded.png',
      'ProPresenter/Media/map.png',
      'ProPresenter/Media/series.png',
    ]);
  });

  it("draws a slide's own background colour above the running background media, under its objects", () => {
    const colored = cue('C2', [textElement('Verse', 'In the beginning')]);
    const base = (colored.actions[0] as { slide: { presentation: { baseSlide: Record<string, unknown> } } })
      .slide.presentation.baseSlide;
    base.drawsBackgroundColor = true;
    base.backgroundColor = { red: 0, green: 0, blue: 0, alpha: 1 };
    const doc = encodePresentation({
      uuid: uuid('P-C'),
      name: 'Title then verses',
      // The title picture runs as background media; the verse slide's black hides it, as in ProPresenter.
      cues: [cue('C1', [], [mediaAction('title.png')]), colored],
    });
    const res = importPro7(
      new Map([
        ['T.pro', doc],
        ['ProPresenter/Media/title.png', new Uint8Array([1])],
      ]),
    );
    const slides = res.presentations[0]!.sections.flatMap((s) => s.slides);
    expect(slides[0]!.objects).toEqual([]);
    const [rect, text] = slides[1]!.objects;
    expect(rect).toMatchObject({
      type: 'shape',
      shape: 'rect',
      box: { x: 0, y: 0, w: 1920, h: 1080 },
      fill: { r: 0, g: 0, b: 0, a: 1 },
      // The slide's background (a backdrop): a background put over the slide replaces it.
      origin: { src: 'pro7', role: 'bg' },
    });
    expect(text!.type).toBe('text');
    expect(res.log.some((l) => /background colour/.test(l.message))).toBe(false);
  });

  it("draws the presentation's background colour or gradient as each slide's backdrop, replaceable", () => {
    for (const background of [
      { isEnabled: true, color: { red: 0.2, green: 0.4, blue: 0.6, alpha: 1 } },
      {
        isEnabled: true,
        gradient: {
          type: 'TYPE_LINEAR',
          angle: 90,
          stops: [
            { color: { red: 1, green: 0, blue: 0, alpha: 1 }, position: 0 },
            { color: { red: 0, green: 0, blue: 1, alpha: 1 }, position: 1 },
          ],
        },
      },
    ]) {
      const doc = encodePresentation({
        uuid: uuid('P-BG'),
        name: 'On a colour',
        background,
        cues: [cue('C1', [textElement('Verse', 'Holy, holy, holy')])],
      });
      const res = importPro7(new Map([['On a colour.pro', doc]]));
      const [rect, text] = res.presentations[0]!.sections[0]!.slides[0]!.objects;
      expect(rect).toMatchObject({
        type: 'shape',
        box: { x: 0, y: 0, w: 1920, h: 1080 },
        origin: { src: 'pro7', role: 'bg' },
      });
      expect(rect!.locked).toBeUndefined();
      if (background.gradient)
        expect((rect as { gradient?: { stops: unknown[] } }).gradient?.stops).toHaveLength(2);
      else expect((rect as { fill?: unknown }).fill).toMatchObject({ r: 51, g: 102, b: 153, a: 1 });
      expect(text!.type).toBe('text');
    }
  });

  it('reads a ProPresenter zip whose central directory size counts its Zip64 end records', async () => {
    const zip = new JSZip();
    zip.file('Song.pro', 'not a document, only bytes');
    zip.file('data', 'playlist');
    const good = await zip.generateAsync({ type: 'uint8array' });
    const v = new DataView(good.buffer, good.byteOffset, good.byteLength);
    const eocd = good.length - 22;
    const entries = v.getUint16(eocd + 10, true);
    const size = v.getUint32(eocd + 12, true);
    const offset = v.getUint32(eocd + 16, true);
    // Rebuild the end as ProPresenter does: Zip64 record + locator + classic record, and a directory size
    // 98 bytes too large (the three end records counted in) in both size fields.
    const z64 = new DataView(new ArrayBuffer(56));
    z64.setUint32(0, 0x06064b50, true);
    z64.setBigUint64(4, 44n, true);
    z64.setUint16(12, 45, true);
    z64.setUint16(14, 45, true);
    z64.setBigUint64(24, BigInt(entries), true);
    z64.setBigUint64(32, BigInt(entries), true);
    z64.setBigUint64(40, BigInt(size + 98), true);
    z64.setBigUint64(48, BigInt(offset), true);
    const loc = new DataView(new ArrayBuffer(20));
    loc.setUint32(0, 0x07064b50, true);
    loc.setBigUint64(8, BigInt(offset + size), true);
    loc.setUint32(16, 1, true);
    const end = new DataView(good.slice(eocd).buffer);
    end.setUint32(12, size + 98, true);
    const bad = new Uint8Array(offset + size + 56 + 20 + 22);
    bad.set(good.subarray(0, offset + size));
    bad.set(new Uint8Array(z64.buffer), offset + size);
    bad.set(new Uint8Array(loc.buffer), offset + size + 56);
    bad.set(new Uint8Array(end.buffer), offset + size + 76);
    await expect(JSZip.loadAsync(bad)).rejects.toThrow(/Corrupted zip/);
    const files = await readZip(bad);
    expect([...files.keys()].sort()).toEqual(['Song.pro', 'data']);
    expect(new TextDecoder().decode(files.get('data'))).toBe('playlist');
  });
});

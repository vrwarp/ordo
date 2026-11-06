/**
 * The stage's text regions rendered to markup (design/16; design/27 §6 and §11 item 13): every paragraph of
 * the current, next and notes text is its own block with `dir="auto"`, and the notes sit in their own box.
 */
import { LOOK_STAGE, type Look } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotesRegion, Paragraphs, TextRegion } from './App.tsx';
import { stageLayout } from './model.ts';

const HEBREW = 'שלום עליכם!';

/** The `.para` blocks of some markup, with their attributes and text. */
const paras = (html: string) =>
  [...html.matchAll(/<div class="para"([^>]*)>([^<]*)<\/div>/g)].map((m) => ({ attrs: m[1]!, text: m[2]! }));

const notesOn = (): Look => ({
  ...LOOK_STAGE,
  layers: { ...LOOK_STAGE.layers, props: { ...LOOK_STAGE.layers.props, notes: true } },
});

describe('stage paragraphs', () => {
  it('draws each paragraph as its own block taking its direction from its content', () => {
    const html = renderToStaticMarkup(
      createElement(Paragraphs, { className: 'lyrics', text: `Peace be with you\n${HEBREW}\n\nAmen` }),
    );
    expect(paras(html)).toEqual([
      { attrs: ' dir="auto"', text: 'Peace be with you' },
      { attrs: ' dir="auto"', text: HEBREW },
      { attrs: ' dir="auto"', text: '' },
      { attrs: ' dir="auto"', text: 'Amen' },
    ]);
    // The text content keeps its line breaks between the blocks (search and copy read it as written).
    expect(html.replace(/<[^>]+>/g, '')).toBe(`Peace be with you\n${HEBREW}\n\nAmen`);
    expect(html.startsWith('<div class="lyrics">')).toBe(true);
  });

  it('draws the current and next lyrics that way, under their section label', () => {
    const layout = stageLayout(LOOK_STAGE);
    const current = renderToStaticMarkup(
      createElement(TextRegion, {
        className: 'current',
        box: layout.current!.box,
        style: layout.current!.style,
        text: { text: `Line one\n${HEBREW}`, label: 'Verse 1', position: '1/2' },
        section: layout.section,
        fontsVersion: 0,
      }),
    );
    expect(current).toContain('class="kicker"');
    expect(paras(current).map((p) => [p.attrs, p.text])).toEqual([
      [' dir="auto"', 'Line one'],
      [' dir="auto"', HEBREW],
    ]);
    // The look's own style never sets a direction on the region.
    expect(current).not.toMatch(/direction:/);
    const next = renderToStaticMarkup(
      createElement(TextRegion, {
        className: 'next',
        box: layout.next!.box,
        style: layout.next!.style,
        text: { text: HEBREW },
        fontsVersion: 0,
      }),
    );
    expect(paras(next)).toEqual([{ attrs: ' dir="auto"', text: HEBREW }]);
  });
});

describe('the notes region', () => {
  it('shows the notes in their box, paragraph by paragraph, their start kept in view', () => {
    const notes = stageLayout(notesOn()).notes!;
    const html = renderToStaticMarkup(
      createElement(NotesRegion, { prop: notes, text: `Greet the guests.\n${HEBREW}`, fontsVersion: 0 }),
    );
    const b = notes.box;
    expect(html).toContain(`left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`);
    expect(html).toContain('class="region notes"');
    expect(html).toContain('justify-content:safe flex-start');
    expect(html).toContain(`font-size:${notes.fontSizePx}px`);
    expect(paras(html)).toEqual([
      { attrs: ' dir="auto"', text: 'Greet the guests.' },
      { attrs: ' dir="auto"', text: HEBREW },
    ]);
  });

  it('keeps the start of long notes in view for any vertical alignment', () => {
    const notes = stageLayout(notesOn()).notes!;
    for (const [valign, css] of [
      ['middle', 'safe center'],
      ['bottom', 'safe flex-end'],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(NotesRegion, { prop: { ...notes, valign }, text: 'Notes', fontsVersion: 0 }),
      );
      expect(html).toContain(`justify-content:${css}`);
    }
  });
});

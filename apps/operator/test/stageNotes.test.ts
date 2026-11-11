/**
 * The stage look's notes options in the look editor (design/27 §11 item 13, M4 item G): the 'Notes' toggle,
 * the box and text style it shows while on, and the defaults it shows, which must be the stage's own.
 */
import { DEFAULT_LOOKS, LOOK_MAIN, LOOK_STAGE, type Look, type PropsRule } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { stageLayout } from '../../stage/src/model.ts';
import {
  notesDefault,
  notesOf,
  notesOverLyrics,
  StageNotesOptions,
} from '../src/views/settings/StageNotesOptions.tsx';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

function withProps(look: Look, p: Partial<PropsRule>): Look {
  return { ...look, layers: { ...look.layers, props: { ...look.layers.props, ...p } } };
}

function withBands(look: Look, band: ReturnType<typeof box>, next?: ReturnType<typeof box>): Look {
  const rule = LOOK_STAGE.layers.slide;
  if (rule.mode !== 'lyricOnly') throw new Error('stage look');
  return {
    ...look,
    layers: {
      ...look.layers,
      slide: { ...rule, band, nextSlide: next ? { style: rule.nextSlide!.style, band: next } : undefined },
    },
  };
}

const render = (look: Look, onChange: (p: PropsRule) => void = () => undefined) =>
  renderToStaticMarkup(createElement(StageNotesOptions, { look, onChange }));

describe('the notes defaults the look editor shows', () => {
  it('are where the stage puts unstyled notes, for every kind of look', () => {
    const looks = [
      LOOK_STAGE,
      withBands(LOOK_STAGE, box(60, 100, 1800, 400), box(60, 520, 1800, 200)),
      withBands(LOOK_STAGE, box(60, 600, 1800, 300), box(60, 100, 1800, 300)),
      withBands(LOOK_STAGE, box(100, 140, 900, 300)),
      withBands(LOOK_STAGE, box(60, 60, 1800, 1000), box(60, 60, 900, 980)),
      LOOK_MAIN,
      ...DEFAULT_LOOKS,
    ];
    for (const l of looks) {
      const look = withProps(l, { notes: true });
      const stage = stageLayout(look).notes;
      const ours = notesDefault(look);
      // The stage then keeps the box off the current lyrics; where it needs not, the boxes are the same.
      if (stage && !notesOverLyrics(look)) expect(ours, l.name).toEqual(stage);
      else expect({ ...ours, box: undefined }, l.name).toEqual({ ...(stage ?? ours), box: undefined });
    }
  });

  it('give way to the look’s own notes box and text', () => {
    const own = { ...notesDefault(LOOK_STAGE), fontSizePx: 40, box: box(60, 700, 900, 300) };
    const look = withProps(LOOK_STAGE, { notes: true, style: { notes: own } });
    expect(notesOf(look)).toEqual(own);
    expect(stageLayout(look).notes).toEqual(own);
    expect(notesOverLyrics(look)).toBe(false);
    expect(
      notesOverLyrics(withProps(look, { style: { notes: { ...own, box: box(60, 500, 900, 300) } } })),
    ).toBe(true);
  });
});

describe('the Stage screen card', () => {
  it('offers Notes, on by default for the default stage look', () => {
    const html = render(LOOK_STAGE);
    expect(text(html)).toContain('Stage screen');
    const check = html.match(/<label class="check"><input type="checkbox"[^>]*>/)![0];
    expect(check).toContain('checked');
    expect(text(html)).toContain('Notes: show the live slide’s notes, for the preacher');
    // While the notes are on, shows notes box and notes text options.
    expect(text(html)).toContain('Notes box (default: under the next slide)');
    expect(text(html)).toContain('Notes text');
  });

  it('turns the notes on and off without touching the other props', () => {
    let got: PropsRule | undefined;
    const props = LOOK_STAGE.layers.props;
    const el = StageNotesOptions({ look: LOOK_STAGE, onChange: (p) => (got = p) });
    // The toggle is the card's Check: find its onChange in the element tree.
    const check = (
      el.props.children as { props: { label?: string; onChange?: (v: boolean) => void } }[]
    ).find((c) => typeof c?.props?.label === 'string' && c.props.label.startsWith('Notes'))!;
    check.props.onChange!(false);
    expect(got).toEqual({ ...props, notes: false });
  });

  it('shows the default box and text while the notes are on, and the reset once styled', () => {
    const on = withProps(LOOK_STAGE, { notes: true });
    const html = render(on);
    expect(html.match(/<input type="checkbox"[^>]*>/)![0]).toContain('checked');
    expect(text(html)).toContain('Notes box (default: under the next slide)');
    expect(text(html)).toContain('Long notes are cut to their box. They never cover the current lyrics.');
    // The box editor without rotation, holding the default box's numbers.
    const d = notesDefault(on).box;
    const values = [...html.matchAll(/<input type="number"[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    for (const v of [d.x, d.y, d.w, d.h]) expect(values).toContain(String(v));
    expect(text(html)).not.toContain('Rotation');
    expect(text(html)).toContain('Notes text');
    expect(text(html)).not.toContain('Use the default box and text');
    expect(html).not.toContain('class="banner"');

    const styled = withProps(on, { style: { notes: { ...notesDefault(on), box: box(60, 400, 1800, 400) } } });
    const h2 = render(styled);
    expect(text(h2)).toContain('Notes box');
    expect(text(h2)).not.toContain('(default: under the next slide)');
    expect(text(h2)).toContain('Use the default box and text');
    // Over the lyrics: said in words (a status, not only a colour).
    expect(h2).toContain('class="banner" role="status"');
    expect(text(h2)).toContain('The notes box overlaps the current lyrics');
  });

  it('is on the look page for the stage look, and for another look only once its notes are on', async () => {
    const { useLibrary } = await import('../src/state/library.ts');
    const { LooksPage } = await import('../src/views/settings/LooksPage.tsx');
    const page = (looks: Look[]) => {
      // Rendered on the server, the store hook reads the initial state: seed both.
      const data = useLibrary.getState().data;
      const next = { data: { ...data, settings: { ...data.settings, looks } } };
      Object.assign(useLibrary.getInitialState(), next);
      useLibrary.setState(next);
      return renderToStaticMarkup(createElement(LooksPage));
    };
    // The page edits the first look until another is picked.
    expect(page([LOOK_STAGE, LOOK_MAIN])).toContain('data-stage-notes');
    expect(page([LOOK_MAIN, LOOK_STAGE])).not.toContain('data-stage-notes');
    expect(page([withProps(LOOK_MAIN, { notes: true }), LOOK_STAGE])).toContain('data-stage-notes');
  });
});

import { parseLyrics, type Presentation, songFromParsed } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SlidePreviewRoll, slidePreviewRollHeight } from '../src/components/SlidePreviewRoll.tsx';

function makePresentation(overrides: Partial<Presentation> = {}): Presentation {
  const base = songFromParsed(parseLyrics('Verse 1\nLine 1\n\nChorus\nChorus line'));
  const [v1, c1] = base.sections.map((s) => s.id) as [string, string];
  const v1Section = base.sections[0]!;
  // Give Verse 1 two slides so section/slide counts differ cleanly across arrangements.
  const sections = [
    {
      ...v1Section,
      slides: [v1Section.slides[0]!, { ...v1Section.slides[0]!, id: 's2' }],
    },
    base.sections[1]!,
  ];
  return {
    ...base,
    sections,
    arrangements: [
      { id: 'a1', name: 'Default', sectionIds: [v1, c1] },
      { id: 'a2', name: 'Extended', sectionIds: [v1, c1, c1] },
    ],
    ...overrides,
  };
}

describe('SlidePreviewRoll', () => {
  it('stacks all arrangements without a dropdown and computes per-arrangement counts', () => {
    const html = renderToStaticMarkup(createElement(SlidePreviewRoll, { p: makePresentation() }));
    expect(html).not.toContain('<select');
    expect(html).toContain('Default');
    expect(html).toContain('(default)');
    expect(html).toContain('2 secs · 3 slides');
    expect(html).toContain('Extended');
    expect(html).toContain('3 secs · 4 slides');
    expect(html).not.toContain('>Add</button>');
  });

  it('renders an Add button for each stacked arrangement when onAddArrangement is provided', () => {
    const html = renderToStaticMarkup(
      createElement(SlidePreviewRoll, { p: makePresentation(), onAddArrangement: () => undefined }),
    );
    const addButtons = html.match(/>Add<\/button>/g) ?? [];
    expect(addButtons).toHaveLength(2);
  });

  it('omits the (default) badge when there is only one arrangement', () => {
    const base = makePresentation();
    const v1 = base.sections[0]!.id;
    const p: Presentation = {
      ...base,
      arrangements: [{ id: 'a1', name: 'Default', sectionIds: [v1] }],
    };
    const html = renderToStaticMarkup(createElement(SlidePreviewRoll, { p }));
    expect(html).toContain('Default');
    expect(html).not.toContain('(default)');
    expect(html).toContain('1 sec · 2 slides');
  });

  it('falls back to Authoring order when a presentation has no arrangements', () => {
    const p = makePresentation({ arrangements: [] });
    const html = renderToStaticMarkup(
      createElement(SlidePreviewRoll, { p, onAddArrangement: () => undefined }),
    );
    expect(html).toContain('Authoring order');
    expect(html).toContain('2 secs · 3 slides');
    expect(html.match(/>Add<\/button>/g) ?? []).toHaveLength(1);
  });

  it('grows slidePreviewRollHeight with arrangement count', () => {
    const two = makePresentation();
    const one = makePresentation({
      arrangements: [two.arrangements[0]!],
    });
    expect(slidePreviewRollHeight(two, true)).toBeGreaterThan(slidePreviewRollHeight(one, true));
    expect(slidePreviewRollHeight(two, false)).toBeGreaterThan(slidePreviewRollHeight(one, false));
  });
});

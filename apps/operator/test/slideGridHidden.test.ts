import { readFileSync } from 'node:fs';
import { expandCues, type Playlist, Presentation } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/** Hidden PowerPoint slides in the live slide grid (design/27 §9): dimmed, tagged, still clickable. */

const deck = Presentation.parse({
  id: 'deck',
  title: 'Announcements',
  kind: 'slides',
  sections: [
    {
      id: 'sec',
      label: 'Main',
      short: 'M',
      slides: [
        { id: 'a', objects: [] },
        { id: 'h', objects: [], hidden: true },
        { id: 'b', objects: [] },
      ],
    },
  ],
});
const playlist = {
  id: 'pl',
  rev: 1,
  name: 'Sunday',
  items: [{ id: 'it', kind: 'presentation', presentationId: deck.id }],
} as Playlist;

describe('SlideGrid: hidden slides', () => {
  it('draws a hidden slide dimmed with a hidden tag, between the others, with its number', async () => {
    const { SlideGrid } = await import('../src/views/live/SlideGrid.tsx');
    const cues = expandCues({ playlist, presentations: { deck }, media: {} });
    expect(cues.map((c) => c.hidden)).toEqual([undefined, true, undefined]);
    const op = { playlist, live: false, cues, presentation: () => deck, media: () => undefined };
    const out = renderToStaticMarkup(createElement(SlideGrid, { op, viewItem: 0 }));
    const thumbs = out.match(/<div class="thumb[^"]*"/g) ?? [];
    expect(thumbs).toHaveLength(3);
    expect(thumbs.map((t) => t.includes('hidden-slide'))).toEqual([false, true, false]);
    const tags = out.match(/<span class="tag"[^>]*data-hidden-slide[^>]*>[^<]*<\/span>/g) ?? [];
    expect(tags).toEqual([
      '<span class="tag" title="Hidden slide: Next skips it; click it to show it" data-hidden-slide="true">hidden</span>',
    ]);
    expect(out).toContain('<span class="num">2</span>');
  });

  it('dims only the picture, never the caption, and keeps the thumbnail clickable', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const rules = [...css.matchAll(/([^{}]*hidden-slide[^{}]*)\{([^}]*)\}/g)].map((m) => [
      m[1]!.trim(),
      m[2]!,
    ]);
    expect(rules.length).toBeGreaterThan(0);
    for (const [selector, body] of rules) {
      expect(body).not.toMatch(/pointer-events/);
      if (/opacity/.test(body!)) expect(selector).not.toMatch(/\.cap|^\.thumb\.hidden-slide\s*$/);
    }
  });
});

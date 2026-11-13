import { expandCues, type Playlist, Presentation } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { requestScrollToPlaylistItem, useUi } from '../src/state/ui.ts';
import { SlideGrid } from '../src/views/live/SlideGrid.tsx';

describe('SlideGrid continuous playlist scroll', () => {
  const p1 = Presentation.parse({
    id: 'p1',
    title: 'Goodness Of God',
    kind: 'song',
    sections: [
      {
        id: 'sec1',
        label: 'Chorus',
        short: 'C',
        slides: [
          { id: 's1', objects: [] },
          { id: 's2', objects: [] },
        ],
      },
    ],
  });

  const p2 = Presentation.parse({
    id: 'p2',
    title: 'Kingdom Come 11',
    kind: 'slides',
    sections: [
      {
        id: 'sec2',
        label: 'Main',
        short: 'M',
        slides: [
          { id: 's3', objects: [] },
          { id: 's4', objects: [] },
          { id: 's5', objects: [] },
        ],
      },
    ],
  });

  const playlist: Playlist = {
    id: 'pl-sunday',
    rev: 1,
    name: 'Sunday Morning Service',
    items: [
      { id: 'item1', kind: 'presentation', presentationId: p1.id },
      { id: 'item2', kind: 'presentation', presentationId: p2.id },
      { id: 'item3', kind: 'timer', timer: { kind: 'elapsed', label: 'Welcome Countdown' } },
    ],
  };

  it('renders all playlist items continuously in order with item headers', () => {
    const presentations = { [p1.id]: p1, [p2.id]: p2 };
    const cues = expandCues({ playlist, presentations, media: {} });
    const op = {
      playlist,
      live: false,
      cues,
      presentation: (id: string) => presentations[id],
      media: () => undefined,
    };

    const out = renderToStaticMarkup(createElement(SlideGrid, { op, viewItem: 0 }));

    // Verify playlist name in sticky pane-head
    expect(out).toContain('Sunday Morning Service');

    // Verify all 3 playlist item sections are rendered
    expect(out).toContain('data-playlist-item-index="0"');
    expect(out).toContain('data-playlist-item-index="1"');
    expect(out).toContain('data-playlist-item-index="2"');

    // Verify titles in headers
    expect(out).toContain('Goodness Of God');
    expect(out).toContain('Kingdom Come 11');
    expect(out).toContain('Welcome Countdown');

    // Verify Edit links for presentations
    expect(out).toContain('href="#/edit/p1"');
    expect(out).toContain('href="#/edit/p2"');

    // Verify total slide thumbnails rendered across all items
    const thumbs = out.match(/<div class="thumb[^"]*"/g) ?? [];
    // p1 has 2 slides, p2 has 3 slides, item3 has 1 timer cue
    expect(thumbs.length).toBe(6);
  });

  it('renders ON AIR tag when an item is live', () => {
    const presentations = { [p1.id]: p1, [p2.id]: p2 };
    const cues = expandCues({ playlist, presentations, media: {} });
    const op = {
      playlist,
      live: true,
      cues,
      presentation: (id: string) => presentations[id],
      media: () => undefined,
    };

    const out = renderToStaticMarkup(createElement(SlideGrid, { op, viewItem: 0 }));
    expect(out).toContain('playlist-item-head');
  });

  it('renders empty playlist message when playlist has no items', () => {
    const emptyPlaylist: Playlist = {
      id: 'pl-empty',
      rev: 1,
      name: 'Empty Playlist',
      items: [],
    };
    const op = {
      playlist: emptyPlaylist,
      live: false,
      cues: [],
      presentation: () => undefined,
      media: () => undefined,
    };

    const out = renderToStaticMarkup(createElement(SlideGrid, { op, viewItem: 0 }));
    expect(out).toContain('This playlist is empty.');
  });

  it('requestScrollToPlaylistItem updates scrollToItem with incrementing req and sets followLive to false', () => {
    useUi.setState({ followLive: true });
    requestScrollToPlaylistItem(2);
    const s1 = useUi.getState();
    expect(s1.viewItemIndex).toBe(2);
    expect(s1.followLive).toBe(false);
    expect(s1.scrollToItem?.index).toBe(2);
    const req1 = s1.scrollToItem?.req;
    expect(req1).toBeDefined();

    requestScrollToPlaylistItem(2);
    const s2 = useUi.getState();
    expect(s2.scrollToItem?.index).toBe(2);
    expect(s2.scrollToItem?.req).toBeGreaterThan(req1!);
  });
});

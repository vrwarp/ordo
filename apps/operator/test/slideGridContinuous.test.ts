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

  it('renders loop subtitle, LOOPING status pill, progress bar, wrap badge, and armed next-item border', async () => {
    const { initialState, reduce, reduceAll } = await import('@ordo/live-state');
    const { useLive } = await import('../src/state/live.ts');
    const loopPres = Presentation.parse({
      id: 'p-loop',
      title: 'Welcome loop',
      kind: 'loop',
      loop: { defaultSlideMs: 8000 },
      sections: [
        {
          id: 'sec-l',
          label: 'Announcements',
          short: 'A',
          slides: [
            { id: 'l1', objects: [] },
            { id: 'l2', objects: [], durationMs: 12000 },
          ],
        },
      ],
    });
    const oneSlideLoop = Presentation.parse({
      id: 'p-loop-1',
      title: 'Single announcement',
      kind: 'loop',
      loop: { defaultSlideMs: 6000 },
      sections: [
        {
          id: 'sec-l1',
          label: 'Main',
          short: 'M',
          slides: [{ id: 'only1', objects: [] }],
        },
      ],
    });
    const pl: Playlist = {
      id: 'pl-loop',
      rev: 1,
      name: 'Loop Test',
      items: [
        { id: 'it-loop', kind: 'presentation', presentationId: loopPres.id },
        { id: 'it-song', kind: 'presentation', presentationId: p1.id },
        { id: 'it-loop-1', kind: 'presentation', presentationId: oneSlideLoop.id },
      ],
    };
    const presentations = { [loopPres.id]: loopPres, [p1.id]: p1, [oneSlideLoop.id]: oneSlideLoop };
    const resolved = {
      playlist: pl,
      presentations,
      media: {},
      fonts: [],
      looks: [],
      files: [],
      manifestId: 'm-loop',
    };
    const liveState = reduceAll(initialState(), [
      { k: 'goLive', resolved },
      { k: 'go', cueIndex: 0, at: 1000 },
    ]);
    const prevLive = useLive.getState().state;
    const prevInit = useLive.getInitialState().state;
    Object.assign(useLive.getInitialState(), { state: liveState });
    useLive.setState({ state: liveState });
    try {
      const op = {
        playlist: pl,
        live: true,
        cues: liveState.cues,
        presentation: (id: string) => presentations[id],
        media: () => undefined,
      };
      const out = renderToStaticMarkup(createElement(SlideGrid, { op, viewItem: 0 }));
      // Mixed durations (8s default, 12s override) render range subtitle + per-slide override tag
      expect(out).toContain('Loop · 8–12s');
      expect(out).toContain('Loop · 6s');
      expect(out).toContain('data-slide-duration');
      expect(out).toContain('>12s<');
      expect(out).toContain('data-looping-pill');
      expect(out).toContain('LOOPING');
      expect(out).toContain('data-loop-progress');
      // Only the 2-slide loop renders a wrap badge; the 1-slide loop does not
      expect((out.match(/data-loop-wrap/g) ?? []).length).toBe(1);
      // Cue 2 (first slide of p1) is armed while cue 0 (first slide of loop) is live
      expect(liveState.armed).toBe(2);
      expect(out).toContain('class="thumb armed');

      // Clearing the slide layer stops autoAdvance and hides LOOPING while keeping ON AIR
      const cleared = reduce(liveState, { k: 'clear', layer: 'slide', at: 2000 });
      Object.assign(useLive.getInitialState(), { state: cleared });
      useLive.setState({ state: cleared });
      const outCleared = renderToStaticMarkup(createElement(SlideGrid, { op, viewItem: 0 }));
      expect(outCleared).toContain('ON AIR');
      expect(outCleared).not.toContain('data-looping-pill');
      expect(outCleared).not.toContain('data-loop-progress');

      // A 1-slide loop hides the progress bar since autoAdvance targets itself
      const onSingle = reduce(liveState, { k: 'go', cueIndex: 4, at: 3000 });
      Object.assign(useLive.getInitialState(), { state: onSingle });
      useLive.setState({ state: onSingle });
      const outSingle = renderToStaticMarkup(createElement(SlideGrid, { op, viewItem: 2 }));
      expect(outSingle).not.toContain('data-loop-progress');
    } finally {
      Object.assign(useLive.getInitialState(), { state: prevInit });
      useLive.setState({ state: prevLive });
    }
  });
});

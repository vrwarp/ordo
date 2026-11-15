/**
 * W41's toast (design/29 §3, M8): the progress while the hub prepares a Go live beside the running service,
 * and after 5 s while live the button that goes live from the hub's saved copy.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { savedCopyAgo } from '../src/core/engine.ts';
import { GoLivePrepareToast, GoLivePrepareView, goLivePrepareText } from '../src/views/live/GoLiveToast.tsx';

describe("W41: Getting 'Sunday service' ready to go live", () => {
  it('says the progress and, while live, that the screens keep the current service', () => {
    const p = { playlistId: 'pl', title: 'Sunday service', pct: 40, live: true };
    expect(goLivePrepareText(p)).toBe(
      "Getting 'Sunday service' ready to go live (40 %). The screens keep showing the current service until then.",
    );
    expect(goLivePrepareText({ ...p, live: false })).toBe(
      "Getting 'Sunday service' ready to go live (40 %).",
    );
  });

  it('shows the progress, and the saved-copy button once offered', () => {
    const p = { playlistId: 'pl', title: 'Sunday service', pct: 40, live: true };
    let html = renderToStaticMarkup(createElement(GoLivePrepareView, { p }));
    expect(html).toContain('data-golive-prepare="40"');
    expect(html).toContain('role="status"');
    expect(html).toContain('ready to go live (40 %)');
    expect(html).not.toContain('data-golive-saved');
    html = renderToStaticMarkup(createElement(GoLivePrepareView, { p: { ...p, savedAgo: '3 days ago' } }));
    expect(html).toContain('>Go live from the copy saved 3 days ago</button>');
    // Nothing while nothing is prepared.
    expect(renderToStaticMarkup(createElement(GoLivePrepareToast))).toBe('');
  });

  it('says how long ago the copy was saved as the hub does', () => {
    expect(savedCopyAgo(12_000)).toBe('12 s ago');
    expect(savedCopyAgo(20 * 60_000)).toBe('20 min ago');
    expect(savedCopyAgo(5 * 3_600_000)).toBe('5 h ago');
    expect(savedCopyAgo(3 * 86_400_000)).toBe('3 days ago');
  });
});

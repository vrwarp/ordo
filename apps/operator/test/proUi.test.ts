import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { playlistItemIconName } from '../src/components/Icons.tsx';
import { sectionTone } from '../src/lib/sectionColors.ts';

const proCss = readFileSync(new URL('../src/pro-ui.css', import.meta.url), 'utf8');

describe('desktop pro-tool UI foundation (design/30)', () => {
  it('maps song sections to deterministic ProPresenter-style color tones', () => {
    expect(sectionTone('Verse 1', 'V1').bg).toBe('#1d4ed8');
    expect(sectionTone('Chorus', 'C').bg).toBe('#be123c');
    expect(sectionTone('Pre-Chorus', 'PC').bg).toBe('#4338ca');
    expect(sectionTone('Bridge', 'B').bg).toBe('#b45309');
    expect(sectionTone('Outro / Tag', 'T').bg).toBe('#0f766e');
    expect(sectionTone('Intro', 'I').bg).toBe('#6d28d9');
    expect(sectionTone('Announcements', 'A').bg).toBe('#333a47');
  });

  it('maps playlist item kinds to SVG icon names', () => {
    expect(playlistItemIconName('presentation', 'song')).toBe('music');
    expect(playlistItemIconName('presentation', 'slides')).toBe('slides');
    expect(playlistItemIconName('presentation', 'loop')).toBe('loop');
    expect(playlistItemIconName('media')).toBe('video');
    expect(playlistItemIconName('timer')).toBe('timer');
    expect(playlistItemIconName('action')).toBe('action');
  });

  it('gates compact desktop density to fine pointers without touching compact layout selectors', () => {
    expect(proCss).toContain('@media (pointer: fine)');
    expect(proCss).not.toContain('data-layout');
    expect(proCss).toContain('.tactical-btn');
    expect(proCss).toContain('min-height: 36px');
    expect(proCss).toContain('.studio-statusbar');
  });
});

import { describe, expect, it } from 'vitest';
import { parseLyrics, songFromParsed, type Media, type Presentation } from '@ordo/domain';
import { m9Slide } from '@ordo/domain/m9.test-util.ts';
import { normalize, SearchIndex } from '../src/lib/search.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

function song(title: string, lyrics: string, extra: Partial<Presentation> = {}): Presentation {
  return { ...songFromParsed(parseLyrics(`Verse 1\n${lyrics}`), { title }), ...extra };
}

describe('search index', () => {
  it('normalizes diacritics and punctuation', () => {
    expect(normalize('Ámazing  Grace!')).toBe('amazing grace');
  });

  it('finds by title, lyrics, CCLI and tags; ranks title matches first', () => {
    const a = song('Amazing Grace', 'how sweet the sound', { meta: { ccli: '4755360', tags: ['hymn'] } });
    const b = song('Other song', 'amazing love how can it be');
    const c = song('Archived', 'amazing', { archived: true });
    const idx = new SearchIndex();
    idx.update([a, b, c], []);
    expect(idx.search('amazing').map((d) => d.id)).toEqual([a.id, b.id]);
    expect(idx.search('sweet sound').map((d) => d.id)).toEqual([a.id]);
    expect(idx.search('4755360').map((d) => d.id)).toEqual([a.id]);
    expect(idx.search('hymn').map((d) => d.id)).toEqual([a.id]);
    expect(idx.search('amazing', { includeArchived: true })).toHaveLength(3);
    expect(idx.search('', { tag: 'hymn' }).map((d) => d.id)).toEqual([a.id]);
  });

  it("finds a presentation by its tables' cells and its charts' titles, series and categories (M9)", () => {
    const base = song('Service order', 'welcome');
    const slide = m9Slide();
    // Only the table and the chart: no text object says these words.
    slide.objects = slide.objects.filter((o) => o.id === 'table' || o.id === 'chart');
    const p: Presentation = { ...base, sections: [{ ...base.sections[0]!, slides: [slide] }] };
    const idx = new SearchIndex();
    idx.update([p], []);
    for (const q of [
      'benediction',
      'pastor kim',
      'good shepherd',
      'our church in 2026',
      'visitors',
      'week 12',
    ])
      expect(
        idx.search(q).map((d) => d.id),
        q,
      ).toEqual([p.id]);
  });

  it('searches media and filters by kind', () => {
    const m: Media = {
      id: 'm1',
      rev: 1,
      name: 'Countdown loop',
      tags: ['motion'],
      kind: 'video',
      original: { hash: 'h', bytes: 1, mime: 'video/mp4', path: 'p' },
      state: 'ready',
      loop: true,
      isBackground: true,
    };
    const idx = new SearchIndex();
    idx.update([song('Countdown', 'x')], [m]);
    expect(idx.search('countdown', { kind: 'media' }).map((d) => d.id)).toEqual(['m1']);
    expect(idx.search('motion').map((d) => d.id)).toEqual(['m1']);
  });

  it('finds automatic verse and list numbers as people read them', () => {
    const p = song('Reading', 'placeholder');
    const slide = p.sections[0]!.slides[0]!;
    const body = slide.objects.find((o) => o.type === 'text')!;
    const numbered = {
      ...body,
      text: 'For God so loved the world\nFor God did not send his Son',
      paras: [
        { bullet: { auto: 'arabicParenBoth', startAt: 16 } },
        { bullet: { auto: 'arabicParenBoth', startAt: 16 } },
      ],
    };
    const q: Presentation = {
      ...p,
      sections: [{ ...p.sections[0]!, slides: [{ ...slide, objects: [numbered] }] }],
    };
    const idx = new SearchIndex();
    idx.update([q, song('Other', 'For God so loved')], []);
    expect(idx.search('17 for god').map((d) => d.id)).toEqual([q.id]);
  });

  it('answers in under 100 ms for 5,000 presentations', () => {
    const words = ['grace', 'love', 'light', 'king', 'holy', 'praise', 'glory', 'faith', 'hope', 'mercy'];
    const list: Presentation[] = [];
    for (let i = 0; i < 5000; i++) {
      const lyr = Array.from(
        { length: 12 },
        (_, j) => `${words[(i + j) % 10]} ${words[(i * 7 + j) % 10]} line ${j}`,
      ).join('\n');
      list.push(song(`Song ${i} ${words[i % 10]}`, lyr));
    }
    const idx = new SearchIndex();
    idx.update(list, []);
    const t0 = performance.now();
    const r = idx.search('holy mercy');
    const dt = performance.now() - t0;
    expect(r.length).toBeGreaterThan(0);
    expect(dt).toBeLessThan(100);
    // Rebuilding after a delta reuses memoized docs.
    const changed = [...list];
    changed[3] = { ...list[3]!, title: 'Renamed hymn' };
    const t1 = performance.now();
    idx.update(changed, []);
    expect(performance.now() - t1).toBeLessThan(budgetMs(50));
    expect(idx.search('renamed').map((d) => d.id)).toEqual([list[3]!.id]);
  });
});

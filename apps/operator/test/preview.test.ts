import type { Output } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import type { OutputHealthEntry } from '@ordo/protocol';
import { describe, expect, it } from 'vitest';
import { previewBlockedReason, previewMedia, previewTargets } from '../src/lib/preview.ts';

function out(id: string, p: Partial<Output> = {}): Output {
  return {
    id,
    name: id,
    kind: 'output',
    hostIndex: 1,
    lookId: 'look-main',
    enabled: true,
    audioMaster: false,
    ...p,
  };
}
function health(id: string, connected: boolean): OutputHealthEntry {
  return {
    outputId: id,
    connected,
    lastSeen: 0,
    presented: 0,
    missed: 0,
    longTasks: 0,
    lateFlips: 0,
    cache: { ready: 0, total: 0 },
    gpuLost: 0,
    videoDropped: 0,
  };
}

describe('send to preview (prd/03)', () => {
  const outputs = [
    out('a'),
    out('b', { enabled: false }),
    out('stage', { kind: 'stage', hostIndex: 0 }),
    out('lobby'),
  ];

  it('lists enabled audience outputs, connected first, while nothing is live', () => {
    const t = previewTargets(outputs, { lobby: health('lobby', true) }, initialState());
    expect(t.map((x) => [x.id, x.connected])).toEqual([
      ['lobby', true],
      ['a', false],
    ]);
    expect(previewBlockedReason(initialState(), t)).toBeNull();
  });

  it('is blocked while a playlist is live', () => {
    const live = { ...initialState(), mode: 'live' as const };
    const t = previewTargets(outputs, {}, live);
    expect(t).toEqual([]);
    expect(previewBlockedReason(live, t)).toMatch(/live/);
  });

  it('collects the media the previewed slide needs', () => {
    const p = {
      id: 'p',
      rev: 1,
      kind: 'deck' as const,
      title: 't',
      backgroundMediaId: 'bg',
      sections: [
        {
          id: 's',
          label: 'A',
          slides: [
            {
              id: 'sl1',
              backgroundMediaId: 'bg1',
              objects: [
                {
                  id: 'o',
                  type: 'image' as const,
                  box: { x: 0, y: 0, w: 1, h: 1 },
                  mediaId: 'img',
                  fit: 'contain' as const,
                  opacity: 1,
                  radius: 0,
                },
              ],
            },
            { id: 'sl2', backgroundMediaId: 'bg2', objects: [] },
          ],
        },
      ],
    } as unknown as Parameters<typeof previewMedia>[0];
    const lookup = (id: string) =>
      id === 'missing'
        ? undefined
        : ({ id } as Parameters<typeof previewMedia>[2] extends (id: string) => infer R
            ? NonNullable<R>
            : never);
    expect(previewMedia(p, 'sl1', lookup).map((m) => m.id)).toEqual(['bg', 'bg1', 'img']);
    expect(previewMedia(p, undefined, lookup).map((m) => m.id)).toEqual(['bg', 'bg1', 'img', 'bg2']);
  });

  it('says so when no output could preview', () => {
    expect(previewBlockedReason(initialState(), [])).toMatch(/No enabled audience output/);
  });
});

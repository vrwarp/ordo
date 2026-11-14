/**
 * The compact layout's Live now strip (design/28 §2.2, decision 12, §10 item 9; src/lib/liveStrip.ts): the live
 * plan and how many presentations it locks, never a cue label or slide text; unknown when offline or when the
 * source fails; hidden when idle or before the first answer.
 */
import { describe, expect, it } from 'vitest';
import { liveSheetText, liveStrip } from '../src/lib/liveStrip.ts';
import { fromSummary } from '../src/lib/venueLive.ts';

const base = { status: 'ok' as const, online: true, sessionOffline: false };

describe('liveStrip', () => {
  it('names the plan and the locked count', () => {
    const s = liveStrip({
      ...base,
      live: { playlistName: 'Sunday Service', presentationIds: ['a', 'b', 'c'] },
    });
    expect(s).toEqual({
      kind: 'live',
      text: 'Live at the venue: Sunday Service · 3 locked',
      name: 'Sunday Service',
      locked: 3,
    });
    expect(liveSheetText(s)).toBe(
      'A service is running at the venue. Sunday Service and its 3 presentations are locked until it ends. You can still look at everything and change anything else.',
    );
  });

  it('counts one', () => {
    const s = liveStrip({ ...base, live: { playlistName: 'Sunday Service', presentationIds: ['a'] } });
    expect(s.kind === 'live' && s.text).toBe('Live at the venue: Sunday Service · 1 locked');
    expect(liveSheetText(s)).toContain('Sunday Service and its 1 presentation are locked');
  });

  it('never carries the cue label, even from a summary that has one', () => {
    const live = fromSummary({
      seq: 4,
      mode: 'live',
      playlistId: 'p1',
      playlistName: 'Sunday Service',
      liveLabel: 'Amazing grace how sweet the sound',
      lockedPresentationIds: ['s1'],
    });
    expect(live?.cueLabel).toBe('Amazing grace how sweet the sound');
    const s = liveStrip({ ...base, live });
    expect(JSON.stringify(s)).not.toContain('Amazing grace');
    expect(liveSheetText(s)).not.toContain('Amazing grace');
  });

  it('is hidden while idle and before the first answer', () => {
    expect(liveStrip({ ...base, live: undefined }).kind).toBe('hidden');
    expect(
      liveStrip({ ...base, status: 'unknown', live: { playlistName: 'X', presentationIds: [] } }).kind,
    ).toBe('hidden');
  });

  it('is unknown when offline or when the source keeps failing', () => {
    const live = { playlistName: 'Sunday Service', presentationIds: ['a'] };
    expect(liveStrip({ ...base, online: false, live })).toMatchObject({
      kind: 'unknown',
      reason: 'offline',
      text: 'Live status unknown: offline',
    });
    expect(liveStrip({ ...base, sessionOffline: true, live: undefined }).kind).toBe('unknown');
    expect(liveStrip({ ...base, status: 'failing', live })).toMatchObject({
      kind: 'unknown',
      reason: 'unreachable',
      text: "Live status unknown: can't reach ordo",
    });
    expect(liveSheetText(liveStrip({ ...base, status: 'failing', live }))).not.toContain('Sunday Service');
  });

  it('bounds a long plan name', () => {
    const s = liveStrip({ ...base, live: { playlistName: 'x'.repeat(5000), presentationIds: [] } });
    expect(s.kind === 'live' && s.name.length).toBe(200);
  });
});

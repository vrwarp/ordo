import type { MidiMapping } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  clampQuickQCue,
  clampQuickQPlayback,
  decodeQuickQ,
  encodeQuickQ,
  formatMidiBytesHex,
  formatMidiCueSummary,
  formatQuickQ,
  formatQuickQCommand,
  formatQuickQMapping,
  levelPctToVelocity,
  QUICKQ_CHANNEL,
  QUICKQ_NOTE_ACTIVATE_BASE,
  QUICKQ_NOTE_GO_BASE,
  QUICKQ_NOTE_GOTO_BASE,
  QUICKQ_NOTE_PAUSE_BASE,
  validateQuickQCue,
  velocityToLevelPct,
} from './quickq.ts';

describe('QuickQ 20 MIDI codec', () => {
  it('encodes and decodes all 10 playbacks across all 5 actions', () => {
    for (let pb = 1; pb <= 10; pb++) {
      const goToCue = encodeQuickQ({ action: 'goToCue', playback: pb, cue: 12 });
      expect(goToCue).toEqual({
        type: 'noteOn',
        channel: QUICKQ_CHANNEL,
        number: QUICKQ_NOTE_GOTO_BASE + pb - 1,
        value: 12,
      });
      expect(decodeQuickQ(goToCue)).toEqual({ action: 'goToCue', playback: pb, cue: 12 });

      const activate = encodeQuickQ({ action: 'activate', playback: pb, levelPct: 100 });
      expect(activate).toEqual({
        type: 'noteOn',
        channel: QUICKQ_CHANNEL,
        number: QUICKQ_NOTE_ACTIVATE_BASE + pb - 1,
        value: 127,
      });
      expect(decodeQuickQ(activate)).toEqual({ action: 'activate', playback: pb, levelPct: 100 });

      const release = encodeQuickQ({ action: 'release', playback: pb });
      expect(release).toEqual({
        type: 'noteOff',
        channel: QUICKQ_CHANNEL,
        number: QUICKQ_NOTE_ACTIVATE_BASE + pb - 1,
        value: 0,
      });
      expect(decodeQuickQ(release)).toEqual({ action: 'release', playback: pb });

      const go = encodeQuickQ({ action: 'go', playback: pb });
      expect(go).toEqual({
        type: 'noteOn',
        channel: QUICKQ_CHANNEL,
        number: QUICKQ_NOTE_GO_BASE + pb - 1,
        value: 127,
      });
      expect(decodeQuickQ(go)).toEqual({ action: 'go', playback: pb });

      const pause = encodeQuickQ({ action: 'pause', playback: pb });
      expect(pause).toEqual({
        type: 'noteOn',
        channel: QUICKQ_CHANNEL,
        number: QUICKQ_NOTE_PAUSE_BASE + pb - 1,
        value: 127,
      });
      expect(decodeQuickQ(pause)).toEqual({ action: 'pause', playback: pb });
    }
  });

  it('uses authoritative Table 1 note numbers (PB 4 Go = 75, PB 10 Pause = 93)', () => {
    expect(encodeQuickQ({ action: 'go', playback: 4 }).number).toBe(75);
    expect(encodeQuickQ({ action: 'pause', playback: 10 }).number).toBe(93);
    expect(decodeQuickQ({ type: 'noteOn', channel: 1, number: 75, value: 127 })).toEqual({
      action: 'go',
      playback: 4,
    });
    expect(decodeQuickQ({ type: 'noteOn', channel: 1, number: 93, value: 127 })).toEqual({
      action: 'pause',
      playback: 10,
    });
  });

  it('treats noteOn velocity 0 on notes 60-69 as Release (MIDI running-status convention)', () => {
    expect(decodeQuickQ({ type: 'noteOn', channel: 1, number: 60, value: 0 })).toEqual({
      action: 'release',
      playback: 1,
    });
    // Velocity 0 on Go to Cue / Go / Pause is not a valid trigger
    expect(decodeQuickQ({ type: 'noteOn', channel: 1, number: 48, value: 0 })).toBeNull();
    expect(decodeQuickQ({ type: 'noteOn', channel: 1, number: 72, value: 0 })).toBeNull();
  });

  it('rejects non-channel-1, non-note, and out-of-range note messages', () => {
    expect(decodeQuickQ({ type: 'noteOn', channel: 2, number: 48, value: 1 })).toBeNull();
    expect(decodeQuickQ({ type: 'cc', channel: 1, number: 48, value: 127 })).toBeNull();
    expect(decodeQuickQ({ type: 'programChange', channel: 1, number: 48, value: 0 })).toBeNull();
    expect(decodeQuickQ({ type: 'noteOn', channel: 1, number: 58, value: 127 })).toBeNull();
    expect(decodeQuickQ({ type: 'noteOn', channel: 1, number: 94, value: 127 })).toBeNull();
    expect(decodeQuickQ({ type: 'noteOff', channel: 1, number: 72, value: 0 })).toBeNull();
  });

  it('clamps playback, cue, and converts level % <-> velocity cleanly', () => {
    expect(clampQuickQPlayback(0)).toBe(1);
    expect(clampQuickQPlayback(99)).toBe(10);
    expect(clampQuickQPlayback(Number.NaN)).toBe(1);

    expect(clampQuickQCue(0)).toBe(1);
    expect(clampQuickQCue(200)).toBe(127);
    expect(clampQuickQCue(5.6)).toBe(6);

    expect(levelPctToVelocity(100)).toBe(127);
    expect(levelPctToVelocity(50)).toBe(64);
    expect(levelPctToVelocity(1)).toBeGreaterThanOrEqual(1);
    expect(velocityToLevelPct(127)).toBe(100);
    expect(velocityToLevelPct(64)).toBe(50);
  });

  it('formats QuickQ commands, mappings, summaries, and hex bytes', () => {
    expect(formatQuickQCommand({ action: 'goToCue', playback: 2, cue: 5 })).toBe('QuickQ PB 2 · Go to Cue 5');
    expect(formatQuickQCommand({ action: 'activate', playback: 1, levelPct: 100 })).toBe(
      'QuickQ PB 1 · Activate 100%',
    );
    expect(formatQuickQCommand({ action: 'activate', playback: 1, levelPct: 50 })).toBe(
      'QuickQ PB 1 · Activate 50%',
    );
    expect(formatQuickQCommand({ action: 'release', playback: 3 })).toBe('QuickQ PB 3 · Release');
    expect(formatQuickQCommand({ action: 'go', playback: 4 })).toBe('QuickQ PB 4 · Go');
    expect(formatQuickQCommand({ action: 'pause', playback: 10 })).toBe('QuickQ PB 10 · Pause');

    expect(formatQuickQ({ type: 'noteOn', channel: 1, number: 72, value: 127 })).toBe('QuickQ PB 1 · Go');
    expect(formatMidiCueSummary({ type: 'noteOn', channel: 1, number: 48, value: 3 })).toBe(
      'QuickQ PB 1 · Go to Cue 3',
    );
    expect(formatMidiCueSummary({ type: 'cc', channel: 2, number: 7, value: 100 })).toBe('Ch 2 CC #7 = 100');
    expect(formatMidiBytesHex([0x90, 48, 5])).toBe('90 30 05');

    const mapGo: MidiMapping = {
      id: '1',
      kind: 'note',
      number: 72,
      channel: 1,
      threshold: 1,
      action: { id: 'next' },
    };
    const mapRel: MidiMapping = {
      id: '2',
      kind: 'noteOff',
      number: 60,
      channel: 1,
      threshold: 0,
      action: { id: 'clearSlide' },
    };
    const mapOtherCh: MidiMapping = {
      id: '3',
      kind: 'note',
      number: 72,
      channel: 2,
      threshold: 1,
      action: { id: 'next' },
    };
    expect(formatQuickQMapping(mapGo)).toBe('QuickQ PB 1 · Go');
    expect(formatQuickQMapping(mapRel)).toBe('QuickQ PB 1 · Release');
    expect(formatQuickQMapping(mapOtherCh)).toBeNull();
  });

  it('produces actionable QuickQ validation warnings for incompatible raw cues', () => {
    expect(validateQuickQCue({ type: 'noteOn', channel: 1, number: 48, value: 3 })).toEqual([]);
    expect(validateQuickQCue({ type: 'cc', channel: 1, number: 10, value: 64 })[0]).toContain(
      'Note On/Off only',
    );
    expect(validateQuickQCue({ type: 'noteOn', channel: 2, number: 48, value: 3 })[0]).toContain('Channel 1');
    expect(validateQuickQCue({ type: 'noteOn', channel: 1, number: 48, value: 0 })[0]).toContain(
      'velocity 1–127',
    );
    expect(validateQuickQCue({ type: 'noteOn', channel: 1, number: 30, value: 127 })[0]).toContain(
      'outside QuickQ 20 ranges',
    );
  });
});

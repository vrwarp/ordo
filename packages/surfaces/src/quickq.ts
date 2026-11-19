import type { MidiCue, MidiCueType, MidiMapping } from '@ordo/domain';

/**
 * ChamSys QuickQ 20 MIDI protocol helpers (QuickQ v10 Manual, Chapter 12 Table 1).
 *
 * Fixed to MIDI Channel 1, Playbacks 1–10, Note On / Note Off only:
 *   - 48–57 (47 + pb): Note On  → Go to Cue (velocity = whole cue number 1–127)
 *   - 60–69 (59 + pb): Note On  → Activate Playback (velocity = level 1–127)
 *   - 60–69 (59 + pb): Note Off → Release Playback
 *   - 72–81 (71 + pb): Note On  → Go on Playback
 *   - 84–93 (83 + pb): Note On  → Pause / Go Back on Playback
 *
 * Note: ChamSys's v10 manual prose examples contain typos (PB 4 Go printed as 74 instead of 75,
 * PB 10 Pause printed as 57 instead of 93). This module follows Table 1 (`base + pb - 1`).
 */

export const QUICKQ_CHANNEL = 1;
export const QUICKQ_PLAYBACK_MIN = 1;
export const QUICKQ_PLAYBACK_MAX = 10;
export const QUICKQ_CUE_MIN = 1;
export const QUICKQ_CUE_MAX = 127;

export const QUICKQ_NOTE_GOTO_BASE = 48;
export const QUICKQ_NOTE_ACTIVATE_BASE = 60;
export const QUICKQ_NOTE_GO_BASE = 72;
export const QUICKQ_NOTE_PAUSE_BASE = 84;

export type QuickQAction = 'goToCue' | 'activate' | 'release' | 'go' | 'pause';

export type QuickQCommand = {
  playback: number;
  action: QuickQAction;
  /** Whole cue number 1..127 (only for 'goToCue'). */
  cue?: number;
  /** Playback level percentage 1..100 (only for 'activate'). */
  levelPct?: number;
};

export type QuickQEncodedMidi = {
  channel: 1;
  type: 'noteOn' | 'noteOff';
  number: number;
  value: number;
};

export function clampQuickQPlayback(pb: number): number {
  const n = Math.round(Number.isFinite(pb) ? pb : 1);
  return Math.max(QUICKQ_PLAYBACK_MIN, Math.min(QUICKQ_PLAYBACK_MAX, n));
}

export function clampQuickQCue(cue: number): number {
  const n = Math.round(Number.isFinite(cue) ? cue : 1);
  return Math.max(QUICKQ_CUE_MIN, Math.min(QUICKQ_CUE_MAX, n));
}

/** Converts a 1..100% level to MIDI velocity 1..127 (never 0, which MIDI treats as Note Off). */
export function levelPctToVelocity(pct: number): number {
  const clamped = Math.max(1, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 100)));
  return Math.max(1, Math.min(127, Math.round((clamped / 100) * 127)));
}

/** Converts a MIDI velocity 0..127 to a 0..100% level. */
export function velocityToLevelPct(vel: number): number {
  const clamped = Math.max(0, Math.min(127, Math.round(Number.isFinite(vel) ? vel : 0)));
  if (clamped === 0) return 0;
  return Math.max(1, Math.min(100, Math.round((clamped / 127) * 100)));
}

export function encodeQuickQ(cmd: QuickQCommand): QuickQEncodedMidi {
  const pb = clampQuickQPlayback(cmd.playback);
  const offset = pb - 1;
  switch (cmd.action) {
    case 'goToCue':
      return {
        channel: QUICKQ_CHANNEL,
        type: 'noteOn',
        number: QUICKQ_NOTE_GOTO_BASE + offset,
        value: clampQuickQCue(cmd.cue ?? 1),
      };
    case 'activate':
      return {
        channel: QUICKQ_CHANNEL,
        type: 'noteOn',
        number: QUICKQ_NOTE_ACTIVATE_BASE + offset,
        value: levelPctToVelocity(cmd.levelPct ?? 100),
      };
    case 'release':
      return {
        channel: QUICKQ_CHANNEL,
        type: 'noteOff',
        number: QUICKQ_NOTE_ACTIVATE_BASE + offset,
        value: 0,
      };
    case 'go':
      return {
        channel: QUICKQ_CHANNEL,
        type: 'noteOn',
        number: QUICKQ_NOTE_GO_BASE + offset,
        value: 127,
      };
    case 'pause':
      return {
        channel: QUICKQ_CHANNEL,
        type: 'noteOn',
        number: QUICKQ_NOTE_PAUSE_BASE + offset,
        value: 127,
      };
  }
}

export type QuickQDecodable = {
  channel?: number;
  type?: MidiCueType;
  kind?: 'noteOn' | 'noteOff' | 'cc' | 'programChange';
  number: number;
  value?: number;
};

/** Decodes a Channel 1 Note On/Off message into a QuickQ 20 command, or null if not a QuickQ command. */
export function decodeQuickQ(msg: QuickQDecodable): QuickQCommand | null {
  const channel = msg.channel ?? QUICKQ_CHANNEL;
  if (channel !== QUICKQ_CHANNEL) return null;

  const rawKind = msg.type ?? msg.kind;
  if (rawKind !== 'noteOn' && rawKind !== 'noteOff') return null;

  const note = msg.number;
  const val = msg.value ?? 127;
  // In MIDI, Note On with velocity 0 is equivalent to Note Off.
  const effectiveKind = rawKind === 'noteOn' && val === 0 ? 'noteOff' : rawKind;

  if (effectiveKind === 'noteOff') {
    if (note >= QUICKQ_NOTE_ACTIVATE_BASE && note <= QUICKQ_NOTE_ACTIVATE_BASE + 9) {
      return { playback: note - QUICKQ_NOTE_ACTIVATE_BASE + 1, action: 'release' };
    }
    return null;
  }

  if (note >= QUICKQ_NOTE_GOTO_BASE && note <= QUICKQ_NOTE_GOTO_BASE + 9) {
    return { playback: note - QUICKQ_NOTE_GOTO_BASE + 1, action: 'goToCue', cue: val };
  }
  if (note >= QUICKQ_NOTE_ACTIVATE_BASE && note <= QUICKQ_NOTE_ACTIVATE_BASE + 9) {
    return {
      playback: note - QUICKQ_NOTE_ACTIVATE_BASE + 1,
      action: 'activate',
      levelPct: velocityToLevelPct(val),
    };
  }
  if (note >= QUICKQ_NOTE_GO_BASE && note <= QUICKQ_NOTE_GO_BASE + 9) {
    return { playback: note - QUICKQ_NOTE_GO_BASE + 1, action: 'go' };
  }
  if (note >= QUICKQ_NOTE_PAUSE_BASE && note <= QUICKQ_NOTE_PAUSE_BASE + 9) {
    return { playback: note - QUICKQ_NOTE_PAUSE_BASE + 1, action: 'pause' };
  }
  return null;
}

export function formatQuickQCommand(cmd: QuickQCommand): string {
  const pb = `QuickQ PB ${cmd.playback}`;
  switch (cmd.action) {
    case 'goToCue':
      return `${pb} · Go to Cue ${cmd.cue ?? 1}`;
    case 'activate':
      return `${pb} · Activate ${cmd.levelPct ?? 100}%`;
    case 'release':
      return `${pb} · Release`;
    case 'go':
      return `${pb} · Go`;
    case 'pause':
      return `${pb} · Pause`;
  }
}

export function formatQuickQ(msg: QuickQDecodable): string | null {
  const cmd = decodeQuickQ(msg);
  return cmd ? formatQuickQCommand(cmd) : null;
}

/** Human-readable label for a MIDI input mapping if it matches a QuickQ 20 Channel 1 note. */
export function formatQuickQMapping(
  m: Pick<MidiMapping, 'kind' | 'channel' | 'number' | 'paramSource'>,
): string | null {
  if (m.channel !== undefined && m.channel !== QUICKQ_CHANNEL) return null;
  if (m.kind === 'noteOff') {
    if (m.number >= QUICKQ_NOTE_ACTIVATE_BASE && m.number <= QUICKQ_NOTE_ACTIVATE_BASE + 9) {
      return `QuickQ PB ${m.number - QUICKQ_NOTE_ACTIVATE_BASE + 1} · Release`;
    }
    return null;
  }
  if (m.kind !== 'note') return null;
  const n = m.number;
  if (n >= QUICKQ_NOTE_GOTO_BASE && n <= QUICKQ_NOTE_GOTO_BASE + 9) {
    const pb = n - QUICKQ_NOTE_GOTO_BASE + 1;
    return m.paramSource === 'velocity' ? `QuickQ PB ${pb} · Go to Cue (vel)` : `QuickQ PB ${pb} · Go to Cue`;
  }
  if (n >= QUICKQ_NOTE_ACTIVATE_BASE && n <= QUICKQ_NOTE_ACTIVATE_BASE + 9) {
    return `QuickQ PB ${n - QUICKQ_NOTE_ACTIVATE_BASE + 1} · Activate`;
  }
  if (n >= QUICKQ_NOTE_GO_BASE && n <= QUICKQ_NOTE_GO_BASE + 9) {
    return `QuickQ PB ${n - QUICKQ_NOTE_GO_BASE + 1} · Go`;
  }
  if (n >= QUICKQ_NOTE_PAUSE_BASE && n <= QUICKQ_NOTE_PAUSE_BASE + 9) {
    return `QuickQ PB ${n - QUICKQ_NOTE_PAUSE_BASE + 1} · Pause`;
  }
  return null;
}

/** Human-readable summary for a slide MidiCue (QuickQ format when matched, concise raw MIDI otherwise). */
export function formatMidiCueSummary(
  cue: Pick<MidiCue, 'channel' | 'type' | 'number' | 'value' | 'delayMs'>,
): string {
  const qq = formatQuickQ(cue);
  const base =
    qq ??
    (cue.type === 'programChange'
      ? `Ch ${cue.channel} Prog #${cue.number}`
      : cue.type === 'cc'
        ? `Ch ${cue.channel} CC #${cue.number} = ${cue.value}`
        : `Ch ${cue.channel} ${cue.type === 'noteOff' ? 'Note Off' : 'Note On'} #${cue.number} vel ${cue.value}`);
  return cue.delayMs && cue.delayMs > 0 ? `${base} (+${cue.delayMs}ms)` : base;
}

function isInQuickQNoteRange(note: number): boolean {
  return (
    (note >= QUICKQ_NOTE_GOTO_BASE && note <= QUICKQ_NOTE_GOTO_BASE + 9) ||
    (note >= QUICKQ_NOTE_ACTIVATE_BASE && note <= QUICKQ_NOTE_ACTIVATE_BASE + 9) ||
    (note >= QUICKQ_NOTE_GO_BASE && note <= QUICKQ_NOTE_GO_BASE + 9) ||
    (note >= QUICKQ_NOTE_PAUSE_BASE && note <= QUICKQ_NOTE_PAUSE_BASE + 9)
  );
}

/**
 * Returns non-blocking warnings when a raw MIDI cue does not match ChamSys QuickQ 20's MIDI spec.
 * Empty array means the cue is valid for QuickQ 20.
 */
export function validateQuickQCue(cue: Pick<MidiCue, 'channel' | 'type' | 'number' | 'value'>): string[] {
  const warnings: string[] = [];
  if (cue.channel !== QUICKQ_CHANNEL) {
    warnings.push('QuickQ 20 only listens on MIDI Channel 1.');
  }
  if (cue.type === 'cc' || cue.type === 'programChange') {
    warnings.push('QuickQ 20 ignores CC and Program Change (uses Note On/Off only).');
    return warnings;
  }
  if (cue.type === 'noteOff') {
    if (cue.number < QUICKQ_NOTE_ACTIVATE_BASE || cue.number > QUICKQ_NOTE_ACTIVATE_BASE + 9) {
      warnings.push('QuickQ 20 only uses Note Off on notes 60–69 (Release Playbacks 1–10).');
    }
    return warnings;
  }
  if (!isInQuickQNoteRange(cue.number)) {
    warnings.push(
      `Note #${cue.number} is outside QuickQ 20 ranges (48–57 Go to Cue, 60–69 Activate, 72–81 Go, 84–93 Pause).`,
    );
  } else if (cue.value === 0) {
    if (cue.number >= QUICKQ_NOTE_GOTO_BASE && cue.number <= QUICKQ_NOTE_GOTO_BASE + 9) {
      warnings.push('Go to Cue requires velocity 1–127 (velocity 0 is treated as Note Off).');
    } else if (cue.number >= QUICKQ_NOTE_ACTIVATE_BASE && cue.number <= QUICKQ_NOTE_ACTIVATE_BASE + 9) {
      warnings.push('Note On with velocity 0 acts as Note Off; use Release instead.');
    } else {
      warnings.push('Velocity 0 is treated as Note Off; use velocity ≥ 1.');
    }
  }
  return warnings;
}

/** Formats raw MIDI bytes as uppercase space-separated hex (e.g. "90 30 05"). */
export function formatMidiBytesHex(bytes: Uint8Array | readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push((bytes[i]! & 0xff).toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(' ');
}

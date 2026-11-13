import { describe, expect, it } from 'vitest';
import { DEFAULT_SURFACES, upgradeStoredSurfaces } from './defaults.ts';
import { SurfaceSettings } from './schemas.ts';

/** Stored surface settings from before MIDI became opt-in (review 2026-11-13). */
describe('upgradeStoredSurfaces', () => {
  const { midiEnabled: _, ...old } = DEFAULT_SURFACES;
  const read = (raw: unknown) => SurfaceSettings.parse(upgradeStoredSurfaces(raw));

  it('reads settings with MIDI mappings and no midiEnabled as enabled', () => {
    expect(read(old).midiEnabled).toBe(true);
    expect(read({ midi: [old.midi[0]] }).midiEnabled).toBe(true);
  });

  it('keeps a stored choice, and leaves a venue without mappings off', () => {
    expect(read({ ...old, midiEnabled: false }).midiEnabled).toBe(false);
    expect(read({ ...old, midiEnabled: true }).midiEnabled).toBe(true);
    expect(read({ ...old, midi: [] }).midiEnabled).toBe(false);
    expect(read({ streamDeckPages: [] }).midiEnabled).toBe(false);
  });

  it('returns anything else as it is, for the schema to judge', () => {
    for (const raw of [undefined, null, 3, 'x', [], { midi: 'nope' }])
      expect(upgradeStoredSurfaces(raw)).toBe(raw);
    const stored = { ...old, midiEnabled: false };
    expect(upgradeStoredSurfaces(stored)).toBe(stored);
  });
});

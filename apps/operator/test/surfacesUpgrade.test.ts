import { DEFAULT_SURFACES } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { withDefaults } from '../src/core/libraryStore.ts';

/**
 * MIDI after an upgrade (review 2026-11-13): an operator that starts from a library copy cached before MIDI
 * became opt-in reads its surfaces as the hub does, so the pedals start without a click on Enable Web MIDI.
 */
describe('surfaces of a cached library copy', () => {
  const { midiEnabled: _, ...old } = DEFAULT_SURFACES;

  it('reads MIDI as enabled when the copy has mappings and no midiEnabled', () => {
    expect(withDefaults({ surfaces: old as never }).surfaces.midiEnabled).toBe(true);
  });

  it('keeps it off without mappings, and keeps a stored choice', () => {
    expect(withDefaults({ surfaces: { ...old, midi: [] } as never }).surfaces.midiEnabled).toBe(false);
    expect(withDefaults({ surfaces: { ...old, midiEnabled: false } }).surfaces.midiEnabled).toBe(false);
    expect(withDefaults({}).surfaces.midiEnabled).toBe(false);
  });
});

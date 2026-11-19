import {
  type MidiCue,
  type MidiPreset,
  type MidiTrigger,
  newId,
  type Presentation,
  type Slide,
  type SurfaceSettings,
} from '@ordo/domain';
import { lazy, Suspense, useState } from 'react';
import { useLibrary } from '../state/library.ts';

const LazySlideMidiCues = lazy(() =>
  import('../views/editor/SlideMidiCues.tsx').then((m) => ({ default: m.SlideMidiCues })),
);

function formatCueBrief(c: MidiCue): string {
  const delay = c.delayMs ? ` +${c.delayMs}ms` : '';
  if (c.channel === 1 && c.type === 'noteOn' && c.number >= 48 && c.number <= 57 && c.value >= 1) {
    return `QuickQ PB ${c.number - 47} → Cue ${c.value}${delay}`;
  }
  if (c.type === 'programChange') return `Ch ${c.channel} PC ${c.number}${delay}`;
  if (c.type === 'cc') return `Ch ${c.channel} CC ${c.number} = ${c.value}${delay}`;
  if (c.type === 'noteOff') return `Ch ${c.channel} NoteOff ${c.number}${delay}`;
  return `Ch ${c.channel} Note ${c.number} vel ${c.value}${delay}`;
}

export type MidiBadgeInfo = {
  label: string;
  color?: string;
  title: string;
  missing?: boolean;
};

/** Effective MidiTrigger for a Slide, falling back to legacy `slide.midiCues`. */
export function slideMidiTrigger(slide: Pick<Slide, 'midi' | 'midiCues'>): MidiTrigger | undefined {
  if (slide.midi) return slide.midi;
  if (slide.midiCues?.length) return { kind: 'cues', cues: slide.midiCues };
  return undefined;
}

/** Progressive disclosure: hide MIDI controls for venues that have MIDI off, 0 presets, and no existing triggers. */
export function shouldShowMidiUi(
  surfacesSettings: Pick<SurfaceSettings, 'midiEnabled' | 'midiPresets'> | undefined,
  hasExisting: boolean,
): boolean {
  if (hasExisting) return true;
  if (!surfacesSettings) return false;
  return surfacesSettings.midiEnabled || (surfacesSettings.midiPresets?.length ?? 0) > 0;
}

/** Count internal section and slide MIDI triggers on a Presentation (shown as a read-only note in ItemSettings). */
export function countPresentationMidi(p: Presentation): { sections: number; slides: number } {
  let sections = 0;
  let slides = 0;
  for (const s of p.sections) {
    if (s.midi) sections++;
    for (const sl of s.slides) {
      if (slideMidiTrigger(sl)) slides++;
    }
  }
  return { sections, slides };
}

/** Format a compact badge & tooltip for any MidiTrigger against the venue's MidiPresets. */
export function midiTriggerBadge(
  trigger: MidiTrigger | undefined,
  presets: readonly MidiPreset[] | undefined,
): MidiBadgeInfo | null {
  if (!trigger) return null;
  if (trigger.kind === 'preset') {
    const preset = presets?.find((p) => p.id === trigger.presetId);
    if (!preset) {
      return {
        label: '(missing preset)',
        title: 'This lighting preset was deleted in Settings → MIDI. Pick another preset or clear it.',
        missing: true,
      };
    }
    const detail = preset.cues.map(formatCueBrief).join('; ');
    return {
      label: preset.name,
      color: preset.color,
      title: `${preset.name} (${detail})`,
    };
  }
  if (!trigger.cues.length) return null;
  const summary = trigger.cues.map(formatCueBrief).join('; ');
  return {
    label: trigger.cues.length === 1 ? summary : `${trigger.cues.length} MIDI cues`,
    title: `MIDI: ${summary}`,
  };
}

/**
 * Preset-first MIDI trigger picker shared by Playlist Item settings, Section headers, and Slide editors.
 * Keeps custom inline MIDI cues tucked behind a disclosure so worship leads see named lighting presets first.
 */
export function MidiTriggerPicker(props: {
  value?: MidiTrigger;
  onChange: (next: MidiTrigger | undefined) => void;
  disabled?: boolean;
  hint?: string;
  compact?: boolean;
}) {
  const presets = useLibrary((s) => s.data.settings.surfaces.midiPresets ?? []);
  const { value, onChange, disabled, hint, compact } = props;
  const [showCustom, setShowCustom] = useState(value?.kind === 'cues');

  const isCustom = value?.kind === 'cues';
  const selectedPresetId = value?.kind === 'preset' ? value.presetId : '';
  const missingPreset = Boolean(selectedPresetId && !presets.some((p) => p.id === selectedPresetId));

  const selectValue = isCustom ? '__custom' : selectedPresetId;

  const handleSelect = (val: string) => {
    if (val === '') {
      setShowCustom(false);
      onChange(undefined);
      return;
    }
    if (val === '__custom') {
      setShowCustom(true);
      if (value?.kind !== 'cues') {
        const starter: MidiCue = {
          id: newId(),
          channel: 1,
          type: 'noteOn',
          number: 48,
          value: 1,
        };
        onChange({ kind: 'cues', cues: [starter] });
      }
      return;
    }
    setShowCustom(false);
    onChange({ kind: 'preset', presetId: val });
  };

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
        <select
          value={selectValue}
          disabled={disabled}
          style={{ flex: 1, minWidth: compact ? 150 : 180 }}
          onChange={(e) => handleSelect(e.target.value)}
        >
          <option value="">None</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {missingPreset && <option value={selectedPresetId}>(missing preset)</option>}
          <option value="__custom">Custom MIDI…</option>
        </select>
        {value && !disabled && (
          <button
            type="button"
            className="small ghost"
            title="Clear lighting / MIDI trigger"
            onClick={() => {
              setShowCustom(false);
              onChange(undefined);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {presets.length === 0 && !isCustom && (
        <span className="muted" style={{ fontSize: 11 }}>
          No lighting presets yet — create them in <b>Settings → MIDI</b>.
        </span>
      )}

      {hint && (
        <span className="muted" style={{ fontSize: 11 }}>
          {hint}
        </span>
      )}

      {(isCustom || showCustom) && (
        <Suspense fallback={<span className="muted small">Loading MIDI editor…</span>}>
          <LazySlideMidiCues
            cues={value?.kind === 'cues' ? value.cues : []}
            readOnly={Boolean(disabled)}
            onChange={(nextCues) => {
              if (!nextCues?.length) {
                setShowCustom(false);
                onChange(undefined);
              } else {
                onChange({ kind: 'cues', cues: nextCues });
              }
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

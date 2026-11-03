import { Check, NumberField, Select, TextField } from '../../components/fields.tsx';
import { useLibrary } from '../../state/library.ts';
import { BackgroundPicker } from '../editor/BackgroundPicker.tsx';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

function timeZones(): string[] {
  const i = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return i.supportedValuesOf?.('timeZone') ?? ['UTC'];
  } catch {
    return ['UTC'];
  }
}

export function GeneralPage() {
  const { draft, setDraft, save, revert, saving, dirty } = useSettingsDraft('general');
  const themes = useLibrary((s) => s.data.themes);
  const zones = timeZones();
  if (!zones.includes(draft.timeZone)) zones.unshift(draft.timeZone);
  return (
    <div className="col" style={{ gap: 12, maxWidth: 640 }}>
      <h2>General</h2>
      <TextField
        label="Venue name"
        value={draft.venueName}
        onChange={(venueName) => setDraft({ ...draft, venueName })}
      />
      <Select
        label="Time zone (countdowns and clocks)"
        value={draft.timeZone}
        options={zones}
        onChange={(timeZone) => setDraft({ ...draft, timeZone })}
      />
      <Check
        label="24-hour clock"
        value={draft.clock24h}
        onChange={(clock24h) => setDraft({ ...draft, clock24h })}
      />
      <label className="field">
        <span>Logo (shown by the Logo action)</span>
        <BackgroundPicker
          value={draft.logoMediaId}
          onChange={(logoMediaId) => setDraft({ ...draft, logoMediaId })}
        />
      </label>
      <Select
        label="Default theme for new songs"
        value={draft.defaultThemeId ?? ''}
        options={[
          { value: '', label: 'First theme' },
          ...themes.map((t) => ({ value: t.id, label: t.name })),
        ]}
        onChange={(v) => setDraft({ ...draft, defaultThemeId: v || undefined })}
      />
      <NumberField
        label="Default lines per slide"
        value={draft.defaultLinesPerSlide}
        min={1}
        max={12}
        onChange={(defaultLinesPerSlide) => setDraft({ ...draft, defaultLinesPerSlide })}
      />
      <NumberField
        label="GO lead time (ms)"
        value={draft.defaultPreRollMs}
        min={0}
        max={500}
        onChange={(defaultPreRollMs) => setDraft({ ...draft, defaultPreRollMs })}
      />
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onRevert={revert} />
    </div>
  );
}

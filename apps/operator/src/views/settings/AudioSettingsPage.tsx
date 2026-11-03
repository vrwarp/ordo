import { type AudioDevice, listAudioOutputs, PreviewPlayer, unlockDeviceLabels } from '@ordo/audio';
import { newId } from '@ordo/domain';
import { useEffect, useState } from 'react';
import { NumberField, Select } from '../../components/fields.tsx';
import { MUTE_DB } from '../../services/controller.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

/** Audio devices, named stereo pairs, default pair and master (prd/06). Channels are 0-based in data, 1-based here. */
export function AudioSettingsPage() {
  const { draft, setDraft, save, revert, saving, dirty } = useSettingsDraft('audio');
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = async (probe = false) => {
    setBusy(true);
    try {
      setDevices(await listAudioOutputs({ probe }));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional dependency list
  useEffect(() => {
    void refresh();
  }, []);
  const house = devices.find((d) => d.deviceId === draft.houseDeviceId);
  const channels = house?.channels ?? 2;
  const devOptions = [
    { value: '', label: 'System default' },
    ...devices.map((d) => ({
      value: d.deviceId,
      label: `${d.label || 'Unnamed device'}${d.channels ? ` (${d.channels} ch)` : ''}`,
    })),
  ];
  const pickDevice = (which: 'house' | 'preview', id: string) => {
    const d = devices.find((x) => x.deviceId === id);
    // Device ids differ per origin: always store the label so outputs can match by label.
    if (which === 'house')
      setDraft({ ...draft, houseDeviceId: id || undefined, houseDeviceLabel: d?.label || undefined });
    else setDraft({ ...draft, previewDeviceId: id || undefined, previewDeviceLabel: d?.label || undefined });
  };
  const chOptions = Array.from(
    { length: Math.max(channels, 2, ...draft.pairs.flatMap((p) => [p.left + 1, p.right + 1])) },
    (_, i) => ({
      value: String(i),
      label: `Ch ${i + 1}`,
    }),
  );
  return (
    <div className="col" style={{ gap: 12 }}>
      <h2>Audio</h2>
      <div className="row wrap">
        <button
          type="button"
          onClick={async () => {
            if (await unlockDeviceLabels()) await refresh(true);
            else toast('Chrome did not grant microphone permission; device names stay hidden.', 'warn');
          }}
        >
          Show device names
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh(true)}>
          Refresh and count channels
        </button>
      </div>
      <div className="card col">
        <Select
          label="House output device (audio master output plays here)"
          value={draft.houseDeviceId ?? ''}
          options={devOptions}
          onChange={(v) => pickDevice('house', v)}
        />
        {draft.houseDeviceLabel && !house && (
          <span className="muted small">Saved device: {draft.houseDeviceLabel}</span>
        )}
        <Select
          label="Preview device (operator audition; never the house pairs)"
          value={draft.previewDeviceId ?? ''}
          options={devOptions}
          onChange={(v) => pickDevice('preview', v)}
        />
        <div className="row">
          <button
            type="button"
            className="small"
            onClick={async () => {
              const p = new PreviewPlayer(draft.previewDeviceId);
              const url = testToneUrl();
              try {
                await p.play(url, -12);
                setTimeout(() => p.stop(), 1200);
              } catch (e) {
                toast(errorText(e), 'error');
              }
            }}
          >
            Test preview device
          </button>
        </div>
      </div>
      <div className="card col">
        <h4>Stereo pairs</h4>
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Left</th>
              <th>Right</th>
              <th>Default</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.pairs.map((p) => (
              <tr key={p.id}>
                <td>
                  <input
                    value={p.name}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        pairs: draft.pairs.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)),
                      })
                    }
                  />
                </td>
                <td>
                  <Select
                    value={String(p.left)}
                    options={chOptions}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        pairs: draft.pairs.map((x) => (x.id === p.id ? { ...x, left: Number(v) } : x)),
                      })
                    }
                  />
                </td>
                <td>
                  <Select
                    value={String(p.right)}
                    options={chOptions}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        pairs: draft.pairs.map((x) => (x.id === p.id ? { ...x, right: Number(v) } : x)),
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="radio"
                    checked={draft.defaultPairId === p.id}
                    onChange={() => setDraft({ ...draft, defaultPairId: p.id })}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="small ghost"
                    onClick={() => setDraft({ ...draft, pairs: draft.pairs.filter((x) => x.id !== p.id) })}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          className="small"
          onClick={() => {
            const n = draft.pairs.length;
            setDraft({
              ...draft,
              pairs: [...draft.pairs, { id: newId(), name: `Pair ${n + 1}`, left: n * 2, right: n * 2 + 1 }],
            });
          }}
        >
          + Pair
        </button>
      </div>
      <div className="card col">
        <NumberField
          label="Master (dB)"
          value={draft.masterDb <= MUTE_DB + 1 ? MUTE_DB : draft.masterDb}
          min={MUTE_DB}
          max={12}
          onChange={(masterDb) => setDraft({ ...draft, masterDb })}
          suffix={draft.masterDb <= MUTE_DB + 1 ? 'muted' : 'dB'}
        />
        <span className="muted small">Master gain and mute are also in the operator view's bottom bar.</span>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onRevert={revert} />
    </div>
  );
}

let toneUrl: string | undefined;
/** A 1 s 440 Hz WAV for testing the preview device. */
function testToneUrl(): string {
  if (toneUrl) return toneUrl;
  const rate = 44100;
  const n = rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++)
    v.setInt16(
      44 + i * 2,
      Math.sin((2 * Math.PI * 440 * i) / rate) * 8000 * Math.min(1, (n - i) / 2000),
      true,
    );
  toneUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return toneUrl;
}

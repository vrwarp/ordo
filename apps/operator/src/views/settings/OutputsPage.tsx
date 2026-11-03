import { api, appEnv, roleUrl } from '@ordo/client';
import { newId, type Output } from '@ordo/domain';
import { useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { Check } from '../../components/fields.tsx';
import { type ScreenInfo, toScreenRef } from '../../lib/screens.ts';
import { outputWindows, useLaunch } from '../../services/outputs.ts';
import { saveSettings, settings, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

export function OutputsPage() {
  const { draft, setDraft, save, revert, saving, dirty } = useSettingsDraft('outputs');
  const looks = useLibrary((s) => s.data.settings.looks);
  const open = useLaunch((s) => s.open);
  const [screens, setScreens] = useState<ScreenInfo[]>([]);
  const set = (id: string, patch: Partial<Output>) =>
    setDraft((list) => list.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const add = (kind: 'output' | 'stage') => {
    const used = new Set(draft.map((o) => o.hostIndex));
    let k = 1;
    while (used.has(k) && k < 6) k++;
    const lookId =
      kind === 'stage'
        ? (looks.find((l) => l.kind === 'stage')?.id ?? 'look-stage')
        : (looks[0]?.id ?? 'look-main');
    setDraft([
      ...draft,
      {
        id: newId(),
        name: kind === 'stage' ? 'Stage' : `Output ${k}`,
        kind,
        hostIndex: kind === 'stage' ? 0 : k,
        lookId,
        enabled: true,
        audioMaster: false,
      },
    ]);
  };
  const rotate = async (o: Output) => {
    if (
      !(await confirmDialog(
        'Rotate token',
        `Issue a new token for ${o.name}? The old URL stops working and the window is reopened.`,
        'Rotate',
      ))
    )
      return;
    try {
      const next = await api<Output>(`/outputs/${o.id}/token/rotate`, { method: 'POST' });
      await saveSettings(
        'outputs',
        settings().outputs.map((x) => (x.id === o.id ? next : x)),
      ).catch(() => undefined);
      set(o.id, { token: next.token });
      await outputWindows()?.reopen(next);
      toast(`New token for ${o.name}.`, 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const loadScreens = async () => setScreens((await outputWindows()?.screens()) ?? []);
  const url = (o: Output) =>
    o.token
      ? roleUrl(o.kind === 'stage' ? 'stage' : 'output', {
          domain: appEnv().domain,
          hostIndex: o.hostIndex,
          outputId: o.id,
          token: o.token,
        })
      : '';
  return (
    <div className="col" style={{ gap: 12 }}>
      <h2>Outputs</h2>
      <p className="muted" style={{ margin: 0 }}>
        Each output is one fullscreen window on one display with one look. The screen is remembered by name
        and position; Launch outputs places each window there.
      </p>
      <div className="row">
        <button type="button" onClick={() => void loadScreens()}>
          Detect screens
        </button>
        {screens.length > 0 && <span className="muted small">{screens.length} screens found</span>}
      </div>
      {draft.map((o) => (
        <div key={o.id} className="card col">
          <div className="row wrap">
            <input
              value={o.name}
              onChange={(e) => set(o.id, { name: e.target.value })}
              style={{ fontWeight: 600 }}
            />
            <span className="tag">{o.kind === 'stage' ? 'stage' : `out${o.hostIndex}`}</span>
            {open[o.id] && <span className="tag green">window open</span>}
            <span className="spacer" />
            <Check label="Enabled" value={o.enabled} onChange={(enabled) => set(o.id, { enabled })} />
            {o.kind !== 'stage' && (
              <Check
                label="Audio master"
                value={o.audioMaster}
                onChange={(on) =>
                  setDraft((list) =>
                    list.map((x) => ({ ...x, audioMaster: x.id === o.id ? on : on ? false : x.audioMaster })),
                  )
                }
              />
            )}
            <button
              type="button"
              className="small ghost"
              onClick={() => setDraft(draft.filter((x) => x.id !== o.id))}
            >
              Remove
            </button>
          </div>
          <div className="grid3">
            <label className="field">
              <span>Look</span>
              <select value={o.lookId} onChange={(e) => set(o.id, { lookId: e.target.value })}>
                {looks.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            {o.kind !== 'stage' && (
              <label className="field">
                <span>Host (out1…out6)</span>
                <select
                  value={o.hostIndex}
                  onChange={(e) => set(o.id, { hostIndex: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 5, 6].map((k) => (
                    <option key={k} value={k}>
                      out{k}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>Screen</span>
              <select
                value={o.screen ? `${o.screen.label}|${o.screen.left}|${o.screen.top}` : ''}
                onChange={(e) => {
                  const s = screens.find((x) => `${x.label}|${x.left}|${x.top}` === e.target.value);
                  set(o.id, { screen: s ? toScreenRef(s) : undefined });
                }}
              >
                <option value="">{o.screen ? 'Not assigned' : 'Not assigned (main screen)'}</option>
                {o.screen &&
                  !screens.some((x) => x.label === o.screen!.label && x.left === o.screen!.left) && (
                    <option value={`${o.screen.label}|${o.screen.left}|${o.screen.top}`}>
                      {o.screen.label} at {o.screen.left},{o.screen.top} (saved)
                    </option>
                  )}
                {screens.map((s) => (
                  <option key={`${s.label}|${s.left}|${s.top}`} value={`${s.label}|${s.left}|${s.top}`}>
                    {s.label || 'Screen'} {s.width}×{s.height} at {s.left},{s.top}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row small">
            <span className="muted">Token</span>
            <span className="mono ellipsis grow">
              {o.token ? `${o.token.slice(0, 6)}…` : 'issued on save'}
            </span>
            {o.token && (
              <button
                type="button"
                className="small"
                onClick={() =>
                  void navigator.clipboard?.writeText(url(o)).then(() => toast('Output URL copied.'))
                }
              >
                Copy URL
              </button>
            )}
            {o.token && (
              <button type="button" className="small" onClick={() => void rotate(o)}>
                Rotate token
              </button>
            )}
          </div>
        </div>
      ))}
      <div className="row">
        <button type="button" onClick={() => add('output')}>
          + Output
        </button>
        <button type="button" onClick={() => add('stage')}>
          + Stage display
        </button>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onRevert={revert} />
    </div>
  );
}

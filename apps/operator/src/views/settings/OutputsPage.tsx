import { api, appEnv, roleUrl } from '@ordo/client';
import { DEFAULT_LYRIC_STYLE, KEY_GREEN, type Look, nearColor, newId, type Output } from '@ordo/domain';
import { useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { Check } from '../../components/fields.tsx';
import { type ScreenInfo, toScreenRef } from '../../lib/screens.ts';
import { outputWindows, useLaunch } from '../../services/outputs.ts';
import { saveSettings, settings } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

function StageMiniPreview({ look }: { look?: Look }) {
  const props = look?.layers.props;
  const showClock = props?.clock !== false;
  const showCountdown = props?.countdown !== false;
  const showElapsed = props?.elapsed !== false;
  const showNotes = props?.notes !== false;
  const showMessages = props?.messages !== false;
  const showNext = look?.layers.slide.mode === 'lyricOnly' && !!look.layers.slide.nextSlide;

  return (
    <div
      style={{
        width: 320,
        height: 180,
        background: '#000',
        color: '#fff',
        borderRadius: 6,
        border: '1px solid var(--line)',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        position: 'relative',
        fontSize: 10,
        boxSizing: 'border-box',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Top Telemetry Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          opacity: 0.8,
          fontSize: 9,
          borderBottom: '1px solid #333',
          paddingBottom: 2,
        }}
      >
        <div style={{ display: 'flex', gap: 6 }}>
          {showClock && <span style={{ color: '#60a5fa', fontWeight: 600 }}>10:15 AM</span>}
          {showCountdown && <span style={{ color: '#34d399' }}>Starts in 04:30</span>}
        </div>
        <div>{showElapsed && <span style={{ color: '#f59e0b' }}>Sermon 24:15</span>}</div>
      </div>

      {/* Main Live Lyric Area */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '4px 0',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.3, color: '#f8fafc' }}>
          Amazing grace how sweet the sound
          <br />
          That saved a wretch like me
        </span>
      </div>

      {/* Stage Flash Message Banner */}
      {showMessages && (
        <div
          style={{
            background: '#b91c1c',
            color: '#fff',
            padding: '2px 4px',
            borderRadius: 3,
            fontSize: 8,
            textAlign: 'center',
            marginBottom: 2,
          }}
        >
          Nursery: Child #142
        </div>
      )}

      {/* Preacher Notes & Next Slide Bar */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          borderTop: '1px solid #333',
          paddingTop: 2,
          fontSize: 8,
        }}
      >
        {showNext && (
          <div
            style={{
              opacity: 0.65,
              color: '#cbd5e1',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <strong style={{ color: '#94a3b8' }}>Next:</strong> My chains are gone, I have been set free
          </div>
        )}
        {showNotes && (
          <div
            style={{
              color: '#fde047',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <strong style={{ color: '#eab308' }}>Notes:</strong> Pastor: transition to greeting after chorus
          </div>
        )}
      </div>
    </div>
  );
}

function ensureAudioMaster(list: Output[]): Output[] {
  const candidates = list.filter((o) => o.kind !== 'stage' && o.enabled !== false);
  if (candidates.length === 0) {
    return list.map((o) => (o.audioMaster ? { ...o, audioMaster: false } : o));
  }
  const existingMaster = candidates.find((o) => o.audioMaster) ?? candidates[0]!;
  return list.map((o) => ({
    ...o,
    audioMaster: o.id === existingMaster.id,
  }));
}

export function OutputsPage() {
  const outputsDraft = useSettingsDraft('outputs');
  const looksDraft = useSettingsDraft('looks');
  const open = useLaunch((s) => s.open);
  const [screens, setScreens] = useState<ScreenInfo[]>([]);

  const draft = outputsDraft.draft;
  const setDraft = outputsDraft.setDraft;
  const looks = looksDraft.draft;

  const setOutput = (id: string, patch: Partial<Output>) =>
    setDraft((list) => ensureAudioMaster(list.map((o) => (o.id === id ? { ...o, ...patch } : o))));

  const setLook = (id: string, patch: Partial<Look>) =>
    looksDraft.setDraft((list) => list.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const usedChannels = new Set(draft.filter((o) => o.kind !== 'stage').map((o) => o.hostIndex));
  const nextChannel = [1, 2, 3, 4, 5, 6].find((k) => !usedChannels.has(k));

  const addScreen = (role: 'main' | 'stage' | 'lowerThird') => {
    const kind = role === 'stage' ? 'stage' : 'output';
    if (kind === 'output' && nextChannel === undefined) return;
    const k = nextChannel ?? 1;

    let lookId = 'look-main';
    let defaultName = `Audience ${k}`;

    if (role === 'stage') {
      lookId = looks.find((l) => l.kind === 'stage')?.id ?? 'look-stage';
      defaultName = 'Stage Display';
    } else if (role === 'lowerThird') {
      lookId =
        looks.find((l) => l.kind === 'stream' || l.kind === 'lowerThird')?.id ??
        looks.find((l) => l.layers.slide.mode === 'lyricOnly')?.id ??
        'look-stream';
      defaultName = `Stream Lower Thirds ${k}`;
    } else {
      lookId = looks.find((l) => l.kind === 'main')?.id ?? 'look-main';
    }

    setDraft(
      ensureAudioMaster([
        ...draft,
        {
          id: newId(),
          name: defaultName,
          kind,
          hostIndex: kind === 'stage' ? 0 : k,
          lookId,
          enabled: true,
          audioMaster: false,
        },
      ]),
    );
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
      setOutput(o.id, { token: next.token });
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

  const dirty = outputsDraft.dirty || looksDraft.dirty;
  const saving = outputsDraft.saving || looksDraft.saving;

  const handleSave = async () => {
    const lOk = looksDraft.dirty ? await looksDraft.save() : true;
    if (!lOk) return;
    const oOk = outputsDraft.dirty ? await outputsDraft.save() : true;
    if (oOk) toast('Screens saved.', 'ok');
  };

  const handleRevert = () => {
    outputsDraft.revert();
    looksDraft.revert();
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2>Screens</h2>
          <p className="muted" style={{ margin: 0 }}>
            Configure your physical audience displays, stage confidence monitors, and livestream bottom-third
            keyers.
          </p>
        </div>
        <button type="button" onClick={() => void loadScreens()}>
          Detect displays
        </button>
      </div>

      {screens.length > 0 && (
        <span className="muted small" style={{ marginTop: -8 }}>
          {screens.length} physical screen{screens.length > 1 ? 's' : ''} detected on this computer.
        </span>
      )}

      {draft.map((o) => {
        const look = looks.find((l) => l.id === o.lookId);
        const isStage = o.kind === 'stage' || look?.kind === 'stage';
        const isLowerThird =
          !isStage &&
          (look?.kind === 'stream' || look?.kind === 'lowerThird' || look?.layers.slide.mode === 'lyricOnly');

        const roleBadge = isStage
          ? { label: 'Stage Monitor', color: '#eab308' }
          : isLowerThird
            ? { label: 'Bottom-Third Stream', color: '#06b6d4' }
            : { label: 'Audience Sanctuary', color: '#3b82f6' };

        return (
          <div key={o.id} className="card col" style={{ gap: 12 }}>
            <div className="row wrap" style={{ alignItems: 'center' }}>
              <input
                value={o.name}
                onChange={(e) => setOutput(o.id, { name: e.target.value })}
                style={{ fontWeight: 600, fontSize: 16 }}
              />
              <span
                className="tag"
                style={{
                  background: `${roleBadge.color}22`,
                  color: roleBadge.color,
                  borderColor: `${roleBadge.color}55`,
                }}
              >
                {roleBadge.label}
              </span>
              <span
                className="tag muted"
                title={
                  o.kind === 'stage'
                    ? 'Stage network port (stage.local)'
                    : `Network feed out${o.hostIndex} (out${o.hostIndex}.local)`
                }
              >
                {o.kind === 'stage' ? 'stage.local' : `out${o.hostIndex}.local`}
              </span>
              {open[o.id] && <span className="tag green">Window open</span>}
              <span className="spacer" />
              <Check label="Enabled" value={o.enabled} onChange={(enabled) => setOutput(o.id, { enabled })} />
              {o.kind !== 'stage' && (
                <Check
                  label="Audio master"
                  value={o.audioMaster}
                  onChange={(on) =>
                    setDraft((list) =>
                      ensureAudioMaster(
                        list.map((x) =>
                          x.id === o.id
                            ? { ...x, enabled: on ? true : x.enabled, audioMaster: on }
                            : on
                              ? { ...x, audioMaster: false }
                              : x,
                        ),
                      ),
                    )
                  }
                />
              )}
              <button
                type="button"
                className="small ghost"
                onClick={() => setDraft(ensureAudioMaster(draft.filter((x) => x.id !== o.id)))}
              >
                Remove
              </button>
            </div>

            <div className="grid2" style={{ alignItems: 'flex-start' }}>
              <label className="field">
                <span>Target Physical Display</span>
                <select
                  value={o.screen ? `${o.screen.label}|${o.screen.left}|${o.screen.top}` : ''}
                  onChange={(e) => {
                    const s = screens.find((x) => `${x.label}|${x.left}|${x.top}` === e.target.value);
                    setOutput(o.id, { screen: s ? toScreenRef(s) : undefined });
                  }}
                >
                  <option value="">{o.screen ? 'Not assigned' : 'Default / Primary Display'}</option>
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

              <label className="field">
                <span>Compositor Look</span>
                <select value={o.lookId} onChange={(e) => setOutput(o.id, { lookId: e.target.value })}>
                  {looks.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* Role-Specific Intuitive Knobs */}
            {isStage && look && (
              <div
                style={{
                  display: 'flex',
                  gap: 16,
                  alignItems: 'center',
                  background: 'var(--subtle, #111)',
                  padding: 12,
                  borderRadius: 6,
                }}
              >
                <StageMiniPreview look={look} />
                <div className="col" style={{ gap: 8, flex: 1 }}>
                  <strong style={{ fontSize: 13 }}>Stage Confidence Elements</strong>
                  <div className="grid2">
                    <Check
                      label="Time of Day Clock"
                      value={look.layers.props.clock !== false}
                      onChange={(on) =>
                        setLook(look.id, {
                          layers: { ...look.layers, props: { ...look.layers.props, clock: on } },
                        })
                      }
                    />
                    <Check
                      label="Countdown Timer"
                      value={look.layers.props.countdown !== false}
                      onChange={(on) =>
                        setLook(look.id, {
                          layers: { ...look.layers, props: { ...look.layers.props, countdown: on } },
                        })
                      }
                    />
                    <Check
                      label="Elapsed Sermon Timer"
                      value={look.layers.props.elapsed !== false}
                      onChange={(on) =>
                        setLook(look.id, {
                          layers: { ...look.layers, props: { ...look.layers.props, elapsed: on } },
                        })
                      }
                    />
                    <Check
                      label="Speaker / Preacher Notes"
                      value={look.layers.props.notes !== false}
                      onChange={(on) =>
                        setLook(look.id, {
                          layers: { ...look.layers, props: { ...look.layers.props, notes: on } },
                        })
                      }
                    />
                    <Check
                      label="Stage Whisper Messages"
                      value={look.layers.props.messages !== false}
                      onChange={(on) =>
                        setLook(look.id, {
                          layers: { ...look.layers, props: { ...look.layers.props, messages: on } },
                        })
                      }
                    />
                    <Check
                      label="Next Slide Look-Ahead"
                      value={look.layers.slide.mode === 'lyricOnly' && !!look.layers.slide.nextSlide}
                      onChange={(on) => {
                        if (look.layers.slide.mode !== 'lyricOnly') return;
                        setLook(look.id, {
                          layers: {
                            ...look.layers,
                            slide: {
                              ...look.layers.slide,
                              nextSlide: on
                                ? {
                                    style: {
                                      ...DEFAULT_LYRIC_STYLE,
                                      fontSizePx: 28,
                                      color: { r: 200, g: 200, b: 200, a: 0.75 },
                                      align: 'left',
                                    },
                                    band: { x: 60, y: 700, w: 1800, h: 260, rotation: 0 },
                                  }
                                : undefined,
                            },
                          },
                        });
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {isLowerThird && look && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  background: 'var(--subtle, #111)',
                  padding: 12,
                  borderRadius: 6,
                }}
              >
                <strong style={{ fontSize: 13 }}>Stream Keying & Strap Settings</strong>
                <div className="row wrap" style={{ alignItems: 'center', gap: 12 }}>
                  <span className="muted small">Background Keying:</span>
                  <button
                    type="button"
                    className={
                      nearColor(look.clearColor, { r: 0, g: 0, b: 0, a: 0 }, 10) ||
                      nearColor(look.clearColor, { r: 0, g: 0, b: 0, a: 1 }, 10)
                        ? 'on small'
                        : 'small'
                    }
                    onClick={() => setLook(look.id, { clearColor: { r: 0, g: 0, b: 0, a: 1 } })}
                  >
                    Transparent / Black
                  </button>
                  <button
                    type="button"
                    className={nearColor(look.clearColor, KEY_GREEN, 30) ? 'on small' : 'small'}
                    onClick={() => setLook(look.id, { clearColor: KEY_GREEN })}
                  >
                    Chroma Green
                  </button>
                  <button
                    type="button"
                    className={
                      nearColor(look.clearColor, { r: 0, g: 0, b: 255, a: 1 }, 30) ? 'on small' : 'small'
                    }
                    onClick={() => setLook(look.id, { clearColor: { r: 0, g: 0, b: 255, a: 1 } })}
                  >
                    Chroma Blue
                  </button>
                  <span className="spacer" />
                  <Check
                    label="Show Name Banners on Stream"
                    value={look.layers.lowerThird.visible}
                    onChange={(visible) =>
                      setLook(look.id, {
                        layers: { ...look.layers, lowerThird: { visible } },
                      })
                    }
                  />
                </div>
              </div>
            )}

            {!isStage && !isLowerThird && look && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  background: 'var(--subtle, #111)',
                  padding: 12,
                  borderRadius: 6,
                }}
              >
                <strong style={{ fontSize: 13 }}>Sanctuary Display Overlays</strong>
                <div className="row wrap" style={{ gap: 16 }}>
                  <Check
                    label="Show Service Countdown on Audience Screen"
                    value={look.layers.props.countdown !== false}
                    onChange={(on) =>
                      setLook(look.id, {
                        layers: { ...look.layers, props: { ...look.layers.props, countdown: on } },
                      })
                    }
                  />
                  <Check
                    label="Allow House Logo Overlay"
                    value={look.layers.props.logo !== false}
                    onChange={(on) =>
                      setLook(look.id, {
                        layers: { ...look.layers, props: { ...look.layers.props, logo: on } },
                      })
                    }
                  />
                </div>
              </div>
            )}

            {/* Link & Window Management */}
            <div className="row small" style={{ alignItems: 'center' }}>
              <span className="muted">Window link:</span>
              <span className="mono ellipsis grow">
                {o.token ? `${o.token.slice(0, 6)}…` : 'issued on save'}
              </span>
              {o.token && (
                <button
                  type="button"
                  className="small"
                  onClick={() =>
                    void navigator.clipboard?.writeText(url(o)).then(() => toast('Screen URL copied.'))
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
        );
      })}

      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          disabled={nextChannel === undefined}
          title={nextChannel === undefined ? 'Maximum 6 audience displays reached' : undefined}
          onClick={() => addScreen('main')}
        >
          + Audience Screen
        </button>
        <button type="button" onClick={() => addScreen('stage')}>
          + Stage Display
        </button>
        <button
          type="button"
          disabled={nextChannel === undefined}
          title={nextChannel === undefined ? 'Maximum 6 audience displays reached' : undefined}
          onClick={() => addScreen('lowerThird')}
        >
          + Bottom-Third Stream
        </button>
        <span className="spacer" />
        <a href="#/settings/looks" className="small muted">
          Advanced Look Compositor &rarr;
        </a>
      </div>

      <SaveBar dirty={dirty} saving={saving} onSave={() => void handleSave()} onRevert={handleRevert} />
    </div>
  );
}

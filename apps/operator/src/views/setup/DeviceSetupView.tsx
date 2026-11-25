import { useEffect, useState } from 'react';
import type { Output } from '@ordo/domain';
import { Icon } from '../../components/Icons.tsx';
import { SplitPane } from '../../components/SplitPane.tsx';
import { buildChecklist } from '../../lib/checklist.ts';
import { planLaunch, type ScreenInfo } from '../../lib/screens.ts';
import { outputWindows, useLaunch } from '../../services/outputs.ts';
import { surfaces, useSurfaces } from '../../services/surfaces.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { toast } from '../../state/toasts.ts';

type PopupState = 'unknown' | 'allowed' | 'blocked';
type ScreenPermState = 'unknown' | 'granted' | 'prompt' | 'denied' | 'unsupported';

export function DeviceSetupView() {
  const settings = useLibrary((s) => s.data.settings);
  const outputs = settings.outputs.filter((o) => o.enabled);
  const launch = useLaunch();
  const liveHealth = useLive((s) => s.health);
  const surf = useSurfaces();

  // Pop-up check state
  const [popupState, setPopupState] = useState<PopupState>('unknown');
  // Screen permission state
  const [screenPerm, setScreenPerm] = useState<ScreenPermState>('unknown');
  const [detectedScreens, setDetectedScreens] = useState<ScreenInfo[]>([]);
  // Audio state
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  // Storage persistence state
  const [isPersisted, setIsPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    // Check permission queries if available (silently without prompting)
    if ('permissions' in navigator && navigator.permissions?.query) {
      try {
        navigator.permissions
          .query({ name: 'window-management' as PermissionName })
          .then((res) => {
            setScreenPerm(res.state as ScreenPermState);
            res.onchange = () => {
              setScreenPerm(res.state as ScreenPermState);
              if (res.state === 'granted') {
                void outputWindows()
                  ?.screens()
                  .then((sc) => {
                    if (sc.length) setDetectedScreens(sc);
                  });
              }
            };
            // Only query screens automatically if permission is ALREADY granted
            if (res.state === 'granted') {
              void outputWindows()
                ?.screens()
                .then((sc) => {
                  if (sc.length) setDetectedScreens(sc);
                });
            }
          })
          .catch(() => {
            setScreenPerm('unsupported');
          });
      } catch {
        setScreenPerm('unsupported');
      }
    } else {
      setScreenPerm('unsupported');
    }

    // Check storage persistence
    if (navigator.storage?.persisted) {
      navigator.storage
        .persisted()
        .then(setIsPersisted)
        .catch(() => undefined);
    }
  }, []);

  const testPopup = () => {
    try {
      const w = window.open('about:blank', 'ordo-popup-test', 'width=300,height=200');
      if (!w || w.closed || typeof w.closed === 'undefined') {
        setPopupState('blocked');
      } else {
        w.close();
        setPopupState('allowed');
        toast('Pop-ups are allowed!', 'info');
      }
    } catch {
      setPopupState('blocked');
    }
  };

  const requestScreenDetails = async () => {
    const w = window as unknown as {
      getScreenDetails?: () => Promise<{ screens: ScreenInfo[] }>;
    };
    if (typeof w.getScreenDetails === 'function') {
      try {
        const details = await w.getScreenDetails();
        setScreenPerm('granted');
        if (details.screens?.length) {
          setDetectedScreens(details.screens);
          toast(`Detected ${details.screens.length} display screen(s)`, 'info');
        }
      } catch (e: unknown) {
        const err = e as { name?: string };
        if (err?.name === 'NotAllowedError') {
          setScreenPerm('denied');
          toast('Multi-screen permission was denied', 'error');
        } else {
          toast('Could not query screens', 'warn');
        }
      }
    } else {
      toast('Window Management API not supported in this browser', 'warn');
    }
  };

  const openIndividual = (o: Output) => {
    const ow = outputWindows();
    if (!ow) return;
    const screens = detectedScreens.length > 0 ? detectedScreens : launch.screens;
    const plan = planLaunch([o], screens);
    const targetScreen = plan[0]?.screen ?? {
      label: 'Primary',
      left: 0,
      top: 0,
      width: window.screen.width,
      height: window.screen.height,
      isPrimary: true,
    };
    const index = outputs.findIndex((x) => x.id === o.id);
    const res = ow.openOne(o, targetScreen, Math.max(0, index));
    if (!res) {
      setPopupState('blocked');
    } else {
      setPopupState('allowed');
      toast(`Opened window for ${o.name}`, 'info');
    }
  };

  const unlockAudio = () => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        void ctx.resume().then(() => {
          setAudioUnlocked(true);
          toast('Audio unlocked successfully', 'info');
        });
      }
    } catch {
      toast('Failed to initialize audio context', 'error');
    }
  };

  const requestStoragePersist = async () => {
    if (navigator.storage?.persist) {
      try {
        const granted = await navigator.storage.persist();
        setIsPersisted(granted);
        toast(
          granted ? 'Storage persistence granted' : 'Storage persistence denied',
          granted ? 'info' : 'warn',
        );
      } catch {
        toast('Failed to request persistence', 'error');
      }
    }
  };

  const checklistSections = buildChecklist(settings, `${location.origin}${location.pathname}`);

  return (
    <SplitPane
      storageKey="setup-patchbay-split"
      panels={[
        {
          id: 'setup-outputs',
          content: (
            <div className="pl-pane">
              <div className="pl-pane-head" style={{ justifyContent: 'space-between' }}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <Icon name="monitor" size={15} />
                  <span className="prop-section-title" style={{ margin: 0 }}>
                    Display &amp; Output Patchbay
                  </span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="primary small"
                    disabled={launch.busy}
                    onClick={() => void outputWindows()?.launch()}
                  >
                    Launch All Windows
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => void outputWindows()?.closeAll()}
                  >
                    Close All
                  </button>
                </div>
              </div>

              <div className="studio-well">
                <div className="prop-section">
                  <span className="prop-section-title">Browser Window Permissions</span>

                  {/* Pop-up permission check */}
                  <div
                    className="row"
                    style={{
                      background: popupState === 'blocked' ? '#451a1a' : 'var(--panel)',
                      border: '1px solid var(--line)',
                      padding: '10px 14px',
                      borderRadius: 4,
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <div>
                      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <b>Pop-up Windows</b>
                        {popupState === 'allowed' && <span className="tag green">Allowed</span>}
                        {popupState === 'blocked' && <span className="tag red">Blocked by Browser</span>}
                        {popupState === 'unknown' && <span className="tag">Not Tested</span>}
                      </div>
                      {popupState === 'blocked' ? (
                        <div style={{ marginTop: 6, fontSize: 12.5, color: '#fca5a5' }}>
                          Chrome blocked pop-up windows. Click the pop-up blocked icon in your address bar and
                          select <b>Always allow pop-ups and redirects from this site</b>, then test again.
                        </div>
                      ) : (
                        <div className="muted small" style={{ marginTop: 3 }}>
                          Required to open multiple output windows across projectors automatically.
                        </div>
                      )}
                    </div>
                    <button type="button" className="small" onClick={testPopup}>
                      Test Pop-ups
                    </button>
                  </div>

                  {/* Simulated Windows Toggle */}
                  <div
                    className="row"
                    style={{
                      background: launch.simulated ? 'rgba(37, 99, 235, 0.14)' : 'var(--panel)',
                      border: `1px solid ${launch.simulated ? 'var(--accent)' : 'var(--line)'}`,
                      padding: '10px 14px',
                      borderRadius: 4,
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <div>
                      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <b>Simulated Windows Mode</b>
                        {launch.simulated ? (
                          <span className="tag blue">Floating 16:9 Windows</span>
                        ) : (
                          <span className="tag">Multi-Monitor Fullscreen</span>
                        )}
                      </div>
                      <div className="muted small" style={{ marginTop: 3 }}>
                        {launch.simulated
                          ? 'Outputs launch as floating 16:9 windows (960×540) on your current screen.'
                          : 'Outputs attempt fullscreen placement across physical display screens.'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={launch.simulated ? 'primary small' : 'small'}
                      onClick={() => {
                        const next = !launch.simulated;
                        launch.setSimulated(next);
                        toast(
                          next ? 'Simulated Windows enabled' : 'Multi-Monitor Fullscreen enabled',
                          'info',
                        );
                      }}
                    >
                      {launch.simulated ? 'Disable Simulation' : 'Enable Simulated Windows'}
                    </button>
                  </div>

                  {/* Multi-Screen Window Management */}
                  <div
                    className="row"
                    style={{
                      background: 'var(--panel)',
                      border: '1px solid var(--line)',
                      padding: '10px 14px',
                      borderRadius: 4,
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <div>
                      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <b>Multi-Screen Permission</b>
                        {screenPerm === 'granted' && <span className="tag green">Granted</span>}
                        {screenPerm === 'denied' && <span className="tag red">Denied</span>}
                        {screenPerm === 'prompt' && <span className="tag amber">Needs Prompt</span>}
                        {screenPerm === 'unsupported' && <span className="tag">Unsupported</span>}
                      </div>
                      <div className="muted small" style={{ marginTop: 3 }}>
                        {detectedScreens.length > 0
                          ? `${detectedScreens.length} display(s): ${detectedScreens.map((s, idx) => `${s.label || `Display ${idx + 1}`} (${s.width}×${s.height}${s.isPrimary ? ', Primary' : ''})`).join(', ')}`
                          : 'Allows positioning output windows directly on separate projector/TV screens.'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="small"
                      disabled={screenPerm === 'unsupported'}
                      onClick={() => void requestScreenDetails()}
                    >
                      Detect Screens
                    </button>
                  </div>
                </div>

                {/* Configured Outputs Patchbay */}
                <div className="prop-section">
                  <span className="prop-section-title">Configured Outputs ({outputs.length})</span>
                  {outputs.length === 0 ? (
                    <div className="muted small">
                      No outputs configured. Add outputs in Settings → Screens.
                    </div>
                  ) : (
                    <div className="col" style={{ gap: 8 }}>
                      {outputs.map((o) => {
                        const isOpen = launch.open[o.id] || outputWindows()?.isOpen(o.id);
                        const health = liveHealth[o.id];
                        return (
                          <div
                            key={o.id}
                            className="row"
                            style={{
                              background: 'var(--panel)',
                              border: '1px solid var(--line)',
                              padding: '10px 14px',
                              borderRadius: 4,
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 12,
                            }}
                          >
                            <div className="col" style={{ gap: 3 }}>
                              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                                <span className={`dot sm ${isOpen ? 'green' : 'red'}`} />
                                <b style={{ fontSize: 14 }}>{o.name}</b>
                                <span className="tag">{o.kind === 'stage' ? 'Stage' : 'Output'}</span>
                                {health?.connected && <span className="tag green">Connected</span>}
                              </div>
                              <div className="muted small">
                                Screen: {o.screen?.label || 'Auto'} · Host Index: {o.hostIndex}
                              </div>
                            </div>
                            <div className="row" style={{ gap: 6 }}>
                              <button
                                type="button"
                                className={`small${isOpen ? '' : ' primary'}`}
                                onClick={() => openIndividual(o)}
                              >
                                {isOpen ? 'Focus / Reopen' : 'Open Window'}
                              </button>
                              {isOpen && (
                                <button
                                  type="button"
                                  className="small danger"
                                  onClick={() => outputWindows()?.closeOne(o.id)}
                                >
                                  Close
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ),
        },
        {
          id: 'setup-hardware',
          size: 480,
          min: 340,
          max: 680,
          content: (
            <div className="studio-sidebar">
              <div className="pl-pane-head">
                <Icon name="sliders" size={14} />
                <span className="prop-section-title" style={{ margin: 0 }}>
                  Controllers, Audio &amp; Readiness
                </span>
              </div>
              <div className="pl-pane-scroll col" style={{ padding: 14, gap: 12 }}>
                {/* USB Stream Deck */}
                <div className="card col" style={{ background: 'var(--well)', gap: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <b className="row" style={{ gap: 6 }}>
                      <Icon name="streamdeck" size={14} />
                      Elgato Stream Deck (USB)
                    </b>
                    {surf.deck ? (
                      <span className="tag green">Connected</span>
                    ) : (
                      <span className="tag">Not Connected</span>
                    )}
                  </div>
                  <div className="muted small">
                    {surf.deck
                      ? `Connected: ${surf.deck.model} (${surf.deck.keys} keys)`
                      : 'Connect an Elgato Stream Deck via WebHID to control cues with physical hardware.'}
                  </div>
                  <div>
                    <button type="button" className="small" onClick={() => void surfaces()?.deck.connect()}>
                      Connect USB Device
                    </button>
                  </div>
                </div>

                {/* Web MIDI */}
                <div className="card col" style={{ background: 'var(--well)', gap: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <b className="row" style={{ gap: 6 }}>
                      <Icon name="midi" size={14} />
                      Web MIDI
                    </b>
                    {surf.midiEnabled ? (
                      surf.midiReady ? (
                        <span className="tag green">Enabled</span>
                      ) : (
                        <span className="tag amber">Initializing…</span>
                      )
                    ) : (
                      <span className="tag">Disabled (Default)</span>
                    )}
                  </div>
                  <div className="muted small">
                    {surf.midiEnabled
                      ? surf.midiInputs.length > 0
                        ? `Active devices: ${surf.midiInputs.map((i) => i.name).join(', ')}`
                        : 'Web MIDI is enabled. No MIDI input devices currently plugged in.'
                      : 'Web MIDI is off by default so your browser does not prompt for MIDI permissions until enabled.'}
                  </div>
                  <div>
                    {surf.midiEnabled ? (
                      <button
                        type="button"
                        className="small danger"
                        onClick={() => void surfaces()?.disableMidi()}
                      >
                        Disable MIDI
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="small primary"
                        onClick={() => void surfaces()?.enableMidi()}
                      >
                        Enable Web MIDI
                      </button>
                    )}
                  </div>
                </div>

                {/* Audio Autoplay Unlock */}
                <div className="card col" style={{ background: 'var(--well)', gap: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <b className="row" style={{ gap: 6 }}>
                      <Icon name="audio" size={14} />
                      Audio &amp; Video Playback
                    </b>
                    {audioUnlocked ? (
                      <span className="tag green">Unlocked</span>
                    ) : (
                      <span className="tag amber">Needs Unlock</span>
                    )}
                  </div>
                  <div className="muted small">
                    Browsers require user interaction before media audio can play automatically during cues.
                  </div>
                  <div>
                    <button
                      type="button"
                      className={`small ${audioUnlocked ? '' : 'primary'}`}
                      disabled={audioUnlocked}
                      onClick={unlockAudio}
                    >
                      {audioUnlocked ? 'Audio Unlocked' : 'Unlock Audio Context'}
                    </button>
                  </div>
                </div>

                {/* Persistent Site Storage */}
                <div className="card col" style={{ background: 'var(--well)', gap: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <b className="row" style={{ gap: 6 }}>
                      <Icon name="backup" size={14} />
                      Site Storage Persistence
                    </b>
                    {isPersisted ? (
                      <span className="tag green">Persisted</span>
                    ) : (
                      <span className="tag">Standard</span>
                    )}
                  </div>
                  <div className="muted small">
                    Keeps presentations, themes, and cached video assets safe from automatic browser eviction.
                  </div>
                  <div>
                    <button
                      type="button"
                      className="small"
                      disabled={isPersisted === true}
                      onClick={() => void requestStoragePersist()}
                    >
                      {isPersisted ? 'Persistence Active' : 'Request Persistence'}
                    </button>
                  </div>
                </div>

                {/* Pre-Service Checklist */}
                <details className="card col" style={{ background: 'var(--well)', gap: 10 }}>
                  <summary
                    style={{
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontWeight: 600,
                    }}
                  >
                    <span>Pre-Service Checklist</span>
                    <span className="tag">Printable</span>
                  </summary>
                  <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 6 }}>
                    <div
                      className="row"
                      style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}
                    >
                      <span className="muted small">
                        Verify screens, audio, and slides before going live.
                      </span>
                      <button type="button" className="small" onClick={() => window.print()}>
                        Print Checklist
                      </button>
                    </div>
                    <div className="checklist" style={{ fontSize: 12.5 }}>
                      {checklistSections.map((s) => {
                        const List = s.ordered ? 'ol' : 'ul';
                        return (
                          <div key={s.title} style={{ marginBottom: 10 }}>
                            <h4 style={{ margin: '6px 0 4px', color: 'var(--fg)' }}>{s.title}</h4>
                            <List style={{ margin: 0, paddingLeft: 18 }}>
                              {s.items.map((it) => (
                                <li key={it} style={{ margin: '3px 0' }}>
                                  {it}
                                </li>
                              ))}
                            </List>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </details>
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}

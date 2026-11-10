import { useEffect, useState } from 'react';
import type { Output } from '@ordo/domain';
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
    <div className="page-pad col" style={{ maxWidth: 960, margin: '0 auto', gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Setup & Device Permissions</h1>
        <p className="muted" style={{ margin: 0 }}>
          Manage window launch permissions, connected controllers, and pre-service device readiness.
        </p>
      </div>

      {/* 1. WINDOWS & POP-UPS */}
      <div className="card col" style={{ gap: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0 }}>Windows & Display Screens</h2>
            <div className="muted small">
              Launch presentation and stage outputs on multi-monitor displays.
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="primary"
              disabled={launch.busy}
              onClick={() => void outputWindows()?.launch()}
            >
              Launch All Windows
            </button>
            <button type="button" className="ghost" onClick={() => void outputWindows()?.closeAll()}>
              Close All
            </button>
          </div>
        </div>

        {/* Pop-up permission check banner */}
        <div
          className="row"
          style={{
            background: popupState === 'blocked' ? '#451a1a' : 'var(--bg3)',
            padding: '10px 14px',
            borderRadius: 'var(--radius)',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <b>Pop-up Windows:</b>
              {popupState === 'allowed' && <span className="tag green">Allowed ✓</span>}
              {popupState === 'blocked' && <span className="tag red">Blocked by Browser</span>}
              {popupState === 'unknown' && <span className="tag grey">Not Tested</span>}
            </div>
            {popupState === 'blocked' && (
              <div style={{ marginTop: 6, fontSize: 13, color: '#fca5a5' }}>
                Chrome blocked pop-up windows. Click the pop-up blocked icon (with a red '×') in your browser
                address bar and select <b>"Always allow pop-ups and redirects from this site"</b>, then click
                Done and test again.
              </div>
            )}
            {popupState === 'unknown' && (
              <div className="muted small" style={{ marginTop: 4 }}>
                Browsers often block opening multiple windows automatically unless pop-ups are explicitly
                allowed.
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
            background: launch.simulated ? '#172554' : 'var(--bg3)',
            padding: '10px 14px',
            borderRadius: 'var(--radius)',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            border: launch.simulated ? '1px solid #3b82f6' : undefined,
          }}
        >
          <div>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <b>Simulated Windows Mode:</b>
              {launch.simulated ? (
                <span className="tag blue">Active (Floating 16:9 Windows)</span>
              ) : (
                <span className="tag grey">Multi-Monitor Fullscreen</span>
              )}
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              {launch.simulated
                ? 'Outputs launch as floating 16:9 windows (960×540) on your current screen. Ideal for single monitors, laptops, and testing without multi-monitor hardware.'
                : 'Outputs attempt fullscreen placement across physical display screens. If you are testing on a single screen or laptop, turn on Simulated Windows.'}
            </div>
          </div>
          <button
            type="button"
            className={launch.simulated ? 'primary small' : 'small'}
            onClick={() => {
              const next = !launch.simulated;
              launch.setSimulated(next);
              toast(next ? 'Simulated Windows enabled' : 'Multi-Monitor Fullscreen enabled', 'info');
            }}
          >
            {launch.simulated ? 'Disable Simulation' : 'Enable Simulated Windows'}
          </button>
        </div>

        {/* Multi-Screen Window Management */}
        <div
          className="row"
          style={{
            background: 'var(--bg3)',
            padding: '10px 14px',
            borderRadius: 'var(--radius)',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <b>Multi-Screen Permission:</b>
              {screenPerm === 'granted' && <span className="tag green">Granted ✓</span>}
              {screenPerm === 'denied' && <span className="tag red">Denied</span>}
              {screenPerm === 'prompt' && <span className="tag amber">Needs Prompt</span>}
              {screenPerm === 'unsupported' && <span className="tag grey">Unsupported</span>}
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              {detectedScreens.length > 0
                ? `${detectedScreens.length} display(s) detected: ${detectedScreens.map((s, idx) => `${s.label || `Display ${idx + 1}`} (${s.width}×${s.height}${s.isPrimary ? ', Primary' : ''})`).join(', ')}`
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

        {/* Automatic Fullscreen Tip */}
        <div
          className="col"
          style={{
            background: 'var(--bg2)',
            padding: '10px 14px',
            borderRadius: 'var(--radius)',
            gap: 4,
          }}
        >
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <b style={{ fontSize: 13 }}>Automatic Fullscreen Tip:</b>
          </div>
          <div className="muted small" style={{ lineHeight: 1.4 }}>
            Browsers require a user click or keypress before a newly opened window can enter fullscreen mode. Each launched output window displays a one-click banner or you can press <kbd style={{ padding: '1px 5px', borderRadius: 4, background: 'var(--bg4)' }}>Enter</kbd> / <kbd style={{ padding: '1px 5px', borderRadius: 4, background: 'var(--bg4)' }}>F</kbd>. To allow outputs to enter fullscreen automatically without needing a click, allow <b>Automatic fullscreen</b> in Chrome site settings.
          </div>
        </div>

        {/* Individual Outputs List */}
        <div className="col" style={{ gap: 8, marginTop: 4 }}>
          <h3 style={{ margin: '4px 0 2px' }}>Configured Outputs</h3>
          <div className="muted small">
            Clicking an individual output opens it in a direct click gesture, preventing browser pop-up
            blockers.
          </div>
          {outputs.length === 0 ? (
            <div className="muted small">No outputs configured. Add outputs in Settings → Outputs.</div>
          ) : (
            outputs.map((o) => {
              const isOpen = launch.open[o.id] || outputWindows()?.isOpen(o.id);
              const health = liveHealth[o.id];
              return (
                <div
                  key={o.id}
                  className="row"
                  style={{
                    background: 'var(--bg2)',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius)',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div className="col" style={{ gap: 2 }}>
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <b>{o.name}</b>
                      <span className="tag">{o.kind === 'stage' ? 'Stage' : 'Output'}</span>
                      {isOpen ? (
                        <span className="tag green">Open</span>
                      ) : (
                        <span className="tag grey">Closed</span>
                      )}
                      {health?.connected && <span className="tag green">Connected</span>}
                    </div>
                    <div className="muted small">
                      Screen: {o.screen?.label || 'Auto'} • Host Index: {o.hostIndex}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className="small primary" onClick={() => openIndividual(o)}>
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
            })
          )}
        </div>
      </div>

      {/* 2. HARDWARE & PERIPHERALS */}
      <div className="card col" style={{ gap: 14 }}>
        <h2 style={{ margin: 0 }}>Controllers & Peripherals</h2>

        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}
        >
          {/* USB Stream Deck */}
          <div className="card col" style={{ background: 'var(--bg3)', gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>Elgato Stream Deck (USB)</b>
              {surf.deck ? (
                <span className="tag green">Connected ✓</span>
              ) : (
                <span className="tag grey">Not Connected</span>
              )}
            </div>
            <div className="muted small">
              {surf.deck
                ? `Connected: ${surf.deck.model} (${surf.deck.keys} keys)`
                : 'Connect an Elgato Stream Deck via WebHID to control cues with physical hardware.'}
            </div>
            <div style={{ marginTop: 'auto', paddingTop: 6 }}>
              <button type="button" className="small" onClick={() => void surfaces()?.deck.connect()}>
                Connect USB Device
              </button>
            </div>
          </div>

          {/* Web MIDI */}
          <div className="card col" style={{ background: 'var(--bg3)', gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>Web MIDI</b>
              {surf.midiEnabled ? (
                surf.midiReady ? (
                  <span className="tag green">Enabled ✓</span>
                ) : (
                  <span className="tag amber">Initializing…</span>
                )
              ) : (
                <span className="tag grey">Disabled (Default)</span>
              )}
            </div>
            <div className="muted small">
              {surf.midiEnabled
                ? surf.midiInputs.length > 0
                  ? `Active devices: ${surf.midiInputs.map((i) => i.name).join(', ')}`
                  : 'Web MIDI is enabled. No MIDI input devices currently plugged in.'
                : 'Web MIDI is off by default so your browser does not prompt for MIDI permissions until enabled.'}
            </div>
            <div style={{ marginTop: 'auto', paddingTop: 6 }}>
              {surf.midiEnabled ? (
                <button type="button" className="small danger" onClick={() => void surfaces()?.disableMidi()}>
                  Disable MIDI
                </button>
              ) : (
                <button type="button" className="small primary" onClick={() => void surfaces()?.enableMidi()}>
                  Enable Web MIDI
                </button>
              )}
            </div>
          </div>

          {/* Audio Autoplay Unlock */}
          <div className="card col" style={{ background: 'var(--bg3)', gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>Audio & Video Playback</b>
              {audioUnlocked ? (
                <span className="tag green">Unlocked ✓</span>
              ) : (
                <button
                  type="button"
                  className="tag amber"
                  onClick={unlockAudio}
                  title="Click to unlock audio autoplay"
                  style={{ border: 0, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  Click to Unlock
                </button>
              )}
            </div>
            <div className="muted small">
              Browsers require user interaction before media audio can play automatically during presentation
              cues.
            </div>
            <div style={{ marginTop: 'auto', paddingTop: 6 }}>
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
          <div className="card col" style={{ background: 'var(--bg3)', gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>Site Storage Persistence</b>
              {isPersisted ? (
                <span className="tag green">Persisted ✓</span>
              ) : (
                <span className="tag grey">Standard</span>
              )}
            </div>
            <div className="muted small">
              Keeps presentations, themes, and cached video assets safe from browser automatic storage
              eviction.
            </div>
            <div style={{ marginTop: 'auto', paddingTop: 6 }}>
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
        </div>
      </div>

      {/* 3. PRE-SERVICE CHECKLIST */}
      <details className="card col" style={{ gap: 12 }}>
        <summary
          style={{
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, display: 'inline' }}>Pre-Service Checklist</h2>
          <span className="tag grey">Printable</span>
        </summary>
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 4 }}>
          <div
            className="row"
            style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}
          >
            <p className="muted small" style={{ margin: 0 }}>
              Use this checklist before every service to verify screens, audio, and slides.
            </p>
            <button type="button" className="small" onClick={() => window.print()}>
              Print Checklist
            </button>
          </div>
          <div
            className="checklist"
            style={{ background: 'var(--bg2)', padding: 14, borderRadius: 'var(--radius)' }}
          >
            <h3 style={{ marginTop: 0 }}>{settings.general.venueName || 'ordo'} — Service Checklist</h3>
            {checklistSections.map((s) => {
              const List = s.ordered ? 'ol' : 'ul';
              return (
                <div key={s.title} style={{ marginBottom: 12 }}>
                  <h4 style={{ margin: '8px 0 4px', color: 'var(--fg)' }}>{s.title}</h4>
                  <List style={{ margin: 0, paddingLeft: 20 }}>
                    {s.items.map((it) => (
                      <li key={it} style={{ margin: '4px 0' }}>
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
  );
}

import { Icon, type IconName } from '../../components/Icons.tsx';
import { SplitPane } from '../../components/SplitPane.tsx';
import type { Profile } from '../../lib/capabilities.ts';
import { EDIT_PROFILE_SETTINGS } from '../../lib/route.ts';
import { useLibrary } from '../../state/library.ts';
import { dirtySettingsPagesSnapshot, useSettingsDraftStore } from '../../state/settingsDrafts.ts';
import { AudioSettingsPage } from './AudioSettingsPage.tsx';
import { BackupsPage } from './BackupsPage.tsx';
import { DiagnosticsPage } from './DiagnosticsPage.tsx';
import { GeneralPage } from './GeneralPage.tsx';
import { KeymapPage } from './KeymapPage.tsx';
import { LooksPage } from './LooksPage.tsx';
import { MessagesPage } from './MessagesPage.tsx';
import { MidiPage } from './MidiPage.tsx';
import { OutputsPage } from './OutputsPage.tsx';
import { PinsPage } from './PinsPage.tsx';
import { StreamDeckPage } from './StreamDeckPage.tsx';

const PAGES: [string, string, IconName][] = [
  ['outputs', 'Screens', 'monitor'],
  ['looks', 'Looks (Advanced)', 'layers'],
  ['audio', 'Audio', 'audio'],
  ['keys', 'Keyboard', 'keyboard'],
  ['streamdeck', 'Stream Deck', 'streamdeck'],
  ['midi', 'MIDI', 'midi'],
  ['messages', 'Stage messages', 'message'],
  ['general', 'General', 'sliders'],
  ['pins', 'PINs', 'shield'],
  ['backups', 'Backups', 'backup'],
  ['diagnostics', 'Diagnostics', 'activity'],
];

export function SettingsView({ page, profile = 'full' }: { page: string; profile?: Profile }) {
  const entries = useSettingsDraftStore((s) => s.entries);
  const remoteSettings = useLibrary((s) => s.data.settings);
  const dirtyPages = dirtySettingsPagesSnapshot(entries, remoteSettings);
  const pages = profile === 'edit' ? PAGES.filter(([k]) => EDIT_PROFILE_SETTINGS.includes(k)) : PAGES;
  if (!pages.some(([k]) => k === page)) return null;
  let body: React.ReactNode = null;
  switch (page) {
    case 'outputs':
      body = <OutputsPage />;
      break;
    case 'looks':
      body = <LooksPage />;
      break;
    case 'audio':
      body = <AudioSettingsPage />;
      break;
    case 'keys':
      body = <KeymapPage />;
      break;
    case 'streamdeck':
      body = <StreamDeckPage />;
      break;
    case 'midi':
      body = <MidiPage />;
      break;
    case 'messages':
      body = <MessagesPage />;
      break;
    case 'general':
      body = <GeneralPage />;
      break;
    case 'pins':
      body = <PinsPage />;
      break;
    case 'backups':
      body = <BackupsPage />;
      break;
    case 'diagnostics':
      body = <DiagnosticsPage />;
      break;
  }
  return (
    <SplitPane
      storageKey="settings-prefs"
      panels={[
        {
          id: 'settings-nav',
          size: 196,
          min: 160,
          max: 280,
          content: (
            <div className="side col" style={{ gap: 2, borderRight: 0, height: '100%' }}>
              <div className="prop-section-title" style={{ padding: '4px 8px 6px' }}>
                Preferences
              </div>
              {pages.map(([k, label, icon]) => {
                const isDirty = dirtyPages.has(k);
                return (
                  <a key={k} href={`#/settings/${k}`} className={page === k ? 'active' : ''}>
                    <Icon name={icon} size={13} />
                    <span className="grow ellipsis">{label}</span>
                    {isDirty && (
                      <span className="unsaved-dot" title="Unsaved changes" aria-label="Unsaved changes">
                        ●
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          ),
        },
        {
          id: 'settings-body',
          content: (
            <div className="pl-pane-scroll">
              <div className="settings-body prefs-body">{body}</div>
            </div>
          ),
        },
      ]}
    />
  );
}

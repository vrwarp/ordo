import type { Profile } from '../../lib/capabilities.ts';
import { EDIT_PROFILE_SETTINGS } from '../../lib/route.ts';
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
import { ThemesPage } from './ThemesPage.tsx';

const PAGES: [string, string][] = [
  ['outputs', 'Outputs'],
  ['looks', 'Looks'],
  ['audio', 'Audio'],
  ['keys', 'Keyboard'],
  ['streamdeck', 'Stream Deck'],
  ['midi', 'MIDI'],
  ['messages', 'Stage messages'],
  ['general', 'General'],
  ['themes', 'Themes'],
  ['pins', 'PINs'],
  ['backups', 'Backups'],
  ['diagnostics', 'Diagnostics'],
];

export function SettingsView({ page, profile = 'full' }: { page: string; profile?: Profile }) {
  // An edit-profile device (an iPad) has no outputs, audio devices, keys, Stream Deck, MIDI or backups.
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
    case 'themes':
      body = <ThemesPage />;
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
    <div className="split" style={{ gridTemplateColumns: '200px 1fr' }}>
      <div className="side col" style={{ gap: 2 }}>
        {pages.map(([k, label]) => (
          <a key={k} href={`#/settings/${k}`} className={page === k ? 'active' : ''}>
            {label}
          </a>
        ))}
      </div>
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        <div className="settings-body">{body}</div>
      </div>
    </div>
  );
}

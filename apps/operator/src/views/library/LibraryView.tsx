import { FontsTab } from './FontsTab.tsx';
import { ImportTab } from './ImportTab.tsx';
import { MediaTab } from './MediaTab.tsx';
import { PresentationsTab } from './PresentationsTab.tsx';
import { ThemesTab } from './ThemesTab.tsx';

const TABS = [
  ['presentations', 'Presentations'],
  ['media', 'Media'],
  ['themes', 'Themes'],
  ['fonts', 'Fonts'],
  ['import', 'Import'],
] as const;

export function LibraryView({ tab }: { tab: 'presentations' | 'media' | 'themes' | 'fonts' | 'import' }) {
  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%' }}>
      <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', gap: 4 }}>
        {TABS.map(([k, label]) => (
          <a
            key={k}
            className={`btn ${tab === k ? 'on' : 'ghost'}`}
            href={k === 'presentations' ? '#/library' : `#/library/${k}`}
          >
            {label}
          </a>
        ))}
      </div>
      <div style={{ minHeight: 0 }}>
        {tab === 'presentations' && <PresentationsTab />}
        {tab === 'media' && <MediaTab />}
        {tab === 'themes' && <ThemesTab />}
        {tab === 'fonts' && <FontsTab />}
        {tab === 'import' && <ImportTab />}
      </div>
    </div>
  );
}

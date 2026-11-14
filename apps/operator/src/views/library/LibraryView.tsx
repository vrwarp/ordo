import { PageHost } from '../../components/PageHost.tsx';
import { PAGES } from '../../pages.ts';
import { MediaTab } from './MediaTab.tsx';
import { PresentationsTab } from './PresentationsTab.tsx';

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
        {/* Themes, Fonts and Import come from the page registry: never on the compact path (design/28 §2.1). */}
        {tab === 'themes' && <PageHost name="themes" chunk={PAGES.themes} props={{}} />}
        {tab === 'fonts' && <PageHost name="fonts" chunk={PAGES.fonts} props={{}} />}
        {tab === 'import' && <PageHost name="import" chunk={PAGES.import} props={{}} />}
      </div>
    </div>
  );
}

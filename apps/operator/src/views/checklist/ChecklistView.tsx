import { buildChecklist } from '../../lib/checklist.ts';
import { useLibrary } from '../../state/library.ts';

/** Printable one-page checklist (#/checklist) generated from settings (prd/08). */
export function ChecklistView() {
  const settings = useLibrary((s) => s.data.settings);
  const sections = buildChecklist(settings, `${location.origin}${location.pathname}`);
  return (
    <div style={{ background: '#e5e7eb', minHeight: '100%', padding: '16px 0' }}>
      <div className="no-print row" style={{ justifyContent: 'center', marginBottom: 12 }}>
        <button type="button" className="primary big" onClick={() => window.print()}>
          Print
        </button>
      </div>
      <div className="checklist">
        <h1>{settings.general.venueName || 'ordo'} — service checklist</h1>
        <p>Printed {new Date().toLocaleDateString()}. Keep next to the presentation PC.</p>
        {sections.map((s) => {
          const List = s.ordered ? 'ol' : 'ul';
          return (
            <div key={s.title}>
              <h2>{s.title}</h2>
              <List>
                {s.items.map((it) => (
                  <li key={it}>
                    {s.ordered && <span className="box" />}
                    {it}
                  </li>
                ))}
              </List>
            </div>
          );
        })}
      </div>
    </div>
  );
}

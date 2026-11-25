import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Profile } from '../lib/capabilities.ts';
import { controller } from '../services/controller.ts';
import { useLibrary } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { toast } from '../state/toasts.ts';
import { navigate } from '../useRoute.ts';
import { Icon, type IconName } from './Icons.tsx';

type PaletteItem = {
  id: string;
  group: 'Navigate' | 'Playlists' | 'Library' | 'Settings' | 'Live Controls';
  title: string;
  subtitle?: string;
  icon: IconName;
  badge?: string;
  danger?: boolean;
  keywords?: string;
  run: () => void;
};

const SETTINGS_ENTRIES: readonly [string, string, IconName][] = [
  ['outputs', 'Screens & Outputs', 'monitor'],
  ['looks', 'Looks (Advanced)', 'layers'],
  ['audio', 'Audio Routing', 'audio'],
  ['keys', 'Keyboard Shortcuts', 'keyboard'],
  ['streamdeck', 'Stream Deck', 'streamdeck'],
  ['midi', 'MIDI & Lighting', 'midi'],
  ['messages', 'Stage Messages', 'message'],
  ['general', 'General Preferences', 'settings'],
  ['pins', 'PINs & Access', 'shield'],
  ['backups', 'Backups & Snapshots', 'backup'],
  ['diagnostics', 'Diagnostics & Logs', 'activity'],
];

/**
 * Global desktop Command Palette (⌘K / Ctrl+K).
 * Searches routes, playlists, songs/presentations, settings pages, and explicit Live controls.
 * Safe while ON AIR: selecting a song or playlist opens/previews without interrupting outputs
 * unless an explicit Live Control command is chosen.
 */
export function CommandPalette({
  role,
  profile,
  onClose,
}: {
  role: 'operate' | 'edit';
  profile: Profile;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const playlists = useLibrary((s) => s.data.playlists);
  const presentations = useLibrary((s) => s.data.presentations);
  const isLive = useLive((s) => s.state.mode === 'live');
  const canOperate = role === 'operate' && profile === 'full';

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const allItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: 'nav-playlists',
        group: 'Navigate',
        title: 'Playlists',
        subtitle: 'Build and organize services',
        icon: 'playlists',
        run: () => navigate({ name: 'playlists' }),
      },
      {
        id: 'nav-library',
        group: 'Navigate',
        title: 'Library — Presentations & Songs',
        subtitle: 'Browse and edit songs and decks',
        icon: 'library',
        run: () => navigate({ name: 'library', tab: 'presentations' }),
      },
      {
        id: 'nav-media',
        group: 'Navigate',
        title: 'Library — Media Bin',
        subtitle: 'Videos, backgrounds, and images',
        icon: 'video',
        run: () => navigate({ name: 'library', tab: 'media' }),
      },
      {
        id: 'nav-themes',
        group: 'Navigate',
        title: 'Library — Lyric Themes',
        subtitle: 'Typography and placement templates',
        icon: 'theme',
        run: () => navigate({ name: 'library', tab: 'themes' }),
      },
      {
        id: 'nav-fonts',
        group: 'Navigate',
        title: 'Library — Fonts',
        subtitle: 'Hub font families and Google Fonts',
        icon: 'font',
        run: () => navigate({ name: 'library', tab: 'fonts' }),
      },
      {
        id: 'nav-import',
        group: 'Navigate',
        title: 'Library — Import',
        subtitle: 'ProPresenter 7, SongSelect, PowerPoint & PDF',
        icon: 'import',
        run: () => navigate({ name: 'library', tab: 'import' }),
      },
    ];

    if (canOperate) {
      items.push(
        {
          id: 'nav-live',
          group: 'Navigate',
          title: 'Live Console',
          subtitle: isLive ? 'Return to active ON AIR service' : 'Open operator switcher',
          icon: 'live',
          badge: isLive ? 'ON AIR' : undefined,
          run: () => navigate({ name: 'live' }),
        },
        {
          id: 'nav-setup',
          group: 'Navigate',
          title: 'Device Setup & Hardware Patchbay',
          subtitle: 'Display permissions, MIDI, and Stream Deck',
          icon: 'setup',
          run: () => navigate({ name: 'setup' }),
        },
      );
    }

    for (const pl of playlists) {
      items.push({
        id: `pl-${pl.id}`,
        group: 'Playlists',
        title: pl.name,
        subtitle: `${pl.items.length} items${pl.serviceDate ? ` · ${pl.serviceDate}` : ''}`,
        icon: 'playlists',
        keywords: pl.serviceDate ?? '',
        run: () => navigate({ name: 'playlists', id: pl.id }),
      });
    }

    for (const p of presentations) {
      if (p.archived) continue;
      const slideCount = p.sections.reduce((sum, sec) => sum + sec.slides.length, 0);
      items.push({
        id: `pres-${p.id}`,
        group: 'Library',
        title: p.title,
        subtitle: `${p.kind} · ${slideCount} slides${isLive ? ' (opens safely in editor)' : ''}`,
        icon: p.kind === 'loop' ? 'loop' : p.kind === 'slides' ? 'slides' : 'music',
        keywords: `${p.meta.tags.join(' ')} ${p.meta.ccli ?? ''}`,
        run: () => navigate({ name: 'edit', id: p.id }),
      });
    }

    if (role === 'operate') {
      for (const [page, label, icon] of SETTINGS_ENTRIES) {
        if (profile === 'edit' && !['looks', 'messages', 'general', 'pins'].includes(page)) continue;
        items.push({
          id: `set-${page}`,
          group: 'Settings',
          title: `Settings → ${label}`,
          icon,
          keywords: `preferences ${page}`,
          run: () => navigate({ name: 'settings', page }),
        });
      }
    }

    if (canOperate) {
      items.push(
        {
          id: 'live-clear-slide',
          group: 'Live Controls',
          title: 'Clear Slide Layer',
          subtitle: 'Clears foreground slide text while keeping background',
          icon: 'slideLayer',
          badge: 'F1',
          run: () => {
            controller()?.clear('slide');
            toast('Cleared slide layer.', 'info', 2500);
          },
        },
        {
          id: 'live-clear-lower',
          group: 'Live Controls',
          title: 'Clear Banner / Lower Third',
          icon: 'bannerLayer',
          badge: 'F3',
          run: () => {
            controller()?.clear('lowerThird');
            toast('Cleared banner layer.', 'info', 2500);
          },
        },
        {
          id: 'live-clear-props',
          group: 'Live Controls',
          title: 'Clear Props & Timers',
          icon: 'propsLayer',
          badge: 'F4',
          run: () => {
            controller()?.clear('props');
            toast('Cleared props layer.', 'info', 2500);
          },
        },
        {
          id: 'live-clear-all',
          group: 'Live Controls',
          title: 'Clear All Layers to Black',
          subtitle: 'Immediately clears background, slide, media, banner, and props',
          icon: 'power',
          badge: 'LIVE',
          danger: true,
          run: () => {
            controller()?.clear('all');
            toast('Cleared all layers.', 'warn', 3000);
          },
        },
      );
    }

    return items;
  }, [playlists, presentations, canOperate, role, profile, isLive]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems.slice(0, 24);
    const terms = q.split(/\s+/);
    return allItems
      .filter((it) => {
        const hay = `${it.title} ${it.subtitle ?? ''} ${it.group} ${it.keywords ?? ''}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      })
      .slice(0, 32);
  }, [allItems, query]);

  const safeIdx = Math.min(activeIdx, Math.max(0, filtered.length - 1));

  useEffect(() => {
    const activeEl = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${safeIdx}"]`);
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [safeIdx]);

  const execute = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(filtered[safeIdx]);
    }
  };

  let lastGroup: string | undefined;

  const dialog = (
    <div
      className="cmd-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      data-keys="off"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="cmd-palette">
        <div className="cmd-input-row">
          <Icon name="search" size={16} className="muted" />
          <input
            ref={inputRef}
            type="text"
            className="cmd-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            placeholder="Jump to song, playlist, setting, or live command…"
          />
          <span className="kbd">Esc</span>
        </div>
        <div ref={listRef} className="cmd-list">
          {filtered.length === 0 ? (
            <div className="cmd-empty muted">No matching commands or items.</div>
          ) : (
            filtered.map((item, idx) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              const isActive = idx === safeIdx;
              return (
                <div key={item.id}>
                  {showGroup && <div className="cmd-group-label">{item.group}</div>}
                  <button
                    type="button"
                    className={`cmd-item${isActive ? ' active' : ''}${item.danger ? ' danger' : ''}`}
                    data-palette-index={idx}
                    data-palette-active={isActive ? 'true' : undefined}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => execute(item)}
                  >
                    <Icon name={item.icon} size={15} />
                    <span className="col grow" style={{ minWidth: 0, gap: 1, textAlign: 'left' }}>
                      <span className="ellipsis cmd-item-title">{item.title}</span>
                      {item.subtitle && <span className="ellipsis cmd-item-sub">{item.subtitle}</span>}
                    </span>
                    {item.badge && (
                      <span className={`tag${item.danger || item.badge === 'ON AIR' ? ' red' : ''}`}>
                        {item.badge}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}

export default CommandPalette;

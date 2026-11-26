import { DEMO } from '@ordo/client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { choiceDialog, confirmDialog } from '../components/Confirm.tsx';
import { DemoDialog } from '../components/DemoBanner.tsx';
import { Icon, type IconName } from '../components/Icons.tsx';
import { usePopupOf } from '../components/popupOf.ts';
import { useLockedIds } from '../hooks.ts';
import type { Profile } from '../lib/capabilities.ts';
import type { Route } from '../lib/route.ts';
import { useVenueLive } from '../lib/venueLive.ts';
import { journalClearAll, markBypassBeforeUnload } from '../state/draftJournal.ts';
import { useLibrary } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { logout, useSession } from '../state/session.ts';
import { focusThemeDraft } from '../state/themeDrafts.ts';
import {
  flushDebouncedItems,
  type UnsavedItem,
  useAnyLibraryDraftDirty,
  useAnySettingsDirty,
  useUnsaved,
  visibleUnsavedItems,
} from '../state/unsaved.ts';
import { navigate } from '../useRoute.ts';

/**
 * Guard explicit Sign out when unsaved drafts exist: prompts "Save all & Sign out" / "Discard & Sign out" / "Cancel",
 * clearing the IndexedDB draft journal on Discard & Sign out so a shared device starts clean for the next volunteer.
 */
export async function guardedLogout(): Promise<void> {
  await flushDebouncedItems();
  const items = visibleUnsavedItems();
  if (items.length > 0) {
    const choice = await choiceDialog<'save' | 'discard' | 'cancel'>({
      title: 'Unsaved changes',
      text: `You have unsaved changes:\n${items.map((it) => `• ${it.label}`).join('\n')}\n\nSave them before signing out?`,
      cancelValue: 'cancel',
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'discard', label: 'Discard & Sign out', tone: 'danger' },
        { value: 'save', label: 'Save all & Sign out', tone: 'primary', autoFocus: true },
      ],
    });
    if (choice === 'cancel') return;
    if (choice === 'save') {
      for (const it of items) {
        if (!(await it.save())) return;
      }
      await journalClearAll();
    } else {
      for (const it of items) {
        await it.discard();
      }
      await journalClearAll();
    }
  }
  markBypassBeforeUnload(true);
  await logout();
}

/**
 * "Live now: <playlist>, <cue>" on an edit-profile device, so the worship lead knows which playlist is
 * locked while a service runs at the venue (read-only; the hub refuses edits to it with 423).
 */
function LiveChip() {
  // A string selector: a fresh object per read would re-render forever.
  const own = useLive((s) => {
    const st = s.state;
    if (st.mode !== 'live' || !st.resolved) return '';
    const cue = st.live !== undefined ? st.cues[st.live] : undefined;
    return `Live now: ${st.resolved.playlist.name}${cue?.label ? `, ${cue.label}` : ''}`;
  });
  // The edit core gets no live state from the hub: the polled summary (lib/venueLive.ts).
  const venue = useVenueLive((s) =>
    s.live ? `Live now: ${s.live.playlistName}${s.live.cueLabel ? `, ${s.live.cueLabel}` : ''}` : '',
  );
  const text = own || venue;
  if (!text) return null;
  return (
    <span className="tag red live-chip ellipsis" data-live-chip aria-live="polite">
      ● {text}
    </span>
  );
}

/**
 * Compact "● N unsaved ▾" pill in the top Nav with a popover listing every background draft
 * (Open, Save, Discard per item + Save all). Hidden when nothing is unsaved.
 */
function UnsavedNavControl() {
  const rawItems = useUnsaved((s) => s.items);
  const items = visibleUnsavedItems(rawItems);
  const locked = useLockedIds();
  const [open, setOpen] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  usePopupOf(popRef, trigger, open, () => setOpen(false));

  useEffect(() => {
    if (items.length === 0 && open) setOpen(false);
  }, [items.length, open]);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !popRef.current) return;
    const place = () => {
      if (!trigger.current || !popRef.current) return;
      const tr = trigger.current.getBoundingClientRect();
      const pr = popRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(tr.right - pr.width, window.innerWidth - pr.width - 8));
      const top = Math.max(8, Math.min(tr.bottom + 6, window.innerHeight - pr.height - 8));
      setPos({ left: Math.round(left), top: Math.round(top) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: Event) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (!trigger.current?.contains(target) && !popRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  const isLocked = (it: UnsavedItem) => it.kind === 'presentation' && locked.has(it.id);
  const saveableItems = items.filter((it) => !isLocked(it) && !it.saving);

  const openItem = (it: UnsavedItem) => {
    setOpen(false);
    if (it.kind === 'theme') {
      focusThemeDraft(it.id);
    } else {
      navigate(it.route);
    }
  };

  const discardItem = async (it: UnsavedItem) => {
    setOpen(false);
    if (
      !(await confirmDialog(
        'Discard unsaved changes',
        `Discard unsaved changes to “${it.label}”?`,
        'Discard',
        true,
      ))
    )
      return;
    await it.discard();
  };

  const saveAll = async () => {
    setSavingAll(true);
    try {
      for (const it of saveableItems) {
        if (!(await it.save())) break;
      }
    } finally {
      setSavingAll(false);
    }
  };

  const popover = open ? (
    <div
      ref={popRef}
      className="unsaved-popover"
      role="dialog"
      aria-label="Unsaved changes"
      data-unsaved-popover
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
    >
      <div className="row unsaved-popover-head">
        <b>Unsaved changes ({items.length})</b>
        <button
          type="button"
          className="small primary"
          disabled={savingAll || saveableItems.length === 0}
          onClick={() => void saveAll()}
        >
          {savingAll ? 'Saving…' : 'Save all'}
        </button>
      </div>
      <div className="col unsaved-popover-list">
        {items.map((it) => {
          const itemLocked = isLocked(it);
          return (
            <div key={it.key} className="row unsaved-popover-item" data-unsaved-item={it.key}>
              <div className="col grow" style={{ minWidth: 0, gap: 2 }}>
                <span className="ellipsis" style={{ fontWeight: 500 }}>
                  {it.label}
                </span>
                {itemLocked && <span className="muted small">Locked until End service</span>}
                {it.error && <span className="muted small">{it.error}</span>}
              </div>
              <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                <button type="button" className="small ghost" onClick={() => openItem(it)}>
                  Open
                </button>
                <button
                  type="button"
                  className="small primary"
                  disabled={Boolean(it.saving) || itemLocked || savingAll}
                  title={itemLocked ? 'Locked while in the live playlist' : undefined}
                  onClick={() => void it.save()}
                >
                  {it.saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="small danger ghost"
                  disabled={Boolean(it.saving) || savingAll}
                  onClick={() => void discardItem(it)}
                >
                  Discard
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`unsaved-nav-pill${open ? ' on' : ''}`}
        data-unsaved-pill
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="unsaved-dot" aria-hidden="true">
          ●
        </span>
        <span>{items.length} unsaved ▾</span>
      </button>
      {popover && (typeof document !== 'undefined' ? createPortal(popover, document.body) : popover)}
    </>
  );
}

/** ProPresenter-style 14px status ring/disc SVG: hollow coral ring when off, amber ring when degraded, solid green disc when live & healthy. */
function LampRing({ state }: { state: 'green' | 'amber' | 'off' }) {
  if (state === 'green') {
    return (
      <svg width={15} height={15} viewBox="0 0 16 16" aria-hidden="true" className="ico lamp-ring-svg">
        <circle cx={8} cy={8} r={5.5} fill="#22c55e" />
      </svg>
    );
  }
  const stroke = state === 'amber' ? '#f59e0b' : '#ef4444';
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="ico lamp-ring-svg"
    >
      <circle cx={8} cy={8} r={5} stroke={stroke} strokeWidth={2} />
    </svg>
  );
}

/** ProPresenter-style Audience & Stage 42px icon-above-label ring lamps shown outside #/live. */
function NavOutputLamps() {
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const health = useLive((s) => s.health);
  const enabled = outputs.filter((o) => o.enabled);
  if (enabled.length === 0) return null;

  const aud = enabled.filter((o) => o.kind !== 'stage');
  const stg = enabled.filter((o) => o.kind === 'stage');

  const groupState = (list: typeof enabled): 'green' | 'amber' | 'off' => {
    const conn = list.filter((o) => health[o.id]?.connected);
    if (conn.length === 0) return 'off';
    if (conn.length < list.length) return 'amber';
    const degraded = conn.some((o) => {
      const h = health[o.id];
      return Boolean(h?.error || (h && h.cache.total > 0 && h.cache.ready < h.cache.total));
    });
    return degraded ? 'amber' : 'green';
  };

  return (
    <>
      {aud.length > 0 && (
        <button
          type="button"
          className="nav-mode-btn"
          onClick={() => navigate('#/settings/outputs')}
          title="Audience screens — click to configure outputs"
          aria-label="Audience outputs"
        >
          <span className="nav-mode-ico">
            <LampRing state={groupState(aud)} />
          </span>
          <span className="nav-mode-lbl">Audience</span>
        </button>
      )}
      {stg.length > 0 && (
        <button
          type="button"
          className="nav-mode-btn"
          onClick={() => navigate('#/settings/outputs')}
          title="Stage display — click to configure outputs"
          aria-label="Stage outputs"
        >
          <span className="nav-mode-ico">
            <LampRing state={groupState(stg)} />
          </span>
          <span className="nav-mode-lbl">Stage</span>
        </button>
      )}
    </>
  );
}

export function Nav({
  role,
  route,
  profile = 'full',
  onOpenPalette,
}: {
  role: 'operate' | 'edit';
  route: Route;
  profile?: Profile;
  onOpenPalette?: () => void;
}) {
  const [demoOpen, setDemoOpen] = useState(false);
  const venue = useLibrary((s) => s.data.settings.general.venueName);
  const offline = useSession((s) => s.status === 'offline');
  const live = useLive((s) => s.state.mode === 'live');
  const libDirty = useAnyLibraryDraftDirty();
  const settingsDirty = useAnySettingsDirty();
  const roleLabel = role === 'operate' ? 'Operator' : 'Editor';

  const link = (
    href: string,
    label: string,
    icon: IconName,
    active: boolean,
    dirty = false,
    isOnAir = false,
  ) => (
    <a
      href={href}
      className={`nav-mode-btn${active ? ' active' : ''}${isOnAir ? ' on-air' : ''}`}
      aria-label={isOnAir ? `● ${label}` : undefined}
    >
      <span className="nav-mode-ico">
        <Icon name={icon} size={17} />
        {isOnAir && <span className="dot sm red nav-live-pip" aria-hidden="true" />}
        {dirty && (
          <span className="unsaved-dot nav-dirty-pip" title="Unsaved changes" aria-label="Unsaved changes">
            ●
          </span>
        )}
      </span>
      <span className="nav-mode-lbl">{label}</span>
    </a>
  );

  const isDemo = DEMO || (venue?.toLowerCase().includes('demo') ?? false);
  const brandName = venue ? venue.replace(/\s*demo$/i, '') : 'ordo';

  const brandElement = (
    <span className="brand">
      <span className="brand-name">{brandName}</span>
      {isDemo && (
        <button
          type="button"
          className="demo-badge-btn"
          data-demo-banner
          onClick={() => setDemoOpen(true)}
          title="About ordo demo and reset"
          aria-label="About ordo demo"
        >
          demo
        </button>
      )}
    </span>
  );

  const cmdTrigger = onOpenPalette ? (
    <button
      type="button"
      className="nav-mode-btn nav-cmd-btn"
      onClick={onOpenPalette}
      title="Command Palette (Ctrl+K / ⌘K)"
      aria-label="Command palette"
    >
      <span className="nav-mode-ico">
        <Icon name="search" size={16} />
      </span>
      <span className="nav-mode-lbl">Search</span>
    </button>
  ) : null;

  const signOutBtn = (
    <button
      type="button"
      className="nav-mode-btn"
      onClick={() => void guardedLogout()}
      title={`Sign out (${roleLabel})`}
      aria-label="Sign out"
    >
      <span className="nav-mode-ico">
        <Icon name="logout" size={16} />
      </span>
      <span className="nav-mode-lbl">Sign out</span>
    </button>
  );

  if (profile === 'edit')
    return (
      <>
        <nav className="nav no-print" data-profile="edit">
          {brandElement}
          {cmdTrigger}
          <span className="nav-divider" aria-hidden="true" />
          {link('#/playlists', 'Playlists', 'playlists', route.name === 'playlists')}
          {link(
            '#/library',
            'Library',
            'library',
            route.name === 'library' || route.name === 'edit',
            libDirty,
          )}
          {link('#/previews', 'Previews', 'previews', route.name === 'previews')}
          {role === 'operate' &&
            link('#/settings/general', 'Settings', 'settings', route.name === 'settings', settingsDirty)}
          <span className="spacer" />
          <UnsavedNavControl />
          <LiveChip />
          {offline && <span className="tag amber">offline: hub unreachable</span>}
          {role === 'operate' && (
            <span className="muted small edit-device-note" data-edit-device-note>
              Edit device
            </span>
          )}
          <span className="nav-divider" aria-hidden="true" />
          {signOutBtn}
        </nav>
        {demoOpen && <DemoDialog onClose={() => setDemoOpen(false)} />}
      </>
    );

  return (
    <>
      <nav className="nav no-print">
        {brandElement}
        {cmdTrigger}
        <span className="nav-divider" aria-hidden="true" />
        {link('#/playlists', 'Playlists', 'playlists', route.name === 'playlists')}
        {link('#/library', 'Library', 'library', route.name === 'library' || route.name === 'edit', libDirty)}
        {role === 'operate' && link('#/live', 'Live', 'live', route.name === 'live', false, live)}
        {role === 'operate' &&
          link('#/setup', 'Setup', 'setup', route.name === 'setup' || route.name === 'checklist')}
        {role === 'operate' &&
          link('#/settings/outputs', 'Settings', 'settings', route.name === 'settings', settingsDirty)}
        <span className="spacer" />
        {role === 'operate' && route.name === 'live' && <div id="nav-live-slot" className="nav-live-slot" />}
        {role === 'operate' && route.name !== 'live' && <NavOutputLamps />}
        <UnsavedNavControl />
        {offline && <span className="tag amber">offline: hub unreachable</span>}
        <span className="nav-divider" aria-hidden="true" />
        {signOutBtn}
      </nav>
      {demoOpen && <DemoDialog onClose={() => setDemoOpen(false)} />}
    </>
  );
}

/**
 * Settings → PINs: the Phones switch (design/28 §9, owner question 5) and how readers of this build and of an
 * older one take `settings.phones` and `Job.waiting` (design/28 P0; additive, read with defaults).
 */
import type { Job } from '@ordo/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyLibrary, withDefaults } from '../src/core/libraryStore.ts';
import { applyLibraryDelta, fromSnapshot, type LibraryData, SETTINGS_KEYS } from '../src/lib/libraryData.ts';
import { useLibrary } from '../src/state/library.ts';
import { PHONES_HELP, PhonesSwitch, PinsPage, pinChangedText } from '../src/views/settings/PinsPage.tsx';

const draw = (enabled: boolean) =>
  renderToStaticMarkup(createElement(PhonesSwitch, { enabled, onChange: () => undefined }));

describe('the Phones switch', () => {
  it('shows the hub setting, off and on, with what it does', () => {
    const off = draw(false);
    expect(off).toContain('Phones are used during services');
    expect(off).not.toContain('checked');
    expect(off).toContain(PHONES_HELP.slice(0, 40));
    expect(draw(true)).toContain('checked=""');
  });

  it('is off in the store when the hub sends no phones (an older hub)', () => {
    expect(withDefaults(emptyLibrary().settings).phones).toEqual({ enabled: false });
    expect(withDefaults({ phones: { enabled: true } }).phones).toEqual({ enabled: true });
    expect(useLibrary.getState().data.settings.phones?.enabled === true).toBe(false);
  });

  it('a PIN change says phones that signed in with it are signed out too', () => {
    expect(pinChangedText('operatePin')).toBe(
      'Operate PIN changed. Sessions that signed in with it, phones included, are signed out.',
    );
    expect(pinChangedText('editPin')).toMatch(/^Edit PIN changed\. .*phones included/);
  });

  it('sits on the PINs page under the PIN form', () => {
    const html = renderToStaticMarkup(createElement(PinsPage));
    expect(html.indexOf('Change PIN')).toBeGreaterThan(0);
    expect(html.indexOf('data-section="phones"')).toBeGreaterThan(html.indexOf('Change PIN'));
  });
});

const job = (extra: Partial<Job> = {}): Job => ({
  id: 'j1',
  kind: 'media',
  state: 'queued',
  progress: 0,
  log: [],
  createdAt: '2026-11-14T00:00:00Z',
  updatedAt: '2026-11-14T00:00:00Z',
  ...extra,
});

function library(settings: Record<string, unknown>): LibraryData {
  return fromSnapshot({
    seq: 1,
    presentations: [],
    playlists: [],
    media: [],
    fonts: [],
    themes: [],
    folders: [],
    settings: settings as never,
  });
}

/** An older build's settings branch (main 0.5.0, libraryData.ts): it takes six keys by value, refetches others. */
function olderRefetches(id: string, entity: unknown): boolean {
  const known = ['general', 'looks', 'outputs', 'audio', 'keymap', 'surfaces'];
  if (known.includes(id) && entity !== undefined) return false;
  if (!known.includes(id) && entity && typeof entity === 'object' && 'looks' in entity) return false;
  return true;
}

describe('readers of settings.phones and Job.waiting', () => {
  it("this build takes a 'phones' change by value", () => {
    const d = library({ general: { venueName: 'x' } });
    expect(SETTINGS_KEYS).toContain('phones');
    const r = applyLibraryDelta(d, [{ kind: 'settings', id: 'phones', entity: { enabled: true } }]);
    expect(r.refetchSettings).toBe(false);
    expect(r.data.settings.phones).toEqual({ enabled: true });
  });

  it('this build reads a snapshot without phones as off', () => {
    const d = library({ general: { venueName: 'x' } });
    expect(d.settings.phones?.enabled === true).toBe(false);
    expect(withDefaults(d.settings).phones).toEqual({ enabled: false });
  });

  it('an older build refetches on a phones change and keeps a held job as it came', () => {
    const d = library({ general: { venueName: 'x' }, phones: { enabled: true } });
    expect(olderRefetches('phones', { enabled: true })).toBe(true);
    // The older reader's job branch is this one, unchanged: the extra field is carried, never a failure.
    const r = applyLibraryDelta(d, [{ kind: 'job', id: 'j1', entity: job({ waiting: 'service' }) }]);
    expect(r.data.jobs.j1?.waiting).toBe('service');
    expect(r.data.jobs.j1?.state).toBe('queued');
  });
});

/**
 * Dialogs as bottom sheets on the compact layout (design/28 §2.2 "Sheets"; components/Dialog.tsx): the compact
 * branch's markup (the sheet class, no inline width, labelled by its title), today's markup byte for byte on the
 * regular layout (the venue PC and the iPad), and the sheet bookkeeping of components/dialogEscape.ts (#root
 * inert while one is open, the opener to focus again).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from '../src/components/Dialog.tsx';
import { openerFor, openSheetCount, registerSheet, trackPresses } from '../src/components/dialogEscape.ts';
import { applyLayout, resetLayoutForTests } from '../src/lib/layout.ts';

const render = (props: Parameters<typeof Dialog>[0]) => renderToStaticMarkup(createElement(Dialog, props));
const confirmLike = () =>
  render({
    title: 'Delete media',
    onClose: () => undefined,
    footer: createElement('button', { type: 'button' }, 'OK'),
    width: 760,
    children: 'Body text',
  });

afterEach(() => resetLayoutForTests());

describe('Dialog', () => {
  it('regular layout: the markup is today’s, byte for byte', () => {
    resetLayoutForTests();
    expect(confirmLike()).toBe(
      '<div class="backdrop" data-keys="off"><div class="dialog" style="width:760px" role="dialog" aria-modal="true" tabindex="-1"><header><h3>Delete media</h3><button type="button" class="ghost small" aria-label="Close">✕</button></header><div class="body">Body text</div><footer><button type="button">OK</button></footer></div></div>',
    );
    expect(render({ title: 'Plain', children: 'x' })).toBe(
      '<div class="backdrop" data-keys="off"><div class="dialog" role="dialog" aria-modal="true" tabindex="-1"><header><h3>Plain</h3></header><div class="body">x</div></div></div>',
    );
  });

  it('compact layout: a sheet, labelled by its title, with no inline width', () => {
    applyLayout('compact', undefined);
    const html = confirmLike();
    expect(html).toContain('class="backdrop sheet-backdrop"');
    expect(html).toContain('class="dialog sheet"');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('760');
    const id = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<h3 id="${id}">Delete media</h3>`);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('<footer><button type="button">OK</button></footer>');
  });
});

/** A document as far as the sheets go: #root's attributes, the active element and capture listeners. */
function fakeDoc() {
  const attrs = new Map<string, string>();
  const root = {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  };
  const body = {};
  const listeners: ((e: Event) => void)[] = [];
  const doc = {
    body,
    documentElement: {},
    activeElement: body as unknown,
    getElementById: (id: string) => (id === 'root' ? root : null),
    addEventListener: (_t: string, fn: (e: Event) => void) => void listeners.push(fn),
    removeEventListener: (_t: string, fn: (e: Event) => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const press = (el: unknown) => {
    for (const fn of listeners) fn({ target: { closest: () => el } } as unknown as Event);
  };
  return { doc: doc as unknown as Document, inert: () => attrs.has('inert'), press, listeners };
}

describe('sheet bookkeeping', () => {
  it('#root is inert while a sheet is open; the last one to close lifts it', () => {
    const f = fakeDoc();
    const a = registerSheet(f.doc);
    const b = registerSheet(f.doc);
    expect(f.inert()).toBe(true);
    expect(openSheetCount()).toBe(2);
    a();
    expect(f.inert()).toBe(true);
    b();
    expect(f.inert()).toBe(false);
    expect(openSheetCount()).toBe(0);
  });

  it('the opener: the focused control, else the control pressed just before (Safari never focuses a tapped button)', () => {
    const f = fakeDoc();
    const button = { isConnected: true };
    expect(openerFor(f.doc)).toBeNull();
    const off = trackPresses(f.doc);
    f.press(button);
    expect(openerFor(f.doc)).toBe(button);
    const focused = {};
    (f.doc as unknown as { activeElement: unknown }).activeElement = focused;
    expect(openerFor(f.doc)).toBe(focused);
    off();
    expect(f.listeners).toHaveLength(0);
    (f.doc as unknown as { activeElement: unknown }).activeElement = f.doc.body;
    expect(openerFor(f.doc)).toBeNull();
  });
});

import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { HubProcess } from '../hubproc.ts';
import { portOf } from '../ports.ts';
import {
  expectCappedSession,
  PIN,
  phoneSlot,
  pinBodies,
  signInPhone,
  watchRefusals,
} from './phonehelpers.ts';

/**
 * A phone on the live boundary (design/28 §8 "Live boundary", §10): signed in with the operate PIN while a
 * service is live, it can neither drive the service nor delete, change settings, fonts or themes, import, or
 * change a slide's MIDI cues; the Live now summary carries no slide text; and its sign-in leaves no device
 * cookie and a one-hour session. The phone signs in on its keypad (e2e/phone/phonehelpers.ts signInPhone), so
 * the cap is the one its client asks for; the calls after that are crafted from the page's own origin with
 * `x-ordo`, so what is measured is the hub's cap, not the Origin or header checks. Runs in webkit-iphone and
 * chromium-android, each on its own hub (e2e/ports.ts row 'phone-live-boundary': 0 webkit-iphone, 1
 * chromium-android). At d0f49cb every refusal below failed (16 checks, regroup notes d0f49cb-live-boundary).
 */
const SONG = (title: string) =>
  `${title}\n\nVerse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\n`;
const CUE = { id: 'cue-1', channel: 1, type: 'programChange', number: 7, value: 127 };

type Rec = { id: string; rev: number; [k: string]: unknown };
type Slide = { id: string; midiCues?: unknown[]; [k: string]: unknown };
type Pres = Rec & { sections: { slides: Slide[] }[] };

async function json<T>(r: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await r;
  if (!res.ok()) throw new Error(`${res.url()} -> ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/** The venue PC's side: a live service of song A; song B has MIDI cues; song C is for the delete. */
async function venue(
  port: number,
): Promise<{ api: APIRequestContext; a: Pres; b: Pres; c: Pres; themeId: string }> {
  const api = await request.newContext({
    baseURL: `http://localhost:${port}/api/v1/`,
    extraHTTPHeaders: { 'x-ordo': '1' },
  });
  expect((await api.post('auth/pin', { data: { pin: PIN } })).ok()).toBe(true);
  const make = (t: string) => json<Pres>(api.post('import/songselect', { data: { text: SONG(t) } }));
  const a = await make('Live song');
  const b0 = await make('Cued song');
  b0.sections[0]!.slides[0]!.midiCues = [CUE];
  const b = await json<Pres>(api.put(`presentations/${b0.id}`, { data: b0 }));
  const c = await make('Old song');
  const pl = await json<Rec>(
    api.post('playlists', {
      data: { name: 'Sunday', items: [{ id: 'i1', kind: 'presentation', presentationId: a.id }] },
    }),
  );
  await json(api.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } }));
  await json(api.post('live/events', { data: { id: 'n1', event: { k: 'next', at: Date.now() } } }));
  const themes = await json<Rec[]>(api.get('themes'));
  return { api, a, b, c, themeId: themes[0]!.id };
}

/** A request from the page, as the phone's client makes it (same origin, x-ordo). */
async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(`/api/v1${p}`, {
        method: m as string,
        headers: { 'x-ordo': '1', ...(b === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      let error: { code?: string; field?: string; need?: string } | undefined;
      let body: unknown;
      try {
        body = await r.json();
        error = (body as { error?: typeof error }).error;
      } catch {
        /* 204 */
      }
      return { status: r.status, code: error?.code, field: error?.field, need: error?.need, body };
    },
    [method, path, body] as const,
  );
}

/** One WebSocket from the page: hello as `role`, then `send`; resolves with what came back. */
async function socket(page: Page, version: string, role: string, send?: unknown) {
  return page.evaluate(
    async ([v, r, s]) => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`);
      const got: Record<string, unknown>[] = [];
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error('ws'));
      });
      ws.onmessage = (e) => got.push(JSON.parse(String(e.data)) as Record<string, unknown>);
      ws.send(JSON.stringify({ t: 'hello', v: 1, role: r, appVersion: v }));
      await new Promise((res) => setTimeout(res, 500));
      if (s) ws.send(JSON.stringify(s));
      await new Promise((res) => setTimeout(res, 800));
      ws.close();
      return got;
    },
    [version, role, send] as const,
  );
}

test('a phone signed in with the operate PIN can neither drive the service nor change what it must not', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const port = portOf('phone-live-boundary', phoneSlot());
  const hub = HubProcess.fresh(port);
  await hub.start();
  try {
    const { a, b, c, themeId } = await venue(port);
    const op = `http://op.localhost:${port}`;
    // A phone that signed in before the upgrade, with main's "Remember this device" ticked: a device cookie.
    // A real sign-in on localhost (Node does not resolve op.localhost; the browser does), its host-only cookies
    // copied to op.localhost.
    const old = await request.newContext({
      baseURL: `http://localhost:${port}/api/v1/`,
      extraHTTPHeaders: { 'x-ordo': '1' },
    });
    expect((await old.post('auth/pin', { data: { pin: PIN, remember: true } })).ok()).toBe(true);
    const { cookies: seeded } = await old.storageState();
    await old.dispose();
    expect(seeded.map((k) => k.name).sort()).toEqual(['ordo_device', 'ordo_session']);
    await page.context().addCookies(seeded.map((k) => ({ ...k, domain: 'op.localhost' })));
    // The keypad, as a phone signs in: its client signs the old session out once and asks for cap 'light'.
    // watchRefusals (the shell and split specs expect none) must see every refusal below.
    const seen = watchRefusals(page);
    const pins = pinBodies(page);
    await signInPhone(page, `${op}/`);
    expect(pins).toEqual([{ pin: PIN, cap: 'light' }]);
    const { version } = (await call(page, 'GET', '/auth/me')).body as { version: string };

    // The sign-in: no device cookie, a session of at most an hour, role edit with cap light.
    await expectCappedSession(page);

    // The live path and what a phone must never change (design/28 §10).
    const refused = async (what: string, method: string, path: string, body?: unknown) => {
      const r = await call(page, method, path, body);
      expect({ what, status: r.status, code: r.code }, what).toEqual({ what, status: 403, code: 'cap' });
    };
    await refused('POST /live/events', 'POST', '/live/events', {
      id: 'p1',
      event: { k: 'next', at: Date.now() },
    });
    await refused('POST /actions', 'POST', '/actions', { id: 'next' });
    await refused('DELETE /presentations/:id', 'DELETE', `/presentations/${c.id}`);
    const general = (await call(page, 'GET', '/settings/general')).body;
    await refused('PUT /settings/general', 'PUT', '/settings/general', general);
    await refused('POST /fonts/google', 'POST', '/fonts/google', { family: 'Roboto' });
    const theme = (await call(page, 'GET', `/themes/${themeId}`)).body as Record<string, unknown>;
    await refused('PUT /themes/:id', 'PUT', `/themes/${themeId}`, theme);
    await refused('POST /import/songselect', 'POST', '/import/songselect', { text: SONG('Imported') });

    // A slide's MIDI cues: refused, naming the field; a save that leaves them alone is accepted.
    const cued = (await call(page, 'GET', `/presentations/${b.id}`)).body as Pres;
    const changed = structuredClone(cued);
    changed.sections[0]!.slides[0]!.midiCues = [{ ...CUE, value: 1 }];
    const cue = await call(page, 'PUT', `/presentations/${b.id}`, changed);
    expect({ status: cue.status, code: cue.code, field: cue.field }, 'MIDI cues').toEqual({
      status: 403,
      code: 'cap',
      field: 'midiCues',
    });
    // Read again: before P0 the cue change was saved and moved the revision on.
    const typo = (await call(page, 'GET', `/presentations/${b.id}`)).body as Pres;
    typo.title = 'Cued song (fixed)';
    expect((await call(page, 'PUT', `/presentations/${b.id}`, typo)).status, 'a light change is saved').toBe(
      200,
    );

    // The socket: a live command is refused for the cap; hello operate is refused.
    const asEdit = await socket(page, version, 'edit', {
      t: 'live.event',
      v: 1,
      id: 'ws-1',
      event: { k: 'next', at: Date.now() },
    });
    const ack = asEdit.find((m) => m.t === 'live.ack' && m.id === 'ws-1');
    expect(ack?.rejected, 'WS live.event').toBe('forbidden: cap');
    expect(
      asEdit.some((m) => m.t === 'live.state' || m.t === 'live.delta'),
      'no live state on the socket',
    ).toBe(false);
    const asOperate = await socket(page, version, 'operate');
    expect(asOperate.find((m) => m.t === 'bye')?.reason, 'hello operate').toBe('forbidden');

    // Live now: the plan's name and lock count, never slide text.
    const sum = (await call(page, 'GET', '/live/summary')).body as Record<string, unknown>;
    expect(sum.mode).toBe('live');
    expect(sum.lockedPresentationIds).toEqual([a.id]);
    expect(sum, 'the summary has no slide text').not.toHaveProperty('liveLabel');
    expect(JSON.stringify(sum), 'no lyric in the summary').not.toContain('Amazing grace');

    // The refusals as phonehelpers.watchRefusals lists them: the eight routes and the MIDI cue save, each 403
    // cap, and nothing before them (the sign-in and the old session's sign-out are not refusals).
    const listed = await seen();
    expect(listed.filter((r) => r.status === 403 && r.code === 'cap')).toHaveLength(8);
    expect(listed.every((r) => r.code === 'cap')).toBe(true);
  } finally {
    hub.kill();
  }
});

import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  request,
  test,
} from '@playwright/test';
import { HubProcess } from '../hubproc.ts';
import { portOf } from '../ports.ts';

/**
 * A phone on the live boundary (design/28 §8 "Live boundary", §10): signed in with the operate PIN while a
 * service is live, it can neither drive the service nor delete, change settings, fonts or themes, import, or
 * change a slide's MIDI cues; the Live now summary carries no slide text; and its sign-in leaves no device
 * cookie and a one-hour session. Every call is crafted from the page's own origin with `x-ordo`, so what is
 * measured is the hub's cap, not the Origin or header checks; each refusal is a soft expectation, so a run
 * against a hub before P0 lists every one that failed. Its own hub (e2e/ports.ts row 'phone-live-boundary':
 * 0 chromium or webkit-iphone, 1 chromium-android). Until the phone projects exist it runs in the chromium
 * project in a 390x844 touch context.
 */
const PIN = '246810';
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

/** The phone's sign-in: cap 'light' to a hub that lists caps (GET /auth/me), else as an older client signs in. */
async function signInPhone(page: Page): Promise<{ caps: boolean; version: string }> {
  const me = (await call(page, 'GET', '/auth/me')).body as { caps?: string[]; version: string };
  const caps = Array.isArray(me.caps) && me.caps.includes('light');
  const res = await call(page, 'POST', '/auth/pin', caps ? { pin: PIN, cap: 'light' } : { pin: PIN });
  expect(res.status).toBe(200);
  return { caps, version: me.version };
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
  browser,
  context,
}, info) => {
  test.setTimeout(120_000);
  const port = portOf('phone-live-boundary', info.project.name === 'chromium-android' ? 1 : 0);
  const hub = HubProcess.fresh(port);
  await hub.start();
  // The phone projects bring their own device; the desktop project gets a phone-sized touch context.
  const ctx: BrowserContext =
    info.project.name === 'chromium'
      ? await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
      : context;
  try {
    const { a, b, c, themeId } = await venue(port);
    const page = await ctx.newPage();
    const op = `http://op.localhost:${port}`;
    await page.goto(`${op}/`);
    // A phone that signed in before the upgrade, with main's "Remember this device" ticked: a device cookie.
    expect((await call(page, 'POST', '/auth/pin', { pin: PIN, remember: true })).status).toBe(200);
    const { caps, version } = await signInPhone(page);
    expect.soft(caps, 'the hub lists caps (GET /auth/me caps)').toBe(true);

    // The sign-in: no device cookie, a session of about an hour.
    const cookies = await ctx.cookies(op);
    expect.soft(cookies.find((k) => k.name === 'ordo_device')?.value ?? '', 'no ordo_device cookie').toBe('');
    const session = cookies.find((k) => k.name === 'ordo_session');
    expect(session).toBeTruthy();
    const left = session!.expires - Date.now() / 1000;
    expect.soft(left, 'the session expires within about an hour').toBeLessThan(3700);
    expect.soft((await call(page, 'GET', '/auth/me')).body, 'the session is capped').toMatchObject({
      role: 'edit',
      cap: 'light',
    });

    // The live path and what a phone must never change (design/28 §10).
    const refused = async (what: string, method: string, path: string, body?: unknown) => {
      const r = await call(page, method, path, body);
      expect.soft({ what, status: r.status, code: r.code }, what).toEqual({ what, status: 403, code: 'cap' });
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
    expect.soft({ status: cue.status, code: cue.code, field: cue.field }, 'MIDI cues').toEqual({
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
    expect.soft(ack?.rejected, 'WS live.event').toBe('forbidden: cap');
    expect
      .soft(
        asEdit.some((m) => m.t === 'live.state' || m.t === 'live.delta'),
        'no live state on the socket',
      )
      .toBe(false);
    const asOperate = await socket(page, version, 'operate');
    expect.soft(asOperate.find((m) => m.t === 'bye')?.reason, 'hello operate').toBe('forbidden');

    // Live now: the plan's name and lock count, never slide text.
    const sum = (await call(page, 'GET', '/live/summary')).body as Record<string, unknown>;
    expect(sum.mode).toBe('live');
    expect(sum.lockedPresentationIds).toEqual([a.id]);
    expect.soft(sum, 'the summary has no slide text').not.toHaveProperty('liveLabel');
    expect.soft(JSON.stringify(sum), 'no lyric in the summary').not.toContain('Amazing grace');
  } finally {
    if (ctx !== context) await ctx.close();
    hub.kill();
  }
});

/**
 * Every route declares the lowest cap it accepts (design/28 §3.2, design/21 "Authorisation"), and this table
 * is the list: the single-process hub, the live process and the library process serve exactly these routes
 * with these access roles and caps. A capped session is refused with 403 `cap` on every route above its cap,
 * operate, live and token routes included (the cap is checked before the role), and never on a route at or
 * below it; a route without a cap stops the process at startup, and at run time a missing cap means full.
 */
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/auth.ts';
import { CAP_MESSAGES, capRefusal } from '../src/caps.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type RouteInfo } from '../src/http.ts';
import { startHub, type TestHub } from './helpers.ts';
import { refusal, type TwoProcesses, twoProcesses } from './phones-helpers.ts';

type Row = readonly [method: string, url: string, access: string, cap: 'view' | 'light' | 'full'];

/** The live process's API (routes.ts registerLiveApi), in both process models. */
const LIVE_API: Row[] = [
  ['GET', '/api/v1/auth/me', 'public', 'view'],
  ['GET', '/api/v1/output/config', 'token', 'full'],
  ['GET', '/api/v1/live', 'live', 'full'],
  ['GET', '/api/v1/live/summary', 'edit', 'view'],
  ['GET', '/api/v1/cache/manifest', 'live', 'full'],
  ['POST', '/api/v1/live/events', 'operate', 'full'],
  ['POST', '/api/v1/live/prepare', 'operate', 'full'],
  ['POST', '/api/v1/actions', 'operate', 'full'],
  ['GET', '/api/v1/health', 'public', 'view'],
];

/** The library API (routes.ts registerLibraryApi), in both process models. */
const LIBRARY_API: Row[] = [
  ['POST', '/api/v1/auth/setup', 'public', 'full'],
  ['POST', '/api/v1/auth/pin', 'public', 'view'],
  ['POST', '/api/v1/auth/logout', 'public', 'view'],
  ['PUT', '/api/v1/auth/pins', 'operate', 'full'],
  ['GET', '/api/v1/library/snapshot', 'edit', 'view'],
  ['GET', '/api/v1/presentations', 'edit', 'view'],
  ['GET', '/api/v1/presentations/:id', 'edit', 'view'],
  ['POST', '/api/v1/presentations', 'edit', 'light'],
  ['PUT', '/api/v1/presentations/:id', 'edit', 'light'],
  ['DELETE', '/api/v1/presentations/:id', 'edit', 'full'],
  ['GET', '/api/v1/presentations/:id/revisions', 'edit', 'light'],
  ['GET', '/api/v1/presentations/:id/revisions/:rev', 'edit', 'light'],
  ['POST', '/api/v1/presentations/:id/restore/:rev', 'edit', 'light'],
  ['POST', '/api/v1/presentations/:id/slides/:slideId/make-editable', 'edit', 'full'],
  ['POST', '/api/v1/presentations/:id/pptx-reference', 'edit', 'full'],
  ['GET', '/api/v1/presentations/:id/pptx-reimport', 'edit', 'full'],
  ['POST', '/api/v1/presentations/:id/pptx-reimport', 'edit', 'full'],
  ['GET', '/api/v1/playlists', 'edit', 'view'],
  ['GET', '/api/v1/playlists/:id', 'edit', 'view'],
  ['POST', '/api/v1/playlists', 'edit', 'light'],
  ['PUT', '/api/v1/playlists/:id', 'edit', 'light'],
  ['DELETE', '/api/v1/playlists/:id', 'edit', 'full'],
  ['GET', '/api/v1/themes', 'edit', 'view'],
  ['GET', '/api/v1/themes/:id', 'edit', 'view'],
  ['POST', '/api/v1/themes', 'edit', 'full'],
  ['PUT', '/api/v1/themes/:id', 'edit', 'full'],
  ['DELETE', '/api/v1/themes/:id', 'edit', 'full'],
  ['GET', '/api/v1/themes/:id/revisions', 'edit', 'full'],
  ['GET', '/api/v1/themes/:id/revisions/:rev', 'edit', 'full'],
  ['POST', '/api/v1/themes/:id/restore/:rev', 'edit', 'full'],
  ['GET', '/api/v1/folders', 'edit', 'view'],
  ['POST', '/api/v1/folders', 'edit', 'full'],
  ['PUT', '/api/v1/folders/:id', 'edit', 'full'],
  ['DELETE', '/api/v1/folders/:id', 'edit', 'full'],
  ['GET', '/api/v1/media', 'edit', 'view'],
  ['GET', '/api/v1/media/:id', 'edit', 'view'],
  ['POST', '/api/v1/media', 'edit', 'light'],
  ['PUT', '/api/v1/media/:id', 'edit', 'light'],
  ['DELETE', '/api/v1/media/:id', 'edit', 'full'],
  ['POST', '/api/v1/media/:id/retry', 'edit', 'full'],
  ['PUT', '/api/v1/media/:id/still', 'edit', 'light'],
  ['POST', '/api/v1/media/uploads', 'edit', 'light'],
  ['GET', '/api/v1/media/uploads/:id', 'edit', 'light'],
  ['PATCH', '/api/v1/media/uploads/:id', 'edit', 'light'],
  ['GET', '/api/v1/fonts', 'edit', 'view'],
  ['POST', '/api/v1/fonts/upload', 'edit', 'full'],
  ['DELETE', '/api/v1/fonts/:id', 'edit', 'full'],
  ['GET', '/api/v1/fonts/google/search', 'edit', 'full'],
  ['POST', '/api/v1/fonts/google', 'edit', 'full'],
  ['POST', '/api/v1/import/songselect', 'edit', 'full'],
  ['POST', '/api/v1/import/pro7', 'edit', 'full'],
  ['POST', '/api/v1/import/document', 'edit', 'full'],
  ['GET', '/api/v1/capabilities', 'edit', 'full'],
  ['GET', '/api/v1/jobs', 'edit', 'full'],
  ['GET', '/api/v1/jobs/:id', 'edit', 'full'],
  ['GET', '/api/v1/settings', 'edit', 'view'],
  ['GET', '/api/v1/settings/:key', 'edit', 'view'],
  ['PUT', '/api/v1/settings/:key', 'operate', 'full'],
  ['POST', '/api/v1/outputs/:id/token/rotate', 'operate', 'full'],
  ['GET', '/api/v1/files/:hash', 'any', 'view'],
  ['PUT', '/api/v1/files/slide/:hash', 'edit', 'full'],
  ['GET', '/api/v1/diagnostics/export', 'operate', 'full'],
  ['POST', '/api/v1/backup/run', 'operate', 'full'],
  ['GET', '/api/v1/backup/list', 'operate', 'full'],
];

const API_NOT_FOUND: Row = ['GET,POST,PUT,PATCH,DELETE', '/api/v1/*', 'public', 'view'];
const STATIC: Row = ['GET,HEAD', '/*', 'public', 'view'];

const EXPECTED = {
  hub: [...LIVE_API, ...LIBRARY_API, API_NOT_FOUND, STATIC],
  live: [
    ...LIVE_API,
    ['GET', '/api/v1/files/:hash', 'any', 'view'],
    ['GET', '/internal/diag', 'public', 'full'],
    STATIC,
  ],
  library: [
    ...LIBRARY_API,
    ['GET', '/internal/context', 'public', 'full'],
    ['GET', '/internal/golive/:playlistId', 'public', 'full'],
    API_NOT_FOUND,
  ],
} satisfies Record<string, Row[]>;

/** Fastify adds a HEAD row (same config) for every route with GET and without HEAD. */
function withHead(rows: readonly Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    out.push(r.join(' '));
    const m = r[0].split(',');
    if (m.includes('GET') && !m.includes('HEAD')) out.push(['HEAD', r[1], r[2], r[3]].join(' '));
  }
  return out.sort();
}
const actual = (rs: RouteInfo[]) => rs.map((r) => [r.method, r.url, r.access, r.cap].join(' ')).sort();

describe('route caps: the table', () => {
  let hub: TestHub | undefined;
  let two: TwoProcesses | undefined;
  afterAll(async () => {
    await hub?.cleanup();
    await two?.close();
  });

  it('every route of the single-process hub and of both processes declares the cap in this table', async () => {
    hub = await startHub();
    two = await twoProcesses();
    expect(actual(hub.routes)).toEqual(withHead(EXPECTED.hub));
    expect(actual(two.live.routes)).toEqual(withHead(EXPECTED.live));
    expect(actual(two.lib.routes)).toEqual(withHead(EXPECTED.library));
  });
});

describe('route caps: refusals', () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.cleanup();
  });

  const capped = (cap: 'light' | 'view') =>
    `ordo_session=${hub.auth.createSession('edit', 'phone', false, Date.now(), { cap, pin: 'edit' })}`;

  /** A concrete request for a route: dummy params, an empty JSON body on writes, x-ordo sent. */
  function call(method: string, url: string, cookie: string): Promise<Response> {
    const path = url
      .replace(/:hash/g, '0'.repeat(64))
      .replace(/:[A-Za-z]+/g, 'x')
      .replace(/\*$/, 'nothing-here');
    const write = method !== 'GET' && method !== 'HEAD';
    return fetch(`${hub.url}${path}`, {
      method,
      redirect: 'manual',
      headers: { cookie, 'x-ordo': '1', ...(write ? { 'content-type': 'application/json' } : {}) },
      ...(write ? { body: '{}' } : {}),
    });
  }
  const RANK = { view: 0, light: 1, full: 2 } as const;

  it('refuses a capped session with cap on every route above its cap, and never below', async () => {
    const tried: string[] = [];
    for (const r of hub.routes) {
      for (const method of r.method.split(',')) {
        for (const cap of ['view', 'light'] as const) {
          // Each request gets its own session: a sign-out must not end the next request's.
          const res = await call(method, r.url, capped(cap));
          // A HEAD answer has no body: its status is checked, its GET twin the code.
          const head = method === 'HEAD';
          const body = res.status === 403 && !head ? await refusal(res) : {};
          if (RANK[cap] < RANK[r.cap]) {
            expect({ route: `${method} ${r.url}`, cap, status: res.status, code: body.code }).toEqual({
              route: `${method} ${r.url}`,
              cap,
              status: 403,
              code: head ? undefined : 'cap',
            });
            if (!head) {
              expect(body.need).toBe(r.cap);
              expect(body.message).toBe(CAP_MESSAGES[r.cap as 'light' | 'full']);
            }
          } else expect(body.code, `${method} ${r.url} for ${cap}`).not.toBe('cap');
          tried.push(`${method} ${r.url} ${cap}`);
        }
      }
    }
    expect(tried.length).toBeGreaterThan(200);
  });

  it('a full session is never checked against a cap: an edit session on an operate route is forbidden as before', async () => {
    const full = `ordo_session=${hub.auth.createSession('edit', 'ipad', false)}`;
    const settings = await call('PUT', '/api/v1/settings/:key', full);
    expect(settings.status).toBe(403);
    expect((await refusal(settings)).code).toBe('forbidden');
    // Before P0 a capped (or any edit) session met exactly this: 'forbidden', not 'cap'.
    const phone = await call('PUT', '/api/v1/settings/:key', capped('light'));
    expect(await refusal(phone)).toMatchObject({ code: 'cap', need: 'full' });
    // Before P0 an edit session could delete a presentation (204, measured at d0f49cb).
    const del = await call('DELETE', '/api/v1/presentations/:id', capped('light'));
    expect(del.status).toBe(403);
    expect((await call('DELETE', '/api/v1/presentations/:id', full)).status).toBe(404);
  });

  it('tokens and anonymous callers meet their access role, never a cap', async () => {
    const out = hub.lib.getSetting('outputs')[0]!;
    const res = await fetch(`${hub.url}/api/v1/output/config`, { headers: { 'x-ordo-token': out.token! } });
    expect(res.status).toBe(200);
    const anon = await call('DELETE', '/api/v1/presentations/:id', '');
    expect(anon.status).toBe(401);
  });
});

describe('route caps: fail closed', () => {
  it('a route registered without a cap stops the app; at run time a missing cap means full', async () => {
    const cfg = loadConfig({}, { domain: 'localhost' });
    const { app } = await createHttpApp({ cfg, log: pino({ level: 'silent' }), auth: () => undefined });
    expect(() =>
      app.route({ method: 'GET', url: '/api/v1/new', config: { access: 'edit' }, handler: async () => 1 }),
    ).toThrow(/does not declare a cap/);
    expect(() =>
      app.route({ method: 'GET', url: '/api/v1/old', config: { cap: 'view' }, handler: async () => 1 }),
    ).toThrow(/does not declare an access role/);
    await app.close();
    const phone: Principal = { kind: 'session', role: 'edit', sessionId: 's', cap: 'light' };
    expect(capRefusal(phone, undefined)).toMatchObject({ status: 403, code: 'cap', extra: { need: 'full' } });
    expect(capRefusal(phone, 'light')).toBeUndefined();
    expect(capRefusal({ ...phone, cap: 'view' }, 'light')).toMatchObject({ extra: { need: 'light' } });
    expect(capRefusal({ ...phone, cap: 'full' }, undefined)).toBeUndefined();
    expect(capRefusal(null, 'full')).toBeUndefined();
  });
});

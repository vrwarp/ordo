import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { colourPng, fileFormSlide, heavySlide, presentationBody, uploadColourPngs } from './bakefixtures.ts';
import { opOrigin } from './editorhelpers.ts';
import { fixtures, json, makeService, uploadMedia } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';
import { portOf } from './ports.ts';

/**
 * The bake service in a real browser (design/29 section 1.4, row `bake`): an operator page makes the pictures of
 * heavy slides by itself, one at a time, keeps what the hub already has, never makes one during a service, and does
 * not run at all on a phone, an iPad with a mouse, with `?bake=off` or against a hub with the switch off. The REAL
 * bake worker runs here (the unit tests drive the service with a fake one): a failure of a picture is a finding in
 * the renderer's bake or in the worker's job, never a bound to loosen.
 *
 * One hub with `ORDO_PRERENDER=on` (restarted with `off` in the last test), seeded through its own routes; the
 * operator page is opened with `?test=1&bakeTimings=...` (the waits of test mode: the first sweep does not wait 15 s)
 * and read through `window.__ordo.bake` (C-BW8). The tests run in order and share the hub.
 *   E1 seed and make: three PUTs, 1920 then 3840 then 640, the listing shows all three sizes.
 *   E2 a reload makes nothing again.   E3 an edit makes a new key, once.
 *   E4 nothing during a service; two (shortened) minutes after End service the picture is made.
 *   E5 Go live stops a running picture on the spot.   E6 a phone, an iPad with a mouse and `?bake=off` never bake.
 *   E8 a slide kept in a slide file is made from its full copy and uploaded under the hub's own key.
 *   E7 the hub's switch off: no listing, no PUT.
 */
const PORT = portOf('bake', 0);
const OP = opOrigin(PORT);
const WAITS = 'start:0,settle:500,gap:0,resume:2000,idle:5000';
const QUERY = `test=1&bakeTimings=${WAITS}`;
const SIZES = [640, 1920, 3840];
/** Software canvases at 3840 x 2160 on a CI runner: a picture may take most of a minute. */
const MAKE_MS = 180_000;

type Snap = {
  gate: string;
  hold?: string;
  running?: { presentationId: string; slideId: string; key: string };
  slides: Record<string, { state: string; key?: string; sizes?: number[]; waiting?: string }>;
  workers: number;
  keysByWorker: number;
  sweeps: number;
  requests: { method: string; path: string; status: number }[];
};
type Listing = {
  keys: { slideId: string; key: string; sizes: number[]; madeBy?: string }[];
  failures: { key: string; reason: string }[];
};

let hub: HubProcess;
let api: APIRequestContext;
let imageId: string;
let pid1: string;

const snap = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(
        JSON.stringify((window as unknown as { __ordo?: { bake?: unknown } }).__ordo?.bake ?? null),
      ) as Snap | null,
  );
const listing = async (id: string) =>
  (await (await api.get(`presentations/${id}/prerenders`)).json()) as Listing;
const rowOf = async (id: string, key: string) => (await listing(id)).keys.find((k) => k.key === key);

/** The PUTs of pictures this page sends from now on, as `{ size, key }` in order (the service sends them from the page). */
function watchPuts(page: Page): { size: number; key: string }[] {
  const puts: { size: number; key: string }[] = [];
  page.on('request', (r) => {
    const m = /\/presentations\/[^/]+\/prerenders\/([0-9a-f]{64})\?size=(\d+)/.exec(r.url());
    if (m && r.method() === 'PUT') puts.push({ size: Number(m[2]), key: m[1]! });
  });
  return puts;
}

/** Waits until the page's bake diagnostics satisfy `ok`. */
async function until(page: Page, what: string, ok: (s: Snap) => boolean, timeout = MAKE_MS): Promise<Snap> {
  let last: Snap | null = null;
  await expect
    .poll(
      async () => {
        last = await snap(page);
        return !!last && ok(last);
      },
      { message: what, timeout, intervals: [250] },
    )
    .toBe(true);
  return last as unknown as Snap;
}

async function signIn(page: Page, query = QUERY): Promise<void> {
  await page.goto(`${OP}/?${query}`);
  const pin = page.locator('input.pin');
  const home = page.locator('.shell, nav, main').first();
  await expect(pin.or(home)).toBeVisible({ timeout: 30_000 });
  if (await pin.isVisible()) {
    await pin.fill('246810');
    await page.getByRole('button', { name: 'OK' }).click();
  }
}

/** A desktop operator page in its own context, signed in, watching its PUTs. */
async function operator(browser: Browser, query = QUERY) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const puts = watchPuts(page);
  await signIn(page, query);
  return { context, page, puts };
}

const endService = (a: APIRequestContext) =>
  a.post('live/events', { data: { id: `end-${Date.now()}`, event: { k: 'endService', at: Date.now() } } });

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 800 } });

test.beforeAll(async () => {
  hub = HubProcess.fresh(PORT);
  hub.env.ORDO_FONTS_DIR = process.env.ORDO_FONTS_DIR ?? '/usr/share/fonts';
  hub.env.ORDO_PRERENDER = 'on';
  await hub.start();
  api = await hubApi(PORT);
  imageId = (await uploadMedia(api, fixtures().png, 'image/png')).id;
});

test.afterAll(async () => {
  hub?.kill();
});

test('E1 a heavy slide the hub keys is made by an open operator page: 1920, 3840, 640, nothing else', async ({
  browser,
}) => {
  test.setTimeout(MAKE_MS + 60_000);
  const s1 = heavySlide('s1', { label: 'Welcome one', mediaIds: [imageId] });
  const p = await json<{ id: string }>(
    api.post('presentations', { data: presentationBody('Bake one', [s1]) }),
  );
  pid1 = p.id;
  const before = await listing(pid1);
  expect(before.keys).toHaveLength(1);
  const key = before.keys[0]!.key;
  expect(before.keys[0]!.sizes).toEqual([]);

  const { context, page, puts } = await operator(browser);
  try {
    await until(page, 'the gate is ready', (s) => s.gate === 'ready', 60_000);
    const t0 = Date.now();
    const done = await until(page, 'the slide is ready', (s) => s.slides[`${pid1}/s1`]?.state === 'ready');
    console.log(`E1 picture made and listed after ${Date.now() - t0} ms`);
    expect(done.slides[`${pid1}/s1`]!.key).toBe(key);
    const row = await rowOf(pid1, key);
    expect([...(row?.sizes ?? [])].sort((a, b) => a - b)).toEqual(SIZES);
    expect(row?.madeBy).toMatch(/^operator /);
    // exactly three uploads, in the order 1920, 3840, 640, each to the hub's key
    expect(puts).toEqual([
      { size: 1920, key },
      { size: 3840, key },
      { size: 640, key },
    ]);
    // the service's own request list: a listing before, the three PUTs, a listing after, nothing else (the listing
    // after is read once the state is written: wait for it)
    const after = await until(page, 'the listing is read once more', (q) => q.requests.length >= 5, 30_000);
    expect(after.requests.map((r) => `${r.method} ${r.path.split('/').pop()}`)).toEqual([
      'GET prerenders',
      `PUT ${key}`,
      `PUT ${key}`,
      `PUT ${key}`,
      'GET prerenders',
    ]);
    expect(after.requests.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(done.running).toBeUndefined();
    // the slide has 312 objects: its key was worked out by the keys worker (a broken one would fall back silently)
    expect(done.keysByWorker).toBe(1);
    await expect.poll(async () => (await snap(page))?.workers, { timeout: 60_000 }).toBe(0);
  } finally {
    await context.close();
  }
});

test('E2 a reload makes nothing again: the state is read from the listing and no PUT is sent', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page, puts } = await operator(browser);
  try {
    await until(
      page,
      'ready again from the listing',
      (s) => s.slides[`${pid1}/s1`]?.state === 'ready',
      60_000,
    );
    await page.reload();
    await until(page, 'ready after a reload', (s) => s.slides[`${pid1}/s1`]?.state === 'ready', 60_000);
    await page.waitForTimeout(4_000);
    const s = (await snap(page))!;
    expect(puts).toEqual([]);
    expect(s.workers).toBe(0);
    expect(s.running).toBeUndefined();
  } finally {
    await context.close();
  }
});

test('E3 an edit is a new key, made once; the old key stays on the hub', async ({ browser }) => {
  test.setTimeout(MAKE_MS + 60_000);
  const oldKey = (await listing(pid1)).keys[0]!.key;
  const { context, page, puts } = await operator(browser);
  try {
    await until(page, 'ready before the edit', (s) => s.slides[`${pid1}/s1`]?.state === 'ready', 60_000);
    const full = await json<{ rev: number; sections: { slides: { objects: { box: { x: number } }[] }[] }[] }>(
      api.get(`presentations/${pid1}`),
    );
    full.sections[0]!.slides[0]!.objects[0]!.box.x += 7;
    await json(api.put(`presentations/${pid1}`, { data: full }));
    const fresh = (await listing(pid1)).keys.find((k) => k.key !== oldKey);
    expect(fresh, 'the hub keyed the edited slide').toBeTruthy();
    const done = await until(
      page,
      'the new key is made',
      (s) => s.slides[`${pid1}/s1`]?.key === fresh!.key && s.slides[`${pid1}/s1`]?.state === 'ready',
    );
    expect(done.slides[`${pid1}/s1`]!.sizes?.slice().sort((a, b) => a - b)).toEqual(SIZES);
    expect(puts.map((p) => p.size)).toEqual([1920, 3840, 640]);
    expect(puts.every((p) => p.key === fresh!.key)).toBe(true);
    const old = await rowOf(pid1, oldKey);
    expect([...(old?.sizes ?? [])].sort((a, b) => a - b)).toEqual(SIZES);
  } finally {
    await context.close();
  }
});

test('E4 never during a service: nothing is made, the hub refuses a picture, and the picture comes after End service', async ({
  browser,
}) => {
  test.setTimeout(MAKE_MS + 90_000);
  const { playlistId } = await makeService(api);
  const { context, page, puts } = await operator(browser);
  try {
    await until(page, 'gate ready', (s) => s.gate === 'ready', 60_000);
    // a service is live before the second heavy slide exists, so no sweep can slip in between
    await json(
      api.post('live/events', { data: { id: `gl-${Date.now()}`, event: { k: 'goLive', playlistId } } }),
    );
    await until(page, 'the hold is "service"', (s) => s.hold === 'service', 30_000);
    const s2 = heavySlide('s2', { label: 'Second slide', mediaIds: [imageId] });
    const p = await json<{ id: string }>(
      api.post('presentations', { data: presentationBody('Bake two', [s2]) }),
    );
    const pid2 = p.id;
    const key2 = (await listing(pid2)).keys[0]!.key;
    await page.waitForTimeout(4_000);
    const live = (await snap(page))!;
    expect(live.hold).toBe('service');
    expect(live.workers).toBe(0);
    expect(live.running).toBeUndefined();
    expect(puts).toEqual([]);
    // the hub refuses a picture for the key too, even from the operator's own session
    const refused = await api.put(`presentations/${pid2}/prerenders/${key2}?size=1920&madeBy=spec`, {
      data: colourPng(10, 20, 30),
      headers: { 'content-type': 'image/png' },
    });
    expect(refused.status()).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('paused_during_service');
    // End service: the computers wait (shortened here), then the picture is made
    await endService(api);
    await until(page, 'the hold is "resume-wait"', (s) => s.hold === 'resume-wait', 10_000);
    expect(puts).toEqual([]);
    const done = await until(
      page,
      'the second slide is made',
      (s) => s.slides[`${pid2}/s2`]?.state === 'ready',
    );
    expect(done.slides[`${pid2}/s2`]!.key).toBe(key2);
    expect(puts.map((q) => q.size)).toEqual([1920, 3840, 640]);
  } finally {
    await endService(api).catch(() => undefined);
    await context.close();
  }
});

test('E5 Go live stops a picture that is being made, on the spot, and nothing is uploaded for its key', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const media = await uploadColourPngs(api, 100);
  const { playlistId } = await makeService(api);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // every file read is slow, the worker's included (a context route reaches a worker's fetches), so that the
  // picture lasts long enough for the press of Go live to land in it
  await context.route('**/api/v1/files/*', async (route) => {
    await new Promise((r) => setTimeout(r, 1000));
    await route.continue();
  });
  const page = await context.newPage();
  const puts = watchPuts(page);
  try {
    await signIn(page);
    await until(page, 'gate ready', (s) => s.gate === 'ready', 60_000);
    const s5 = heavySlide('s5', { label: 'Slow slide', mediaIds: media, images: 100 });
    const p = await json<{ id: string }>(
      api.post('presentations', { data: presentationBody('Bake five', [s5]) }),
    );
    const key5 = (await listing(p.id)).keys[0]!.key;
    await until(page, 'a picture is being made', (s) => !!s.running && s.running.key === key5, 120_000);
    const t0 = Date.now();
    await page.evaluate(
      (id) => (window as unknown as { __ordo: { ctl: { goLive(id: string): void } } }).__ordo.ctl.goLive(id),
      playlistId,
    );
    await until(page, 'the picture stopped', (s) => !s.running && s.workers === 0, 500);
    console.log(`E5 picture stopped ${Date.now() - t0} ms after the press of Go live`);
    expect((await snap(page))!.hold).toMatch(/^(go-live|service)$/);
    await page.waitForTimeout(3_000);
    expect(puts).toEqual([]);
    expect((await rowOf(p.id, key5))?.sizes).toEqual([]);
  } finally {
    await endService(api).catch(() => undefined);
    await context.close();
  }
});

test('E6 a phone, an iPad with a mouse and ?bake=off never bake: gate "unsupported", no worker, no PUT', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // a picture that is missing, so that anything that could bake would
  const s6 = heavySlide('s6', { label: 'Never made here', mediaIds: [imageId] });
  const p = await json<{ id: string }>(
    api.post('presentations', { data: presentationBody('Bake six', [s6]) }),
  );
  const key6 = (await listing(p.id)).keys[0]!.key;

  const sees = async (context: BrowserContext, query = QUERY) => {
    const page = await context.newPage();
    const puts = watchPuts(page);
    await signIn(page, query);
    return { page, puts };
  };
  const quiet = async (page: Page, puts: unknown[], gate: string) => {
    await expect.poll(async () => (await snap(page))?.gate, { timeout: 30_000 }).toBe(gate);
    await page.waitForTimeout(4_000);
    const s = (await snap(page))!;
    expect(s.workers).toBe(0);
    expect(s.running).toBeUndefined();
    expect(puts).toEqual([]);
  };

  // Android Chrome (e2e/touchdevice.ts): a coarse pointer, no WebHID, no Window Management, a phone's screen
  const { defaultBrowserType: _b, ...pixel } = devices['Pixel 5']!;
  const phone = await browser.newContext({
    ...pixel,
    viewport: { width: 360, height: 800 },
    screen: { width: 360, height: 800 },
  });
  await phone.addInitScript(() => {
    delete (Navigator.prototype as { hid?: unknown }).hid;
    delete (window as { getScreenDetails?: unknown }).getScreenDetails;
    delete (Window.prototype as { getScreenDetails?: unknown }).getScreenDetails;
  });
  try {
    const { page, puts } = await sees(phone);
    await quiet(page, puts, 'unsupported');
  } finally {
    await phone.close();
  }

  // an iPad with a mouse: a fine pointer, the regular layout, but none of the Chromium-only APIs the baker asks for
  const ipad = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await ipad.addInitScript(() => {
    delete (Navigator.prototype as { userAgentData?: unknown }).userAgentData;
    delete (Navigator.prototype as { hid?: unknown }).hid;
    delete (window as { getScreenDetails?: unknown }).getScreenDetails;
    delete (Window.prototype as { getScreenDetails?: unknown }).getScreenDetails;
  });
  try {
    const { page, puts } = await sees(ipad);
    await quiet(page, puts, 'unsupported');
  } finally {
    await ipad.close();
  }

  // a desktop forced off by the support switch
  const forced = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const { page, puts } = await sees(forced, `${QUERY}&bake=off`);
    await quiet(page, puts, 'unsupported');
  } finally {
    await forced.close();
  }
  expect((await rowOf(p.id, key6))?.sizes).toEqual([]);
});

test("E8 a slide kept in a slide file is made from its full copy and uploaded under the hub's own key", async ({
  browser,
}) => {
  test.setTimeout(MAKE_MS + 90_000);
  const { slide } = await fileFormSlide(api, 's8', 1357);
  const p = await json<{ id: string }>(
    api.post('presentations', { data: presentationBody('Bake eight', [slide]) }),
  );
  const listed = (await listing(p.id)).keys;
  expect(listed).toHaveLength(1);
  const key8 = listed[0]!.key;
  expect(listed[0]!.sizes).toEqual([]);
  const { context, page, puts } = await operator(browser);
  try {
    const t0 = Date.now();
    const done = await until(
      page,
      'the file-form slide is made',
      (s) => s.slides[`${p.id}/s8`]?.state === 'ready',
    );
    console.log(`E8 file-form picture (1,357 shapes) made and listed after ${Date.now() - t0} ms`);
    expect(done.slides[`${p.id}/s8`]!.key).toBe(key8);
    expect(puts).toEqual([
      { size: 1920, key: key8 },
      { size: 3840, key: key8 },
      { size: 640, key: key8 },
    ]);
    const row = await rowOf(p.id, key8);
    expect([...(row?.sizes ?? [])].sort((a, b) => a - b)).toEqual(SIZES);
    expect((await listing(p.id)).failures).toEqual([]);
  } finally {
    await context.close();
  }
});

test('E7 the hub\'s switch off: gate "off", no listing, no PUT, and a direct PUT answers 503 prerender_off', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  hub.kill();
  hub.env.ORDO_PRERENDER = 'off';
  await hub.start();
  api = await hubApi(PORT);
  const key = (await listing(pid1)).keys[0]!.key;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const puts = watchPuts(page);
  const listings: string[] = [];
  page.on('request', (r) => {
    if (/\/prerenders(\?|$)/.test(r.url())) listings.push(`${r.method()} ${r.url()}`);
  });
  try {
    await signIn(page);
    await expect.poll(async () => (await snap(page))?.gate, { timeout: 30_000 }).toBe('off');
    await page.waitForTimeout(4_000);
    expect((await snap(page))!.workers).toBe(0);
    expect(puts).toEqual([]);
    expect(listings).toEqual([]);
    const refused = await api.put(`presentations/${pid1}/prerenders/${key}?size=640&madeBy=spec`, {
      data: colourPng(1, 2, 3),
      headers: { 'content-type': 'image/png' },
    });
    expect(refused.status()).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('prerender_off');
  } finally {
    await context.close();
  }
});

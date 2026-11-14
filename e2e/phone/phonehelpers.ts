import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  request,
  test,
} from '@playwright/test';
import { HubProcess } from '../hubproc.ts';
import { auditTargets, COMPACT_SELECTOR } from '../touchaudit.ts';
import { touchDevice } from '../touchdevice.ts';

/**
 * Phones (design/28 §8): the webkit-iphone (WebKit, iPhone 13, 390x844) and chromium-android (Chromium with
 * touch, Pixel 5 at 360x800, Android Chrome modelled by e2e/touchdevice.ts) projects run e2e/phone/*.spec.ts.
 * Path mode (`http://localhost:<port>/`), each spec on its own hub: a spec takes its ports from its own row of
 * the port table (e2e/ports.ts) and passes them here.
 */
export const PIN = '246810';
/** The edit PIN the hub derives from ORDO_DEV_PIN=246810: the operate PIN reversed (auth.ts). */
export const EDIT_PIN = '018642';

/** This project's index in a phone row: 0 webkit-iphone, 1 chromium-android. */
export function phoneSlot(): number {
  return test.info().project.name === 'chromium-android' ? 1 : 0;
}

/** A fresh hub on `port`, with an operate API context signed in (sending x-ordo, as every ordo client does). */
export async function startPhoneHub(
  port: number,
): Promise<{ hub: HubProcess; api: APIRequestContext; url: string }> {
  const hub = HubProcess.fresh(port);
  await hub.start();
  const api = await request.newContext({
    baseURL: `http://localhost:${port}/api/v1/`,
    extraHTTPHeaders: { 'x-ordo': '1' },
  });
  const r = await api.post('auth/pin', { data: { pin: PIN } });
  expect(r.ok(), await r.text()).toBe(true);
  return { hub, api, url: `http://localhost:${port}/` };
}

/**
 * Sign in by tapping the keypad, as on a phone: models Android Chrome first (touchDevice), opens `url`, taps
 * the PIN and OK, then waits until the keypad is gone and the app's page shows (today's frame and the
 * compact shell's both have `.page`).
 */
export async function signInPhone(page: Page, url: string, pin = PIN): Promise<void> {
  await touchDevice(page);
  await page.goto(url);
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).tap();
  await page.getByRole('button', { name: 'OK' }).tap();
  await expect(page.locator('.keypad')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.page')).toBeVisible({ timeout: 20_000 });
}

/**
 * The compact layout's layout checks on the page as it is now (design/28 §8 "Layout", principle 3: every
 * compact control at least 44x44, no horizontal scroll, `.page` the one scroller). The problems found, empty
 * when the page passes:
 * - the document and `.page` are no wider than the viewport, and the document does not scroll;
 * - every visible control under `root` (the iPad audit's controls plus links, `role="button"` and checkbox
 *   labels, e2e/touchaudit.ts `COMPACT_SELECTOR`) is inside the viewport (vertically too, unless a scroller
 *   holds it) and at least 44x44, with no exceptions;
 * - the Live now strip (when shown), the compact header and the tab bar (when shown) are inside the visual
 *   viewport, and the tab bar's bottom is the viewport's;
 * - every scrollable pane's `scrollLeft` is 0, and stays 0 after each field under `root` is focused (main's
 *   autofocused search panned the Library by 58 px at 390 and 100 px at 360).
 * `root` is `#root` for a screen (all of the above); `.dialog.sheet` for an open sheet checks the sheet's
 * controls and every pane's scroll, not the screen behind it.
 */
export async function layoutChecks(
  page: Page,
  where: string,
  opts: { root?: string; focusFields?: boolean } = {},
): Promise<string[]> {
  const root = opts.root ?? '#root';
  // A sheet slides in: measure where it settles (finite animations under the root, at most 2 s).
  await page.evaluate(
    (root) =>
      Promise.race([
        Promise.all(
          [...document.querySelectorAll(root)].flatMap((el) =>
            el
              .getAnimations({ subtree: true })
              .filter((a) => Number.isFinite(Number(a.effect?.getTiming().iterations ?? 1)))
              .map((a) => a.finished.catch(() => undefined)),
          ),
        ),
        new Promise((r) => setTimeout(r, 2000)),
      ]),
    root,
  );
  const problems = await page.evaluate(
    ({ where, root, sel }) => {
      const out: string[] = [];
      const iw = window.innerWidth;
      const ih = window.innerHeight;
      const de = document.documentElement;
      const screen = root === '#root';
      if (de.scrollWidth > iw) out.push(`${where}: document scrollWidth ${de.scrollWidth} > ${iw}`);
      if (de.scrollHeight > ih + 1) out.push(`${where}: document scrollHeight ${de.scrollHeight} > ${ih}`);
      if (screen)
        for (const p of document.querySelectorAll<HTMLElement>('.page'))
          if (p.scrollWidth > iw || p.scrollWidth > p.clientWidth + 1)
            out.push(
              `${where}: .page scrollWidth ${p.scrollWidth} (client ${p.clientWidth}, viewport ${iw})`,
            );
      const scrolls = (el: Element) => {
        const cs = getComputedStyle(el);
        return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      };
      const held = (el: Element) => {
        for (let a = el.parentElement; a; a = a.parentElement) if (scrolls(a)) return true;
        return false;
      };
      const label = (el: Element) =>
        `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}"`;
      for (const scope of document.querySelectorAll(root))
        for (const el of scope.querySelectorAll<HTMLElement>(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
          if (r.left < -0.5 || r.right > iw + 0.5)
            out.push(
              `${where}: ${label(el)} outside the viewport (x ${Math.round(r.left)}..${Math.round(r.right)})`,
            );
          else if ((r.top < -0.5 || r.bottom > ih + 0.5) && !held(el))
            out.push(
              `${where}: ${label(el)} outside the viewport (y ${Math.round(r.top)}..${Math.round(r.bottom)})`,
            );
        }
      const vv = window.visualViewport;
      const inVisual = (name: string, el: Element | null, required: boolean) => {
        if (!el) {
          if (required) out.push(`${where}: no ${name}`);
          return;
        }
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const top = vv?.offsetTop ?? 0;
        const left = vv?.offsetLeft ?? 0;
        const h = vv?.height ?? ih;
        const w = vv?.width ?? iw;
        if (r.top < top - 0.5 || r.bottom > top + h + 0.5 || r.left < left - 0.5 || r.right > left + w + 0.5)
          out.push(
            `${where}: ${name} outside the visual viewport (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(w)}x${Math.round(h)})`,
          );
      };
      if (!screen) return out;
      inVisual('[data-live-strip]', document.querySelector('[data-live-strip]'), false);
      inVisual('the compact header', document.querySelector('[data-compact-header]'), false);
      const bar = document.querySelector('nav.tabbar');
      inVisual('nav.tabbar', bar, false);
      if (bar) {
        const b = bar.getBoundingClientRect().bottom;
        if (Math.abs(b - ih) > 1) out.push(`${where}: nav.tabbar bottom ${Math.round(b)} != ${ih}`);
      }
      return out;
    },
    { where, root, sel: COMPACT_SELECTOR },
  );
  for (const m of await auditTargets(page, where, root, [], COMPACT_SELECTOR))
    problems.push(`${m.where}: ${m.what} is ${m.w}x${m.h}, under 44x44`);
  problems.push(...(await scrolledPanes(page, where)));
  if (opts.focusFields !== false) {
    const fields = await page.locator(`${root} :is(input, textarea, select):visible`).all();
    for (const [i, f] of fields.entries()) {
      await f.evaluate((el) => (el as HTMLElement).focus());
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
      problems.push(...(await scrolledPanes(page, `${where} (field ${i + 1} focused)`)));
      await f.evaluate((el) => (el as HTMLElement).blur());
    }
  }
  return problems;
}

/** Every element (and the window) scrolled sideways. */
async function scrolledPanes(page: Page, where: string): Promise<string[]> {
  return page.evaluate((where) => {
    const out: string[] = [];
    if (window.scrollX !== 0) out.push(`${where}: window scrollX ${window.scrollX}`);
    for (const el of document.querySelectorAll<HTMLElement>('*'))
      if (el.scrollLeft !== 0)
        out.push(
          `${where}: ${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} scrollLeft ${el.scrollLeft}`,
        );
    return out;
  }, where);
}

/**
 * Every POST /auth/pin body the page sends, parsed, in order (design/28 §3.2: a phone asks for `cap: 'light'`
 * from a hub that grants it and never sends `remember`). Install before the first navigation.
 */
export function pinBodies(page: Page): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().endsWith('/api/v1/auth/pin')) return;
    try {
      bodies.push(JSON.parse(r.postData() ?? '{}') as Record<string, unknown>);
    } catch {
      bodies.push({});
    }
  });
  return bodies;
}

/**
 * The page's session is a phone's capped one (design/28 §3.2 "Never remembered", composed plan §2 B and C): no
 * device cookie, a session cookie that ends within an hour (the sliding TTL; 60 s of slack for the clocks), and
 * GET /auth/me answering role 'edit' with cap 'light'.
 */
export async function expectCappedSession(page: Page, where = 'after the sign-in'): Promise<void> {
  const cookies = await page.context().cookies();
  expect(
    cookies.find((c) => c.name === 'ordo_device'),
    `${where}: no ordo_device cookie`,
  ).toBeUndefined();
  const session = cookies.find((c) => c.name === 'ordo_session');
  expect(session, `${where}: an ordo_session cookie`).toBeDefined();
  const left = session!.expires - Date.now() / 1000;
  expect(left, `${where}: ordo_session ends within an hour`).toBeGreaterThan(0);
  expect(left, `${where}: ordo_session ends within an hour`).toBeLessThanOrEqual(3600 + 60);
  const me = await page.evaluate(() => fetch('/api/v1/auth/me').then((r) => r.json()));
  expect(me, `${where}: GET /auth/me`).toMatchObject({ role: 'edit', cap: 'light' });
}

/** One refusal the hub answered (watchRefusals). */
export type Refusal = { method: string; path: string; status: number; code?: string };

/** The refusals of design/28 §4 that a P0 compact screen must never meet (composed plan §2 E). */
const REFUSAL_CODES = new Set(['cap', 'x_ordo_required', 'origin']);

/**
 * Every /api/ answer in `target`'s browser context (its pages, their workers and service worker) that is a
 * refusal of the phone's cap or of the write checks: 403 with code `cap`, `x_ordo_required` or `origin` (a 403
 * whose body cannot be read is listed with code `unread`), or 429. The P0 compact screens call no route above
 * `light` and write nothing, so a spec expects none (the lockout test excepted). Call the returned function to
 * read the list once the answers are in.
 */
export function watchRefusals(target: Page | BrowserContext): () => Promise<Refusal[]> {
  const ctx: BrowserContext = 'goto' in target ? target.context() : target;
  const found: Refusal[] = [];
  const pending: Promise<unknown>[] = [];
  ctx.on('response', (r) => {
    let path: string;
    try {
      path = new URL(r.url()).pathname;
    } catch {
      return;
    }
    if (!path.startsWith('/api/')) return;
    const status = r.status();
    const base = { method: r.request().method(), path, status };
    if (status === 429) found.push(base);
    else if (status === 403)
      pending.push(
        r.json().then(
          (b) => {
            const code = (b as { error?: { code?: unknown } } | null)?.error?.code;
            if (typeof code === 'string' && REFUSAL_CODES.has(code)) found.push({ ...base, code });
          },
          () => found.push({ ...base, code: 'unread' }),
        ),
      );
  });
  return async () => {
    await Promise.all(pending);
    return [...found];
  };
}

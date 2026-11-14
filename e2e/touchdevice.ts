import { type BrowserContext, type Page, test } from '@playwright/test';

/**
 * Android Chrome in the Chromium projects (chromium-android, chromium-tablet; design/23 "Projects", design/28
 * §8). Desktop Chromium has WebHID and the Window Management API, which Android Chrome lacks, so a Pixel or
 * Galaxy Tab descriptor alone would detect the venue PC's full profile (lib/capabilities.ts tests `key in
 * obj`). An init script, once per browser context, removes both before the page's scripts run:
 * `Navigator.prototype.hid`, and `getScreenDetails` from the global (Window is a [Global] interface, so the
 * operation is an own property of `window`; measured on Chromium 1243) and from `Window.prototype` should an
 * engine put it there. The page then detects the edit profile as Android Chrome does, and a forced
 * `?profile=full` meets the forced-profile guard. A no-op in WebKit (no such APIs) and in a project without
 * touch (the venue PC). Call it before the context's first navigation.
 */
const modelled = new WeakSet<BrowserContext>();

export async function touchDevice(page: Page): Promise<void> {
  const ctx = page.context();
  if (modelled.has(ctx)) return;
  modelled.add(ctx);
  if (ctx.browser()?.browserType().name() !== 'chromium') return;
  let touch = true;
  try {
    touch = test.info().project.use.hasTouch === true;
  } catch {
    /* outside a test: model it */
  }
  if (!touch) return;
  await ctx.addInitScript(() => {
    delete (Navigator.prototype as { hid?: unknown }).hid;
    delete (window as { getScreenDetails?: unknown }).getScreenDetails;
    delete (Window.prototype as { getScreenDetails?: unknown }).getScreenDetails;
  });
}

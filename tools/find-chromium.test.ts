import { describe, expect, it } from 'vitest';
import { findChromium, underCi } from './find-chromium.ts';

const has =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);
const pw = (p?: string) => async () => p;

describe('findChromium (design/23 "CI")', () => {
  it("takes Playwright's Chromium first, then ORDO_TEST_CHROMIUM", async () => {
    const env = { ORDO_TEST_CHROMIUM: '/opt/chrome' };
    expect(
      await findChromium({ env, playwright: pw('/pw/chrome'), exists: has('/pw/chrome', '/opt/chrome') }),
    ).toBe('/pw/chrome');
    // Playwright's is not installed (its path does not exist, or the package is missing).
    expect(await findChromium({ env, playwright: pw('/pw/chrome'), exists: has('/opt/chrome') })).toBe(
      '/opt/chrome',
    );
    expect(await findChromium({ env, playwright: pw(undefined), exists: has('/opt/chrome') })).toBe(
      '/opt/chrome',
    );
  });

  it('a test run skips without a browser, but CI fails instead of skipping', async () => {
    const none = { playwright: pw(undefined), exists: has('/usr/bin/google-chrome') };
    expect(await findChromium({ env: {}, ...none })).toBeUndefined();
    await expect(findChromium({ env: { CI: 'true' }, ...none })).rejects.toThrow(/no Chromium/);
    await expect(findChromium({ env: { ORDO_CI: '1' }, ...none })).rejects.toThrow(
      /playwright install chromium/,
    );
    // An ORDO_TEST_CHROMIUM that does not exist is no browser either.
    await expect(findChromium({ env: { CI: '1', ORDO_TEST_CHROMIUM: '/gone' }, ...none })).rejects.toThrow();
    expect(underCi({})).toBe(false);
    expect(underCi({ ORDO_CI: '1' })).toBe(true);
  });

  it('the CLI tools take ORDO_CHROMIUM first and fall back to the system Chromium or Chrome', async () => {
    const exists = has('/pw/chrome', '/custom/chrome', '/usr/bin/google-chrome');
    expect(
      await findChromium({
        system: true,
        env: { ORDO_CHROMIUM: '/custom/chrome' },
        playwright: pw('/pw/chrome'),
        exists,
      }),
    ).toBe('/custom/chrome');
    expect(await findChromium({ system: true, env: {}, playwright: pw('/pw/chrome'), exists })).toBe(
      '/pw/chrome',
    );
    expect(await findChromium({ system: true, env: {}, playwright: pw(undefined), exists })).toBe(
      '/usr/bin/google-chrome',
    );
    // Tests never fall back to a system browser.
    expect(await findChromium({ env: {}, playwright: pw(undefined), exists })).toBeUndefined();
  });
});

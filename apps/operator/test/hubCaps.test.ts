/**
 * The hub's capabilities as the operator reads them (design/27 M9, `lib/hubCaps.ts`): whatever a hub of
 * another version sends parses, a hub before M9 (404) is one with LibreOffice, and a network error keeps
 * what was known.
 */
import { ApiFailure } from '@ordo/client';
import { type HubCapabilities, LEGACY_CAPABILITIES } from '@ordo/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadHubCaps, parseHubCaps, useHubCapsStore } from '../src/lib/hubCaps.ts';

const LITE: HubCapabilities = {
  libreoffice: { state: 'absent' },
  pdf: true,
  documents: ['pptx', 'ppsx', 'potx', 'pptm', 'pdf'],
  pptx: { pictures: false, reference: false, referencePdf: true, art: false },
};

beforeEach(() => useHubCapsStore.setState({ caps: undefined, at: undefined }));

describe('the hub capabilities (design/27 M9)', () => {
  it('unknown fields and bad values parse with .catch defaults', () => {
    expect(parseHubCaps(LITE)).toEqual(LITE);
    expect(
      parseHubCaps({
        libreoffice: { state: 'rebooting', version: 7 },
        pdf: 'yes',
        documents: 'pptx',
        pptx: { pictures: 1, reference: true, art: 'no' },
        future: { anything: true },
      }),
    ).toEqual({
      libreoffice: { state: 'absent' },
      pdf: false,
      documents: ['pptx', 'pdf'],
      pptx: { pictures: false, reference: true, referencePdf: false, art: false },
    });
    expect(
      parseHubCaps({ libreoffice: { state: 'available', version: 'x'.repeat(200) } }).libreoffice,
    ).toEqual({ state: 'available' });
    for (const bad of [null, 'text', 42, [], undefined])
      expect(parseHubCaps(bad)).toEqual({
        libreoffice: { state: 'absent' },
        pdf: false,
        documents: ['pptx', 'pdf'],
        pptx: { pictures: false, reference: false, referencePdf: false, art: false },
      });
  });

  it('404 means a hub before M9', async () => {
    const caps = await loadHubCaps({
      get: () => Promise.reject(new ApiFailure(404, 'not_found', 'Not found')),
    });
    expect(caps).toEqual(LEGACY_CAPABILITIES);
    expect(LEGACY_CAPABILITIES.pptx).toMatchObject({ pictures: true, reference: true, art: true });
    expect(useHubCapsStore.getState().caps).toEqual(LEGACY_CAPABILITIES);
  });

  it('keeps the last answer on a network error, reuses a fresh one and asks again when forced', async () => {
    let t = 1_000_000;
    let calls = 0;
    const get = async () => {
      calls++;
      return LITE;
    };
    expect(await loadHubCaps({ get, now: () => t })).toEqual(LITE);
    expect(calls).toBe(1);
    // Fresh: not asked again; a reconnect (force) asks.
    t += 1_000;
    await loadHubCaps({ get, now: () => t });
    expect(calls).toBe(1);
    await loadHubCaps({ get, now: () => t }, true);
    expect(calls).toBe(2);
    // The hub unreachable, or answering 500: the last answer stays.
    t += 60_000;
    expect(
      await loadHubCaps({ get: () => Promise.reject(new TypeError('fetch failed')), now: () => t }),
    ).toEqual(LITE);
    expect(
      await loadHubCaps(
        { get: () => Promise.reject(new ApiFailure(500, 'http_500', 'x')), now: () => t },
        true,
      ),
    ).toEqual(LITE);
    expect(useHubCapsStore.getState().caps).toEqual(LITE);
    // Two screens asking at once share one request.
    let n = 0;
    const slow = () => new Promise<unknown>((r) => setTimeout(() => r({ ...LITE, pdf: ++n > 0 }), 10));
    const [a, b] = await Promise.all([
      loadHubCaps({ get: slow, now: () => t }, true),
      loadHubCaps({ get: slow, now: () => t }, true),
    ]);
    expect(n).toBe(1);
    expect(a).toEqual(b);
  });

  it('asks again soon while the hub is still checking LibreOffice', async () => {
    const t = 5_000_000;
    let calls = 0;
    const get = async () => {
      calls++;
      return { ...LITE, libreoffice: { state: 'checking' } };
    };
    await loadHubCaps({ get, now: () => t });
    expect(useHubCapsStore.getState().caps?.libreoffice.state).toBe('checking');
    await loadHubCaps({ get, now: () => t + 4_000 });
    expect(calls).toBe(2);
  });
});

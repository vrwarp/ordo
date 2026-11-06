import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, api } from './api.ts';

function answer(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

async function failure(path = '/presentations/p'): Promise<ApiFailure> {
  try {
    await api(path, { method: 'PUT', json: {} });
  } catch (e) {
    if (e instanceof ApiFailure) return e;
    throw e;
  }
  throw new Error('the request did not fail');
}

afterEach(() => vi.unstubAllGlobals());

describe('ApiFailure', () => {
  it("keeps the error body's other fields: a 409 save carries the version that won (design/27 §11 item 17)", async () => {
    const current = { id: 'p', rev: 7, title: 'Sunday' };
    answer(409, { error: { code: 'conflict', message: 'Changed since you opened it', rev: 7, current } });
    const e = await failure();
    expect(e.status).toBe(409);
    expect(e.code).toBe('conflict');
    expect(e.message).toBe('Changed since you opened it');
    expect(e.details).toEqual({ rev: 7, current });
  });

  it('has no details when the body has only a code and a message, or is not JSON', async () => {
    answer(423, { error: { code: 'locked', message: 'Locked while live' } });
    expect((await failure()).details).toBeUndefined();
    answer(502, 'Bad gateway');
    const e = await failure();
    expect(e.code).toBe('http_502');
    expect(e.details).toBeUndefined();
    answer(500, { unexpected: true });
    expect((await failure()).code).toBe('http_500');
  });
});

import { describe, expect, it } from 'vitest';
import { HUB_ONLY_EVENTS, LiveCommandSchema, LiveEventSchema, parseClientMessage } from './index.ts';

/*
 * design/29 §1.11: `prerender.add` is applied by the hub only (for an accepted upload of a key of the live
 * service), so no client's `live.event` may carry it; `prerender.use` is an operator's command.
 */
const add = {
  k: 'prerender.add',
  presentationId: 'p',
  slideId: 's',
  key: 'a'.repeat(64),
  size: 3840,
  file: 'b'.repeat(64),
};

describe('pre-render messages (design/29 §1.11)', () => {
  it("refuses a client's live.event carrying prerender.add", () => {
    const r = parseClientMessage(JSON.stringify({ t: 'live.event', v: 1, id: 'x', event: add }));
    expect('error' in r).toBe(true);
    expect(LiveCommandSchema.safeParse(add).success).toBe(false);
    // The hub's delta carries it to every client.
    expect(LiveEventSchema.safeParse(add).success).toBe(true);
    expect(HUB_ONLY_EVENTS).toEqual(['prerender.add']);
  });

  it("takes the operator's prerender.use", () => {
    const use = { k: 'prerender.use', presentationId: 'p', slideId: 's' };
    const r = parseClientMessage(JSON.stringify({ t: 'live.event', v: 1, id: 'x', event: use }));
    expect('error' in r).toBe(false);
    expect(LiveEventSchema.safeParse({ ...use, extra: 1 }).success).toBe(false);
  });
});

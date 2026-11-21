/**
 * Events only the hub makes (`HUB_ONLY_EVENTS`, packages/protocol): the live loop applies them, a client never sends
 * them (POST /live/events and a socket refuse `prerender.add`). Shared by the one-process hub and the live process.
 */
import { LiveEvent } from '@ordo/domain';
import { slideFor } from '@ordo/live-state';
import type { Logger } from 'pino';
import type { LiveService } from './live.ts';

/**
 * Apply a `prerender.add` the library announced (design/29 §1.7): a picture of a key of the running service. The
 * reducer ignores a key that is not in the service's `prerenderKeys` or a slide it does not have, but every event
 * costs a seq, so both are checked here first: a stray or stale message applies nothing and moves nothing.
 * Returns the seq it took, or undefined when it applied nothing. A write that fails (the data folder's disk is full)
 * applies nothing either, and raises nothing: the live process calls this from the supervisor's message handler, where
 * an exception ends the process in the middle of a service (the picture stays in the library; the service draws the
 * slide live, as it would without the picture).
 */
export function applyHubEvent(
  live: LiveService,
  raw: unknown,
  log?: Pick<Logger, 'warn'>,
): number | undefined {
  const parsed = LiveEvent.safeParse(raw);
  if (!parsed.success || parsed.data.k !== 'prerender.add') return undefined;
  const e = parsed.data;
  const s = live.state;
  if (s.mode !== 'live' || !s.resolved?.prerenderKeys?.includes(e.key)) return undefined;
  if (!slideFor(s, e.presentationId, e.slideId)) return undefined;
  try {
    return live.apply(e);
  } catch (err) {
    log?.warn(
      { err: (err as Error).message },
      'a picture of the running service could not be journalled; the service goes on without it',
    );
    return undefined;
  }
}

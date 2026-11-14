/**
 * Request context the hub carries through a request's continuations (design/28 P0).
 *
 * `pacedScope`: true while a capped session's request runs (routes.ts `routeFn` runs the handler inside it), so
 * a heavy job queued anywhere down that request (an upload's transcode, a PowerPoint follow-up a save queues) is
 * held while a service is live (design/28 §10 items 8 and 11). The job queue runs each job's handler in its own
 * job's scope, so a pump started inside a capped request never marks another session's jobs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const pacedScope = new AsyncLocalStorage<boolean>();

/** Is the current continuation part of a capped request (or of a job one queued)? */
export function inPacedScope(): boolean {
  return pacedScope.getStore() === true;
}

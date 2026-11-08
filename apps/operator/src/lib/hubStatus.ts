import type { Authority, Reconcile } from './liveCore.ts';

/** The slice of the live store the hub status line and the sign-in overlay read. */
export type HubStatusInput = {
  authority: Authority;
  reconcile: Reconcile;
  hubConnected: boolean;
  everConnected: boolean;
  hubRefused?: 'unauthorized' | 'forbidden';
  /** This PC started the service without the hub and keeps it to End service. */
  held?: boolean;
};

export type HubStatus = {
  text: string;
  dot: 'green' | 'amber' | 'red';
  /** The operator is the fallback authority (the outputs run from this PC). */
  fallback: boolean;
  /** The hub refused this operator's session and it is not connected. */
  refused: boolean;
};

/**
 * The top bar's hub line (design/15 "Session expiry"). The authority comes first: while this PC runs the
 * outputs, a session refusal must not read as "outputs stay on the hub" (they do not), and the hand-back
 * phases keep their wording because they are what the volunteer waits for after signing in.
 */
export function hubStatus(l: HubStatusInput): HubStatus {
  const fallback = l.authority === 'fallback';
  const refused = !!l.hubRefused && !l.hubConnected;
  const dot = fallback || refused ? 'amber' : l.hubConnected ? 'green' : 'red';
  let text: string;
  if (fallback && l.held) {
    text = l.hubConnected
      ? 'Live from this PC (hub back; takes over after End service)'
      : 'Live from this PC (hub unreachable)';
  } else if (fallback) {
    if (l.reconcile === 'conflict') text = 'Hub back: choose which service to keep';
    else if (l.reconcile === 'adopting' || l.reconcile === 'awaitState' || l.hubConnected)
      text = 'Hub back: handing over…';
    else if (refused) text = 'Running from this PC — session ended; sign in to hand back to the hub';
    else text = 'Hub lost: running from this PC';
  } else if (refused) text = 'Session ended: sign in again (outputs stay on the hub)';
  else if (l.hubConnected) text = 'Hub';
  else if (l.everConnected) text = 'Hub reconnecting…';
  else text = 'Connecting…';
  return { text, dot, fallback, refused };
}

/** The sign-in overlay's banner: what the outputs are doing meanwhile, and what signing in does. */
export function sessionEndedMessage(fallback: boolean): string {
  return fallback
    ? 'Your session ended while this PC is running the outputs. They keep running from this PC, and the keys, Stream Deck and MIDI keep working. Sign in (between songs) to hand the service back to the hub.'
    : 'Your session ended. Sign in again to keep operating. The outputs keep showing the service from the hub.';
}

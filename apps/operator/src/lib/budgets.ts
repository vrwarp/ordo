import type { BudgetLimit, BudgetRow } from '@ordo/client';

/**
 * Error budgets of the operator (design/25): a failure counted in a sliding window; once a budget is
 * exceeded the subsystem stops retrying where it can and the top bar turns red with exactly one action.
 * The printed checklist lists the same states and actions (lib/checklist.ts).
 */
export type BudgetKind = 'socket' | 'rejected' | 'workerRestart' | 'fallback' | 'cacheFill' | 'surface';

/** Counted in the core worker. */
export const CORE_BUDGETS: Record<string, BudgetLimit> = {
  socket: { max: 3, windowMs: 60_000 },
  rejected: { max: 5, windowMs: 60_000 },
  fallback: { max: 2, windowMs: 10 * 60_000 },
  cacheFill: { max: 2, windowMs: 10 * 60_000 },
};

/** Counted on the main thread (the core worker cannot count its own deaths; HID and MIDI live on main). */
export const MAIN_BUDGETS: Record<string, BudgetLimit> = {
  workerRestart: { max: 2, windowMs: 60_000 },
  surface: { max: 5, windowMs: 60_000 },
};

export type BudgetAction =
  | 'reconnectHub'
  | 'resync'
  | 'reload'
  | 'diagnostics'
  | 'retryCache'
  | 'reconnectDeck';

export type BudgetInfo = {
  /** What the volunteer sees in the top bar. */
  label: string;
  /** The one button. */
  actionLabel: string;
  action: BudgetAction;
  /** The checklist line: what it means and what to do. */
  checklist: string;
};

export const BUDGET_INFO: Record<BudgetKind, BudgetInfo> = {
  socket: {
    label: 'Hub connection keeps dropping',
    actionLabel: 'Reconnect',
    action: 'reconnectHub',
    checklist:
      'Red "Hub connection keeps dropping": press Reconnect. If it comes back, check the network cable of this PC and the NAS after the service.',
  },
  rejected: {
    label: 'The hub refused several commands',
    actionLabel: 'Resync',
    action: 'resync',
    checklist:
      'Red "The hub refused several commands": press Resync. The operator takes the hub\'s live state and continues.',
  },
  workerRestart: {
    label: 'The operator core restarted several times',
    actionLabel: 'Reload operator',
    action: 'reload',
    checklist:
      'Red "The operator core restarted several times": press Reload operator. The outputs keep showing the current slide while it reloads.',
  },
  fallback: {
    label: 'The hub was lost several times',
    actionLabel: 'Diagnostics',
    action: 'diagnostics',
    checklist:
      'Red "The hub was lost several times": keep going (this PC runs the service), press Diagnostics and download the operator log for the tech team.',
  },
  cacheFill: {
    label: 'Service files failed to download to this PC',
    actionLabel: 'Retry download',
    action: 'retryCache',
    checklist:
      'Red "Service files failed to download": press Retry download. Without them this PC cannot serve media if the hub is lost.',
  },
  surface: {
    label: 'Stream Deck or MIDI errors',
    actionLabel: 'Reconnect Stream Deck',
    action: 'reconnectDeck',
    checklist:
      'Red "Stream Deck or MIDI errors": press Reconnect Stream Deck (re-plug the USB cable first if it stays dark). The keyboard keeps working.',
  },
};

/** Red state when the core worker could not be restarted within its budget. */
export const CORE_GAVE_UP: BudgetInfo = {
  label: 'The operator core stopped',
  actionLabel: 'Reload operator',
  action: 'reload',
  checklist:
    'Red "The operator core stopped": press Reload operator. If it happens again, use the Stream Deck and tell the tech team.',
};

/** The first red state to show in the top bar, if any. */
export function firstRed(rows: BudgetRow[]): { kind: BudgetKind; info: BudgetInfo; row: BudgetRow } | null {
  for (const r of rows) {
    if (!r.exceeded) continue;
    const info = BUDGET_INFO[r.kind as BudgetKind];
    if (info) return { kind: r.kind as BudgetKind, info, row: r };
  }
  return null;
}

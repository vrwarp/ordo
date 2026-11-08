import { type BudgetInfo, type BudgetKind, CORE_GAVE_UP, firstRed } from '../lib/budgets.ts';
import { useLive } from '../state/live.ts';
import { setUi } from '../state/ui.ts';
import { controller } from './controller.ts';
import { log } from './log.ts';
import { surfaces } from './surfaces.ts';

export type RedState = { kind?: BudgetKind; info: BudgetInfo; detail?: string };

/** The red state to show in the top bar (one at a time, most fundamental first), or null. */
export function currentRedState(s = useLive.getState()): RedState | null {
  if (s.coreGaveUp) return { info: CORE_GAVE_UP };
  const red = firstRed([...s.mainBudgets, ...s.coreBudgets]);
  return red ? { kind: red.kind, info: red.info, detail: red.row.last } : null;
}

/** Perform the one action of a red state, and give its budget a fresh start. */
export function runRedAction(r: RedState): void {
  const ctl = controller();
  log('info', `red state action: ${r.info.actionLabel} (${r.kind ?? 'core'})`);
  switch (r.info.action) {
    case 'reconnectHub':
      ctl?.core.hubKick();
      break;
    case 'resync':
      ctl?.resync();
      break;
    case 'reload':
      location.reload();
      return;
    case 'diagnostics':
      setUi({ showDiagnostics: true });
      break;
    case 'retryCache':
      ctl?.core.retryCache();
      break;
    case 'reconnectDeck':
      void surfaces()?.connectDeck();
      break;
  }
  if (r.kind) ctl?.core.resetBudget(r.kind);
}

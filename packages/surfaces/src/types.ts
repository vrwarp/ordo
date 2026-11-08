import type { ActionId } from '@ordo/domain';

export type Action = { id: ActionId; arg?: number | string };
export type Dispatch = (a: Action, source: 'keyboard' | 'streamdeck' | 'midi' | 'ui') => void;

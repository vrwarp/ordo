import type { KeyMap } from '@ordo/domain';
import type { Dispatch } from './types.ts';

type ComboEvent = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** Modifier keys pressed alone never form a combo. */
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** Normalize a keyboard event to a combo string like `Ctrl+Shift+L`, `Space`, `F2`, `Digit1`, `ArrowRight`. */
export function normalizeCombo(e: ComboEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.code || e.key;
  if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
  else if (key === ' ' || key === 'Spacebar') key = 'Space';
  else if (key.length === 1 && /[a-z]/.test(key)) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

/** True for a bare modifier press (no combo should fire). */
export function isModifierOnly(e: Pick<KeyboardEvent, 'code' | 'key'>): boolean {
  return MODIFIER_CODES.test(e.code || e.key);
}

/** Keys that keep firing while held (stepping through slides); everything else fires once per press. */
const REPEATABLE = /^(Arrow(Left|Right|Up|Down)|Space|PageUp|PageDown)$/;

/** Keyboard driver: keydown on window, no debounce; ignores events from text inputs. */
export class KeyboardDriver {
  private handler = (e: Event) => this.onKey(e as KeyboardEvent);
  constructor(
    private map: KeyMap,
    private dispatch: Dispatch,
  ) {}
  setMap(map: KeyMap): void {
    this.map = map;
  }
  attach(target: Window = window): void {
    target.addEventListener('keydown', this.handler);
  }
  detach(target: Window = window): void {
    target.removeEventListener('keydown', this.handler);
  }
  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? '') ||
        (typeof t.closest === 'function' && t.closest('[data-keys="off"]')))
    ) {
      return;
    }
    if (isModifierOnly(e)) return;
    if (e.repeat && !REPEATABLE.test(e.code)) return;
    const combo = normalizeCombo(e);
    const a = this.map[combo];
    if (!a) return;
    e.preventDefault();
    this.dispatch(a.arg === undefined ? { id: a.id } : { id: a.id, arg: a.arg }, 'keyboard');
  }
}

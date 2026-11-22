/**
 * The press of Go live as the Controller's first line reaches the bake service (design/29 section 1.4): a few bytes in
 * the first load, so a phone (which never loads the bake) pays nothing for it. The bake boot (services/bakeBoot.ts, a
 * lazy chunk that only a regular layout fetches) registers itself here when it loads; until then there is no service
 * anywhere that could be making a picture, so the press has nothing to stop.
 */
let hold: (() => void) | undefined;

export function onGoLivePress(fn: (() => void) | undefined): void {
  hold = fn;
}

export function holdBakesForGoLive(): void {
  hold?.();
}

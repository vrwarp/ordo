import type { Output, ScreenRef } from '@ordo/domain';

/** The subset of a Window Management ScreenDetailed we use. */
export type ScreenInfo = {
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isPrimary?: boolean;
};

export type Placement = {
  output: Output;
  screen: ScreenInfo;
  /** How the saved ScreenRef matched; null means unmatched (placed on the primary screen). */
  matched: 'label' | 'position' | null;
};

export function toScreenRef(s: ScreenInfo): ScreenRef {
  return { label: s.label, left: s.left, top: s.top, width: s.width, height: s.height };
}

function samePos(a: ScreenRef, b: ScreenInfo): boolean {
  return a.left === b.left && a.top === b.top;
}

/**
 * Find the screen for a saved ScreenRef: by label first (if several screens share the label, the one at
 * the saved position wins), then by position. `taken` screens are skipped so two outputs never share a
 * screen by accident unless they were saved that way.
 */
export function matchScreen(
  ref: ScreenRef | undefined,
  screens: ScreenInfo[],
  taken: Set<ScreenInfo> = new Set(),
): { screen: ScreenInfo; by: 'label' | 'position' } | null {
  if (!ref) return null;
  const free = screens.filter((s) => !taken.has(s));
  const byLabel = ref.label ? free.filter((s) => s.label === ref.label) : [];
  if (byLabel.length === 1) return { screen: byLabel[0]!, by: 'label' };
  if (byLabel.length > 1) return { screen: byLabel.find((s) => samePos(ref, s)) ?? byLabel[0]!, by: 'label' };
  const byPos = free.find((s) => samePos(ref, s));
  if (byPos) return { screen: byPos, by: 'position' };
  return null;
}

export function primaryScreen(screens: ScreenInfo[]): ScreenInfo | undefined {
  return screens.find((s) => s.isPrimary) ?? screens[0];
}

/** Plan where every enabled output opens. Outputs whose saved screen is gone open on the primary screen. */
export function planLaunch(outputs: Output[], screens: ScreenInfo[]): Placement[] {
  const taken = new Set<ScreenInfo>();
  const out: Placement[] = [];
  const primary = primaryScreen(screens);
  for (const o of outputs) {
    if (!o.enabled) continue;
    const m = matchScreen(o.screen, screens, taken);
    if (m) {
      taken.add(m.screen);
      out.push({ output: o, screen: m.screen, matched: m.by });
    } else if (primary) {
      out.push({ output: o, screen: primary, matched: null });
    }
  }
  return out;
}

/** Outputs whose saved ScreenRef should be refreshed (matched by position with a new label, or new size). */
export function placementUpdates(plan: Placement[]): Output[] {
  const changed: Output[] = [];
  for (const p of plan) {
    if (!p.matched) continue;
    const ref = toScreenRef(p.screen);
    const s = p.output.screen;
    if (
      !s ||
      s.label !== ref.label ||
      s.left !== ref.left ||
      s.top !== ref.top ||
      s.width !== ref.width ||
      s.height !== ref.height
    )
      changed.push({ ...p.output, screen: ref });
  }
  return changed;
}

export function windowName(outputId: string): string {
  return `ordo-out-${outputId}`;
}

export function windowFeatures(s: ScreenInfo): string {
  return `popup,fullscreen,left=${s.left},top=${s.top},width=${s.width},height=${s.height}`;
}

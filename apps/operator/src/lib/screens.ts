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
  /**
   * How the saved ScreenRef matched: by label, by position, or `only` when there is a single screen
   * (nothing to choose, so the output is placed there and that screen is saved). null means unmatched
   * on a multi-screen PC: placed on the primary screen and the operator is asked (review item 9).
   */
  matched: 'label' | 'position' | 'only' | null;
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

/**
 * Plan where every enabled output opens. Outputs whose saved screen is gone open on the primary screen;
 * with a single screen that is the only possible answer, so they count as matched (`only`) and the
 * placement dialog never appears.
 */
export function planLaunch(outputs: Output[], screens: ScreenInfo[]): Placement[] {
  const taken = new Set<ScreenInfo>();
  const out: Placement[] = [];
  const primary = primaryScreen(screens);
  const single = screens.length === 1;
  for (const o of outputs) {
    if (!o.enabled) continue;
    const m = matchScreen(o.screen, screens, taken);
    if (m) {
      taken.add(m.screen);
      out.push({ output: o, screen: m.screen, matched: m.by });
    } else if (primary) {
      out.push({ output: o, screen: primary, matched: single ? 'only' : null });
    }
  }
  return out;
}

/**
 * Outputs whose saved ScreenRef should be refreshed: matched by position with a new label, a new size,
 * or placed on the only screen. Unmatched outputs on a multi-screen PC are left for the dialog.
 */
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

export function simulatedWindowFeatures(index = 0, screen?: ScreenInfo): string {
  const scWidth = screen?.width ?? (typeof window !== 'undefined' ? window.screen.width : 1920);
  const scHeight = screen?.height ?? (typeof window !== 'undefined' ? window.screen.height : 1080);
  const scLeft = screen?.left ?? 0;
  const scTop = screen?.top ?? 0;

  const w = scWidth > 1400 ? 960 : 640;
  const h = Math.round((w * 9) / 16);

  const stagger = 40;
  const maxLeft = Math.max(0, scWidth - w - 40);
  const maxTop = Math.max(0, scHeight - h - 60);
  const left = scLeft + Math.min(maxLeft, 60 + (index % 6) * stagger);
  const top = scTop + Math.min(maxTop, 60 + (index % 6) * stagger);

  return `popup=yes,left=${left},top=${top},width=${w},height=${h},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=no`;
}

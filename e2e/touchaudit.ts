import type { Page } from '@playwright/test';

/**
 * The touch-target audit (design/15 "Touch": every control is a 44 px target), shared by the iPad's editor
 * audit (e2e/ipad/touch-targets.spec.ts) and the compact layout's layout checks (e2e/phone/phonehelpers.ts
 * `layoutChecks`, design/28 §8 "Layout"). A control passes when its box is at least 44 px tall and 44 px
 * wide; a field inside a boxed label is reached by a tap anywhere on its label, so the label is measured.
 */
export type Miss = { where: string; what: string; w: number; h: number };

/** The controls the iPad audit measures. */
export const TARGET_SELECTOR =
  'button, select, a.btn, [role="tab"], [role="menuitem"], input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="hidden"])';

/** The compact layout's controls: the iPad's, every link, every `role="button"` and every checkbox label. */
export const COMPACT_SELECTOR = `${TARGET_SELECTOR}, a[href], [role="button"], label.check`;

/**
 * Every visible control under `root` (a CSS selector; each match is a scope) smaller than 44x44, apart from
 * the `exceptions` (CSS selectors, each with its reason where the caller lists them).
 */
export async function auditTargets(
  page: Page,
  where: string,
  root: string,
  exceptions: readonly string[] = [],
  selector: string = TARGET_SELECTOR,
): Promise<Miss[]> {
  return page.evaluate(
    ({ where, root, except, sel }) => {
      const out: { where: string; what: string; w: number; h: number }[] = [];
      for (const scope of document.querySelectorAll(root))
        for (const el of scope.querySelectorAll<HTMLElement>(sel)) {
          if (except.some((x) => el.matches(x))) continue;
          if (el.id === 'ordo-text-editor') continue; // the canvas's text field, not a target
          // A field in a boxed label is reached by a tap anywhere on its label: the label is the target.
          const r = (el.tagName === 'INPUT' ? (el.closest('label') ?? el) : el).getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
          if (Math.round(r.height) >= 44 && Math.round(r.width) >= 44) continue;
          const what = `${el.tagName.toLowerCase()}.${String(el.className).split(' ').filter(Boolean).join('.')} "${(
            el.getAttribute('aria-label') ??
            el.textContent ??
            ''
          )
            .trim()
            .slice(0, 24)}"`;
          out.push({ where, what, w: Math.round(r.width), h: Math.round(r.height) });
        }
      return out;
    },
    { where, root, except: [...exceptions], sel: selector },
  );
}

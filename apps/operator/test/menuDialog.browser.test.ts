import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { findChromium } from '../../../tools/find-chromium.ts';

/**
 * A Menu inside a Dialog, in headless Chromium (review of #26 against r2a's focus trap): since #26 the Menu's
 * list is portalled to the body, outside the dialog's box, so the dialog's focus trap (dialogEscape.ts
 * `registerModal`) took the focus back from its items, Tab from the trigger skipped them, and the live
 * KeyboardDriver, blocked while a modal is open, kept Enter and Space on them from pressing anything (a key
 * outside every `[data-keys="off"]`). The page (menuDialog.page.test-util.tsx) mounts the operator's own Dialog,
 * Menu and KeyboardDriver; real key presses and clicks move the focus and press the buttons. Each step records
 * where the focus is, whether the menu and the dialog are open and what was picked; the whole record is compared
 * at once, so a failure shows every step that went wrong.
 * Chromium is tools/find-chromium.ts's (Playwright's, else ORDO_TEST_CHROMIUM): skipped when none is found, and a
 * failure under CI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

type Esbuild = { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };

/** esbuild is not a dependency of the operator; vite is, and depends on it. */
async function loadEsbuild(): Promise<Esbuild> {
  const name = 'esbuild';
  try {
    return (await import(name)) as Esbuild;
  } catch {
    const fromOperator = createRequire(join(root, 'apps/operator/package.json'));
    return (await import(createRequire(fromOperator.resolve('vite')).resolve(name))) as Esbuild;
  }
}

type State = {
  focused: string;
  menu: boolean;
  dialog: boolean;
  log: string[];
  picker?: boolean;
  value?: string;
};
type Step = [string, (p: Page) => Promise<unknown>];

const press =
  (key: string): Step[1] =>
  (p) =>
    p.keyboard.press(key);
const openMenu: Step = ['click Layer', (p) => p.getByRole('button', { name: 'Layer ▾' }).click()];
const item = (p: Page, name: string) => p.getByRole('menuitem', { name, exact: true });

/** Where the focus is and what happened since the last step. */
function state(p: Page): Promise<State> {
  return p.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    const focused =
      !a || a === document.body
        ? 'body'
        : a.classList.contains('dialog')
          ? 'box'
          : (a.getAttribute('aria-label') || a.textContent || a.tagName).trim();
    return {
      focused,
      menu: !!document.querySelector('[role="menu"]'),
      dialog: !!document.querySelector('.dialog'),
      log: window.__log.splice(0),
      // Only where the colour picker is open, and the value of a focused field.
      picker: document.querySelector('.color-popover') ? true : undefined,
      value: a instanceof HTMLInputElement ? a.value : undefined,
    };
  });
}

const s = (focused: string, menu = true, log: string[] = [], dialog = true): State => ({
  focused,
  menu,
  dialog,
  log,
});

/** Each scenario: the page's variant, its steps and the state expected after each. */
const SCENARIOS: { name: string; variant: 'footer' | 'last' | 'colour'; steps: [Step, State][] }[] = [
  {
    name: 'arrows and Tab move through the items (the disabled one skipped), Shift+Tab back to the trigger',
    variant: 'footer',
    steps: [
      [openMenu, s('Layer ▾')],
      [['ArrowDown', press('ArrowDown')], s('Bring to front')],
      [['ArrowDown', press('ArrowDown')], s('Send backward')],
      [['ArrowUp', press('ArrowUp')], s('Bring to front')],
      [['ArrowUp (wraps)', press('ArrowUp')], s('Send to back')],
      [['Home', press('Home')], s('Bring to front')],
      [['End', press('End')], s('Send to back')],
      [['Shift+Tab', press('Shift+Tab')], s('Send backward')],
      [['Shift+Tab', press('Shift+Tab')], s('Bring to front')],
      [['Shift+Tab', press('Shift+Tab')], s('Layer ▾')],
      [['Tab', press('Tab')], s('Bring to front')],
      [['Tab', press('Tab')], s('Send backward')],
    ],
  },
  {
    name: 'Enter picks the focused item; nothing live acts',
    variant: 'footer',
    steps: [
      [openMenu, s('Layer ▾')],
      [['ArrowDown', press('ArrowDown')], s('Bring to front')],
      [['ArrowDown', press('ArrowDown')], s('Send backward')],
      [['Enter', press('Enter')], s('Layer ▾', false, ['pick:Send backward'])],
    ],
  },
  {
    name: 'Space picks the focused item',
    variant: 'footer',
    steps: [
      [openMenu, s('Layer ▾')],
      [['ArrowDown', press('ArrowDown')], s('Bring to front')],
      [['Space', press('Space')], s('Layer ▾', false, ['pick:Bring to front'])],
    ],
  },
  {
    name: 'a click picks an item, and the item keeps the focus the press gave it',
    variant: 'footer',
    steps: [
      [openMenu, s('Layer ▾')],
      [
        [
          'mouse down on Send to back',
          async (p) => {
            await item(p, 'Send to back').hover();
            await p.mouse.down();
          },
        ],
        s('Send to back'),
      ],
      [['mouse up', (p) => p.mouse.up()], s('Layer ▾', false, ['pick:Send to back'])],
      [openMenu, s('Layer ▾')],
      [
        ['click Bring to front', (p) => item(p, 'Bring to front').click()],
        s('Layer ▾', false, ['pick:Bring to front']),
      ],
    ],
  },
  {
    name: 'Escape closes the menu first, then the dialog',
    variant: 'footer',
    steps: [
      [openMenu, s('Layer ▾')],
      [['ArrowDown', press('ArrowDown')], s('Bring to front')],
      [['Escape', press('Escape')], s('Layer ▾', false)],
      [['Escape', press('Escape')], s('body', false, ['dialog closed'], false)],
    ],
  },
  {
    name: 'Tab past the last item closes the menu and goes on from the trigger',
    variant: 'footer',
    steps: [
      [openMenu, s('Layer ▾')],
      [['End', press('End')], s('Send to back')],
      [['Tab', press('Tab')], s('OK', false)],
    ],
  },
  {
    name: 'with the trigger the last control, Tab past the last item wraps to the first control',
    variant: 'last',
    steps: [
      [openMenu, s('Layer ▾')],
      [['End', press('End')], s('Send to back')],
      [['Tab', press('Tab')], s('Close', false)],
      [['Shift+Tab', press('Shift+Tab')], s('Layer ▾', false)],
    ],
  },
  {
    name: "the colour picker opened in the dialog is the dialog's too: its slider takes the arrows",
    variant: 'colour',
    steps: [
      [
        ['click the colour pill', (p) => p.getByRole('button', { name: 'Open color picker' }).click()],
        { ...s('Open color picker', false), picker: true },
      ],
      [
        ['focus Hue', (p) => p.getByRole('slider', { name: 'Hue' }).focus()],
        { ...s('Hue', false), picker: true, value: '210' },
      ],
      [['ArrowRight', press('ArrowRight')], { ...s('Hue', false), picker: true, value: '211' }],
      [['Escape (the picker only)', press('Escape')], s('body', false)],
      [['Escape', press('Escape')], s('body', false, ['dialog closed'], false)],
    ],
  },
];

const executablePath = await findChromium();

describe.skipIf(!executablePath)('a Menu inside a Dialog, in headless Chromium', () => {
  it("its portalled list is the dialog's: arrows, Tab, Enter, Space, a click and Escape", {
    timeout: 120_000,
  }, async () => {
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'menuDialog.page.test-util.tsx')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    const got: Record<string, string[]> = {};
    const want: Record<string, string[]> = {};
    const errors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body><div id="app"></div></body></html>');
      await page.addScriptTag({ content: built.outputFiles[0]!.text });
      for (const sc of SCENARIOS) {
        await page.evaluate((v) => window.__mount(v), sc.variant);
        await expect.poll(() => page.locator('.dialog').count()).toBe(1);
        got[sc.name] = [];
        want[sc.name] = [];
        for (const [[label, act], expected] of sc.steps) {
          await act(page);
          // React commits a key's or a click's update before the next task; let it, and the focus, settle.
          await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
          got[sc.name]!.push(`${label} -> ${JSON.stringify(await state(page))}`);
          want[sc.name]!.push(`${label} -> ${JSON.stringify(expected)}`);
        }
      }
    } finally {
      await browser.close();
    }
    expect(errors).toEqual([]);
    expect(got).toEqual(want);
  });
});

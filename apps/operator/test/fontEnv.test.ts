/**
 * services/fonts.ts installs the page's font resolver through `@ordo/renderer/text/fonts.ts` instead of the
 * renderer's barrel (which brings the preset geometry and the text engine into the entry, design/28 §7): the
 * barrel re-exports that module, so the editor's `currentFontEnv` (from `@ordo/renderer`) still sees it.
 */
import { currentFontEnv, FontResolver as BarrelResolver } from '@ordo/renderer';
import { FontResolver, installFontEnv } from '@ordo/renderer/text/fonts.ts';
import { describe, expect, it } from 'vitest';

describe('the font module behind the barrel', () => {
  it('installFontEnv from text/fonts.ts is what currentFontEnv from @ordo/renderer returns', () => {
    const before = currentFontEnv();
    const env = { ...before };
    installFontEnv(env);
    try {
      expect(currentFontEnv()).toBe(env);
      expect(BarrelResolver).toBe(FontResolver);
    } finally {
      installFontEnv(before);
    }
  });
});

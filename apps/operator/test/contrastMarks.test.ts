/**
 * b6 (#24): a contrast choice on a themed lyric box (the floating bar's menu, the Tune drawer's
 * readability cards) sets both the outline and the shadow, so it marks both as the volunteer's
 * (`style.outline`, `style.shadow`) and the next theme keeps exactly what was chosen. Before, the floating
 * bar marked only `style.outline` for every choice (a theme change dropped its 'Soft shadow'), and the
 * drawer's cards marked only the field they were named after (its Soft Shadow got the theme's outline back,
 * its Outline + Shadow lost the shadow).
 */
import { DEFAULT_THEME, type Slide, type TextObject, type TextStyle, type Theme } from '@ordo/domain';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { TextStyleEditor } from '../src/components/TextStyleEditor.tsx';
import { type ContrastMode, contrastChoice } from '../src/views/editor/FloatingContextBar.tsx';
import { applyThemeToSlide, markOverride } from '../src/views/editor/ops.ts';

const outlineOnly: Theme = (() => {
  const { shadow: _s, ...text } = DEFAULT_THEME.text;
  return {
    ...DEFAULT_THEME,
    id: 'evening',
    name: 'Evening',
    text: { ...text, outline: { width: 2, color: { r: 9, g: 9, b: 9, a: 1 } } },
  };
})();
const withShadow: Theme = {
  ...DEFAULT_THEME,
  id: 'warm',
  name: 'Warm',
  text: { ...DEFAULT_THEME.text, shadow: { dx: 1, dy: 1, blur: 2, color: { r: 1, g: 2, b: 3, a: 1 } } },
};

function lyricSlide(style: TextStyle, overrides: string[]): Slide {
  const lyric: TextObject = {
    id: 'l',
    type: 'text',
    box: { ...DEFAULT_THEME.lyricBox },
    text: 'Praise God from whom all blessings flow',
    style,
    opacity: 1,
  };
  return overrides.reduce(markOverride, { id: 's', objects: [lyric], lyricObjectId: 'l' } as Slide);
}
const styleOf = (s: Slide) => (s.objects[0] as TextObject).style;

describe('the floating bar’s contrast menu (contrastChoice)', () => {
  const modes: ContrastMode[] = ['clean', 'shadow', 'outline', 'heavy'];
  it('marks both the outline and the shadow for every choice', () => {
    for (const m of modes)
      expect(contrastChoice(DEFAULT_THEME.text as TextStyle, m).overrides).toEqual([
        'style.outline',
        'style.shadow',
      ]);
  });

  it('every choice survives a change to a theme with an outline only, and to one with a shadow', () => {
    for (const m of modes) {
      const c = contrastChoice(outlineOnly.text as TextStyle, m);
      const chosen = { outline: c.style.outline, shadow: c.style.shadow };
      for (const theme of [outlineOnly, withShadow]) {
        const after = styleOf(applyThemeToSlide(lyricSlide(c.style, c.overrides), theme));
        expect({ outline: after.outline, shadow: after.shadow }, `${m} under ${theme.name}`).toEqual(chosen);
      }
    }
    // The bug: Soft shadow marked as 'style.outline' only loses its shadow under an outline-only theme.
    const soft = contrastChoice(outlineOnly.text as TextStyle, 'shadow');
    expect(
      styleOf(applyThemeToSlide(lyricSlide(soft.style, ['style.outline']), outlineOnly)).shadow,
    ).toBeUndefined();
  });
});

/** Every element of a tree, by its children (TextStyleEditor has no hooks: it is called as a function). */
function* elements(n: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(n)) for (const c of n) yield* elements(c);
  else if (isValidElement(n)) {
    const el = n as ReactElement<Record<string, unknown>>;
    yield el;
    yield* elements(el.props.children as ReactNode);
  }
}

describe('the Tune drawer’s readability cards (TextStyleEditor)', () => {
  it('each of the four cards names both the outline and the shadow as changed', () => {
    const calls: { key: keyof TextStyle; also?: readonly (keyof TextStyle)[] }[] = [];
    const tree = TextStyleEditor({
      value: DEFAULT_THEME.text as TextStyle,
      mode: 'fineTune',
      onChange: (_s, key, also) => calls.push({ key, also }),
    });
    const cards = [...elements(tree)].filter(
      (e) => e.type === 'button' && String(e.props.className ?? '').includes('contrast-card-btn'),
    );
    expect(cards).toHaveLength(4);
    for (const c of cards) (c.props.onClick as () => void)();
    expect(calls).toHaveLength(4);
    for (const c of calls)
      expect(new Set([c.key, ...(c.also ?? [])])).toEqual(new Set(['outline', 'shadow']));
  });
});

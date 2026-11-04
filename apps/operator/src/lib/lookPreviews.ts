import { arrangedSections, type Look, type Presentation, type Slide } from '@ordo/domain';

const KIND_ORDER: Record<Look['kind'], number> = { main: 0, lowerThird: 1, stream: 2, stage: 3, custom: 4 };

/** What each kind of look is for, under its name in the previews. */
export const LOOK_ROLE: Record<Look['kind'], string> = {
  main: 'Main screen',
  lowerThird: 'Lobby / overflow lower third',
  stream: 'Livestream key',
  stage: 'Stage display, with the next slide',
  custom: 'Custom look',
};

/** The looks to preview, main first, then lower third, stream key, stage and custom looks. */
export function previewLooks(looks: readonly Look[]): Look[] {
  return looks
    .map((l, i) => ({ l, i }))
    .sort((a, b) => KIND_ORDER[a.l.kind] - KIND_ORDER[b.l.kind] || a.i - b.i)
    .map((x) => x.l);
}

/** Every slide of a presentation in authoring order. */
export function flatSlides(p: Presentation): Slide[] {
  return p.sections.flatMap((s) => s.slides);
}

/**
 * The slide to preview (the given one, else the first) and the one after it for the stage look. "Next"
 * follows the presentation's first arrangement (Verse 1, Chorus, Verse 2, Chorus…), as the stage display
 * does when the song is played through it; a slide that repeats is taken at its first appearance. A
 * playlist may name another arrangement, which the preview cannot know.
 */
export function slideAndNext(
  p: Presentation,
  slideId?: string,
): { slide?: Slide; next?: Slide; index: number } {
  const all = arrangedSections(p).flatMap((s) => s.slides);
  let index = slideId ? all.findIndex((s) => s.id === slideId) : 0;
  if (index < 0) index = 0;
  return { slide: all[index], next: all[index + 1], index };
}

/**
 * The background media a look shows behind a slide: the slide's (or presentation's) background when the
 * look's background layer is visible, else the look's holding image, else none.
 */
export function lookBackgroundId(look: Look, p: Presentation, slide: Slide): string | undefined {
  if (look.layers.background.visible) return slide.backgroundMediaId ?? p.backgroundMediaId;
  return look.holdingMediaId;
}

/**
 * The M4 editor ops (design/27 §11 "Editor extensions for churches", §15 M4; `../M4.md`): pure functions
 * beside the editor's original ops (`../ops.ts`), one module per work item so the items are built in
 * parallel without touching each other's files. `../actions.ts` applies them to the open presentation
 * through `change()`.
 *
 * | module        | item | ops |
 * |---------------|------|-----|
 * | `text.ts`     | A    | editText, formatRange, resizeRange, selectionStyle, setParas, parasTouched, selectionParas, refitText, themedRuns |
 * | `group.ts`    | B    | groupMembers, moveObjects, transformGroup, deleteObjects, duplicateObjects, reorderObjects, ungroup, isLocked |
 * | `pictures.ts` | D    | setCrop, setMask, setFlip, replacePicture |
 * | `slides.ts`   | E    | findText, findReplace, hideSlide, replaceBackground, similarObjects, applyStyleToSimilar, newSlideLike, useAsBackground |
 * | `common.ts`   | -    | withSlide, withObject, withEverySlide (identity-keeping updates) |
 */
export * from './clipboard.ts';
export * from './common.ts';
export * from './group.ts';
export * from './pictures.ts';
export * from './slides.ts';
export * from './text.ts';

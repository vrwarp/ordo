import { ApiFailure } from '@ordo/client';
import { Presentation } from '@ordo/domain';

/*
 * Three-way merge on a save conflict (design/27 §11 item 17, optional in M4; M4 item H). When the hub refuses a
 * save with 409 (someone else saved since the editor's base), the editor merges instead of offering only
 * "Reload theirs" or "Save mine anyway":
 * - base = the version the editor opened or last saved (`EditorState.base`),
 * - mine = the draft,
 * - theirs = the 409 body's `current` (`ApiFailure.details.current`, `theirsOf`),
 * so two volunteers editing different slides, or a volunteer and the hub's version-2 patch, do not overwrite
 * each other. `lib/pptxImport.ts` `rebaseOnJobs` is the special case already built for the PowerPoint jobs.
 */

/** Where the two sides changed the same thing differently. */
export type MergeConflict = {
  level: 'presentation' | 'section' | 'slide' | 'object';
  /** The presentation field, section, slide or object concerned. */
  key: string;
  slideId?: string;
  objectId?: string;
  /** What to tell the volunteer, e.g. "Slide 4: both changed the text box 'Welcome'". */
  what: string;
};

/**
 * The outcome: `merged` (carrying `theirs.rev`, so it saves on top of their version) when every change of the
 * two sides fits together, else the conflicts, and the editor's dialog says what it could not merge and
 * keeps today's two choices.
 */
export type MergeResult =
  | { merged: Presentation; conflicts: [] }
  | { merged?: undefined; conflicts: MergeConflict[] };

/**
 * Merge mine and theirs over base, at slide and object level: a slide (or object) only one side changed takes
 * that side's version; one both changed identically is kept; one both changed differently is a conflict
 * (unless the changes are to different objects of it, which merge object by object). Slides added on either
 * side are kept, slides deleted on one side and unchanged on the other go, section and slide order follow
 * the side that changed it. Presentation fields follow the same rule field by field.
 *
 * Scaffold: never merges (one conflict), so the editor keeps today's dialog. Item H.
 */
export function mergeThreeWay(_base: Presentation, _mine: Presentation, _theirs: Presentation): MergeResult {
  return { conflicts: [{ level: 'presentation', key: '', what: 'Merging is not available yet.' }] };
}

/**
 * The version that won a 409 save (`ApiFailure.details.current`), validated as a presentation, so a hub of
 * another version or a damaged body never reaches the merge; undefined otherwise.
 */
export function theirsOf(e: unknown): Presentation | undefined {
  if (!(e instanceof ApiFailure) || e.status !== 409) return undefined;
  const parsed = Presentation.safeParse(e.details?.current);
  return parsed.success ? parsed.data : undefined;
}

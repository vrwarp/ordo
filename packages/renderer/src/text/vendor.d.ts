/*
 * Types for the npm packages of the text engine that ship none. bidi-js 1.1.0 ships its own
 * (src/bidi.d.ts). Pulled into every program that compiles breaks.ts through its triple-slash reference,
 * so the apps that type-check the renderer's sources need nothing of their own.
 */

/** linebreak 1.1.0 (MIT): the Unicode line breaking algorithm, UAX#14. */
declare module 'linebreak' {
  /** A break opportunity: the line may end before `string[position]`; `required` for a mandatory break. */
  export interface Break {
    position: number;
    required: boolean;
  }
  /** Iterates the break opportunities of `string` in order; the last is always `string.length`. */
  export default class LineBreaker {
    constructor(string: string);
    nextBreak(): Break | null;
  }
}

/**
 * The budget ladder lives in the import core (`@ordo/importers` `pptx-ladder.ts`), which the hub's job, the
 * client parse and the fidelity harness share; this module keeps the hub's old import path.
 */
export * from '@ordo/importers/pptx-ladder.ts';

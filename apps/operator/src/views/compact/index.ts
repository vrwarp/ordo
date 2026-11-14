/**
 * The compact chunk (design/28 §2.2, §3.1 "Code split"; src/pages.ts `PAGES.compact`, src/pageSets.ts
 * `COMPACT_START`): a phone's frame and its P0 views, loaded at startup on the compact layout or a phone and
 * never on the venue PC. P1's phone-first views replace the bodies here.
 */
export { CompactFrame } from './CompactFrame.tsx';
export { MoreSheet } from './MoreSheet.tsx';

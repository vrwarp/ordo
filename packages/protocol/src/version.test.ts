import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './index.ts';

/**
 * The hub sends `bye version` to a window whose APP_VERSION differs from its own (design/13 "Versioning"),
 * and that is the only thing that reloads an operator, output or stage tab left open across a hub upgrade.
 * Every client runs the same reducer, cue expansion, schemas and planner as the hub on the same states and
 * deltas, so a change to what they compute needs a new APP_VERSION: with the old one a stale tab keeps
 * applying the old meaning to new states, with nothing to detect it (M5: the slide video on the media
 * layer, slide-owned audio).
 *
 * This test fingerprints those shared sources (comments and whitespace ignored). When it fails:
 * - if a client would compute anything differently from the same state, event, message or stored
 *   document (a reducer or cue rule, a schema field a stale editor would strip, what the planner draws),
 *   bump APP_VERSION and record the new digest with it;
 * - otherwise (a refactor with the same results), record the new digest with the same version.
 */
// 0.6.0 again with phones P0 (design/28): schemas.ts: PhoneSettings, a settings key a stale client ignores.
// 0.7.0 for PR #27 (wave r2a and phones P0), the one bump at merge: main published 0.6.0 without the decoration
// drawer or geometry units, and its cached pages must reload rather than draw these slides the old way. The
// digest is unchanged (it leaves the APP_VERSION line out).
// 0.8.0 for adaptive stage presets and speaker notes scale: PropsRule.stagePreset and PropsRule.notesScale in
// schemas.ts, which a stale client would strip when saving looks.
// 0.8.1 for the Pulpit Lectern's own hello: protocol index.ts Hello.view ('lectern'), which a stale 0.8.0 stage
// tab never sends, so the hub would still take its lectern for a newer Stage Display; stale stage and lectern
// tabs reload on the hub's bye version. Re-recorded at 0.8.1 for plan.ts slideVisible's stage-preview notes (the
// planner's own slides carry no notes, so no plan changes).
// Main's version kept through wave r2b's sub-waves (main published 0.8.0 with PR #28, merged into sub-wave 1
// before the wave PR opened, and 0.8.1 with PR #30, merged into the wave PR; that pull request's one bump, 0.9.0, is
// its last commit), with the merged digest recorded at main's version.
// Sub-wave 1: golive-prepare (design/29 M8) adds the POST /live/prepare request and answer types, which no older
// client sends or reads; units-live adds OutputHealth's optional unitsMade, unitsLate and unitCacheBytes, which an
// older hub's parse strips; prerender-model (design/29) adds schemas.ts Slide.prerender, draw, cut and meta.draw,
// optional fields nothing writes yet (an older client strips them), content.ts slideContent's picture form (used
// only when a caller passes a picture file: none does yet), live.ts ResolvedPlaylist.prerenders and prerenderKeys
// (listed only from the hub's picture rows: none yet), and in live.ts, live-state and protocol index.ts the
// prerender.add (hub only) and prerender.use events, state.prerendered and state.drawOverride, which no client
// sends before the sub-waves that use them. Each track re-recorded on its branch; the sub-wave's integrator
// recorded the merged digest once, after its last merge, and again after main's PR #28 was merged in.
// The main merge's repair made PR #30's two shared changes on the wave while it was still at 0.8.0 (Hello.view
// and plan.ts slideVisible's stage-preview notes, the same code as main's 0.8.1 above). With PR #30 merged in,
// the shared sources are the wave's as they were (the digest leaves the APP_VERSION line out), so the merged
// digest is the wave's, recorded at 0.8.1.
// 0.9.0 for PR #29 (wave r2b's parts 1, 1b and 1c: editable PowerPoint tables, Go live during a service, a GO
// never waits for drawing), that pull request's one bump, its last commit. Main published 0.8.1 without them, so an
// operator, output or stage tab still running 0.8.1 from its cache must reload (the hub's bye version) rather
// than go on without them: without sub-wave 1's shared changes above, or sending the hub PowerPoint scenes
// parsed as 0.8.1 parsed them (design/27, "CONVERTER_VERSION stays 2 through sub-wave 1c too"). The digest is
// unchanged (it leaves the APP_VERSION line out).
// 0.9.1 for QuickQ 20 MIDI support: schemas.ts adds MidiMapping.kind 'noteOff' and SurfaceSettings.midiDefaultOutput,
// which a stale 0.9.0 operator tab would reject or strip when saving surface settings.
// 0.9.2 for Lighting & MIDI triggers: schemas.ts adds MidiPreset, MidiTrigger, Media.midi, PlaylistItem.midi,
// Section.midi, Slide.midi, ActionId 'midiPreset', and SurfaceSettings.midiPresets; live.ts and cues.ts resolve
// 4-scope background/item/section/slide MIDI cues onto Cue.
// 0.10.0 for wave r2b's sub-wave 2 (part 2: crowded slides drawn whole on the Audience screens, the running service
// kept by name, the editor's line art and shadows drawn whole, dense decks imported, the hub's disk watched), its own
// pull request and its one bump, its last commit (the owner, 2026-11-20: a bump per merged milestone; the next is
// 0.11.0). Main published 0.9.2 without them (0.9.0 was PR #29's, 0.9.1 and 0.9.2 are the two entries above, merged into
// this pull request with main's PRs #31 to #39), so an operator, output or stage tab still running 0.9.2 from its cache
// reloads on the hub's bye version rather than go on without them. The sub-wave changes two shared sources, recorded in
// the digest once, after the merge (the digest leaves the APP_VERSION line out, so the bump itself leaves it as it was):
// live-by-ref adds four optional `resolvedId` fields to the protocol (hello, live.resync, live.state, live.delta), so
// older and newer builds read each other's messages as before (a missing field is what they sent before); live-frame
// adds `SlideDesc.full` to the renderer's plan.ts (the slide before the live clamp's cut, only for a slide past a count;
// the descriptor of any other slide is unchanged). The two sides changed different shared sources (main's: schemas.ts,
// cues.ts, live.ts, and the APP_VERSION line of the protocol's index.ts, which the digest leaves out; the sub-wave's: the
// rest of the protocol's index.ts and plan.ts), so the digest is each side's changes together.
// schemas.ts is as 0.9.2 has it (the sub-wave stores no new field), so a rollback to 0.9.2 reads every stored
// presentation and look 0.10.0 writes, and the older-build fixtures (0.8.1 and 0.5.0) stand. A rollback does not restore
// a service that was running: an older hub reads the by-name snapshot as invalid and starts idle (design/29 r2b.9, Q6.a).
// shape-raster (Q53, Q66, Q68), recorded on its branch at the UNCHANGED version 0.10.0: schemas.ts gains the optional
// `ObjectOrigin.raster` (the provenance of a picture of shapes, written only for an object of origin role 'raster': an older
// build strips the key on a re-save and draws an ordinary picture, and the older-build fixtures stand) and cues.ts reads a
// native slide's `pptx.artText` for a slide that holds such a picture (`importedText`: the words of the picture for the cue
// label, the Stage and search). The sub-wave's one bump to 0.11.0, the last commit of the pull request, covers it, and the
// integrator records the merged digest once after the last merge.
// 0.12.0 for ADR 0015 (closed-manifest live adjustments and PlaylistItem overrides): schemas.ts adds optional
// PlaylistItem.sections, hiddenSlides, and skipped plus ActionId 'skipNextItem'; cues.ts applies
// sections/hiddenSlides/skipped and steps over skipped items in nextShownCue/prevShownCue; live.ts and
// live-state add item.skip, item.arrange, item.hideSlides, and slide.editText events, skipNextItem action
// mapping, and auto-unskip on explicit go.
// 0.12.1 for countdown timer presets (PropsRule.countdownPreset, PropsRule.countdownCorner, and
// TimerSpec.preset/corner in schemas.ts, which a stale client would strip when saving looks or playlists).
// 0.12.2 for loop single-unit navigation and standby arming in live-state (nextManualCue, prevManualCue,
// custom armed preservation across intra-loop advances, and Next firing armed when exiting a loop).
// 0.12.3 for song title slides and audience lyric blanking: schemas.ts adds Presentation.meta.titleSlide,
// ActionId 'toggleBlankText', and GeneralSettings.ccliLicense/defaultTitleSlide; cues.ts and plan.ts
// materialize optional song title slides; live.ts and live-state add blankText state/event and clearSlide
// toggle restore.
const RECORDED = {
  version: '0.12.3',
  digest: '2e4533092e70b6b0f70d0b8611233f00e1c785c22681e1763a441f9947d2557b',
};

/** Sources whose meaning every client shares with the hub, relative to the repository root. */
const SHARED = [
  'packages/live-state/src/index.ts',
  'packages/live-state/src/actions.ts',
  'packages/live-state/src/invariants.ts',
  'packages/domain/src/chart.ts',
  'packages/domain/src/content.ts',
  'packages/domain/src/cues.ts',
  'packages/domain/src/live.ts',
  'packages/domain/src/schemas.ts',
  'packages/domain/src/three-names.ts',
  'packages/protocol/src/index.ts',
  'packages/renderer/src/plan.ts',
];

/** The source without comments, the APP_VERSION line and layout. */
function normalize(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/^export const APP_VERSION = .*$/m, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function digest(): string {
  const h = createHash('sha256');
  for (const rel of SHARED) {
    h.update(`${rel}\n`);
    h.update(normalize(readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8')));
  }
  return h.digest('hex');
}

describe('APP_VERSION', () => {
  it('changes with the meaning of the sources every client shares with the hub', () => {
    const now = digest();
    expect(
      { version: APP_VERSION, digest: now },
      `The shared client sources changed (digest ${now}). If a client would compute anything differently, bump APP_VERSION in packages/protocol/src/index.ts; then record the version and digest in RECORDED (see the comment above it).`,
    ).toEqual(RECORDED);
  });

  it('fingerprints every live-state source, not only its index (actions, invariants)', () => {
    const dir = new URL('../../live-state/src/', import.meta.url);
    for (const name of readdirSync(dir))
      if (name.endsWith('.ts') && !name.endsWith('.test.ts'))
        expect(SHARED).toContain(`packages/live-state/src/${name}`);
  });

  it('ignores comments and layout', () => {
    expect(normalize('const a = 1; // note\n/* block\n */  const  b = "http://x";')).toBe(
      'const a = 1; const b = "http://x";',
    );
  });
});

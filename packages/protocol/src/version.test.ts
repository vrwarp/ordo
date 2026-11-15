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
// 0.7.0 again on r2b/prerender-model (wave r2b sub-wave 1, design/29): schemas.ts Slide.prerender, draw, cut and
// meta.draw, optional fields nothing writes yet (an older client strips them); content.ts slideContent's picture
// form, used only when a caller passes a picture file (none does yet); live.ts ResolvedPlaylist.prerenders and
// prerenderKeys, optional, listed only from the hub's picture rows (none yet); live.ts, live-state and protocol
// index.ts: the prerender.add (hub only) and prerender.use events, state.prerendered and state.drawOverride, which
// no client sends before the sub-waves that use them. The wave's one bump, 0.8.0, comes at its end and the
// integrator re-records the digest once after the sub-wave's last merge.
const RECORDED = {
  version: '0.7.0',
  digest: 'cff67be36b06f3aaf9a942fbc841146c9bd99dbee9c8022f1a0beca806daf4dd',
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

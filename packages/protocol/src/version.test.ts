import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const RECORDED = {
  version: '0.2.0',
  digest: '43d9344dd6a3c11a0581cdfc4d91d108c189e96bcac70c91517f590c91b1f68c',
};

/** Sources whose meaning every client shares with the hub, relative to the repository root. */
const SHARED = [
  'packages/live-state/src/index.ts',
  'packages/domain/src/cues.ts',
  'packages/domain/src/live.ts',
  'packages/domain/src/schemas.ts',
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

  it('ignores comments and layout', () => {
    expect(normalize('const a = 1; // note\n/* block\n */  const  b = "http://x";')).toBe(
      'const a = 1; const b = "http://x";',
    );
  });
});

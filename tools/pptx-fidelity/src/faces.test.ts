import { FALLBACK_SCRIPTS } from '@ordo/domain/readable.ts';
import { describe, expect, it } from 'vitest';
import { hostFace, SCRIPT_SAMPLES, scriptPattern } from './faces.ts';

describe("the harness's faces (fontconfig's, as the page draws them)", () => {
  it('has a letter of its own for every fallback script, and asks fontconfig for it by charset', () => {
    for (const [code, re] of FALLBACK_SCRIPTS) {
      const cp = SCRIPT_SAMPLES[code];
      expect(cp, code).toBeDefined();
      expect(re.test(String.fromCodePoint(cp!)), code).toBe(true);
    }
    expect(Object.keys(SCRIPT_SAMPLES).sort()).toEqual(FALLBACK_SCRIPTS.map(([c]) => c).sort());
    expect(scriptPattern('Hang')).toBe(':charset=ac00');
    expect(scriptPattern('Latn')).toBeUndefined();
    expect(scriptPattern('__proto__')).toBeUndefined();
  });

  it("gives a script's face that draws its letter, or none on a host without one (FaceSource.script)", () => {
    expect(typeof hostFace.script).toBe('function');
    const f = hostFace.script!('Hang');
    if (f) expect(f.advance(0xac00)).toBeGreaterThan(0);
    expect(hostFace.script!('Latn')).toBeUndefined();
  });
});

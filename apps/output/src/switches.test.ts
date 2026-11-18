import { describe, expect, it } from 'vitest';
import { outputSwitches } from './switches.ts';

/*
 * The output window's URL switches (main.ts, beside `?renderer=2d`): venue troubleshooting switches for drawing
 * (design/14 "Late units"), carried to the asset worker in its init, and a test-mode-only slow-down of unit turns.
 */
const q = (s: string) => new URLSearchParams(s);

describe('output URL switches', () => {
  it('reads the renderer switches as before', () => {
    expect(outputSwitches(q('renderer=2d'), false)).toMatchObject({
      forceCanvas2d: true,
      allowFallbackAdapter: false,
    });
    expect(outputSwitches(q('renderer=webgpu'), false)).toMatchObject({
      forceCanvas2d: false,
      allowFallbackAdapter: true,
    });
  });

  it('carries ?late=next, ?warm=off and ?effects=base into the drawing switches; nothing by default', () => {
    expect(outputSwitches(q(''), false).drawing).toEqual({});
    expect(outputSwitches(q('late=next&warm=off&effects=base'), false).drawing).toEqual({
      late: 'next',
      warm: false,
      effects: 'base',
    });
    // Anything else is not a switch.
    expect(outputSwitches(q('late=never&warm=maybe&effects=all'), false).drawing).toEqual({});
  });

  it('takes ?unitTurnMs only in test mode, bounded, and refuses it outside test mode', () => {
    expect(outputSwitches(q('unitTurnMs=40'), true)).toMatchObject({
      drawing: { unitTurnMs: 40 },
      refused: [],
    });
    expect(outputSwitches(q('unitTurnMs=99999'), true).drawing.unitTurnMs).toBe(5000);
    expect(outputSwitches(q('unitTurnMs=-3'), true).drawing.unitTurnMs).toBeUndefined();
    const venue = outputSwitches(q('unitTurnMs=40&late=next'), false);
    expect(venue.drawing).toEqual({ late: 'next' });
    expect(venue.refused).toEqual(['unitTurnMs']);
  });
});

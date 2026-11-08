import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, LOOK_STAGE } from './defaults.ts';
import { Look, PropsRule } from './schemas.ts';

describe("a stage look's notes region (design/27 §3.1 PropsRule.notes, §11 item 13)", () => {
  it('is optional: stored looks without it parse as before, with no notes key', () => {
    const l = Look.parse(LOOK_STAGE);
    expect('notes' in l.layers.props).toBe(false);
    expect(PropsRule.parse({})).toEqual({
      logo: false,
      countdown: false,
      clock: false,
      messages: false,
      elapsed: false,
      style: {},
    });
  });

  it('is kept when set, with its style under style.notes like the other regions', () => {
    const box = { x: 40, y: 700, w: 1840, h: 340, rotation: 0 };
    const notesStyle = { ...DEFAULT_LYRIC_STYLE, fontSizePx: 40, box };
    const l = Look.parse({
      ...LOOK_STAGE,
      layers: {
        ...LOOK_STAGE.layers,
        props: {
          ...LOOK_STAGE.layers.props,
          notes: true,
          style: { ...LOOK_STAGE.layers.props.style, notes: notesStyle },
        },
      },
    });
    expect(l.layers.props.notes).toBe(true);
    expect(l.layers.props.style.notes?.box).toEqual(box);
  });

  it('refuses a value that is not a boolean', () => {
    expect(PropsRule.safeParse({ notes: 'yes' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, LOOK_STAGE } from './defaults.ts';
import { Look, PropsRule } from './schemas.ts';
import { parseStageNoteLine, stageNotesEnabled } from './stageNotes.ts';

describe("a stage look's notes region (design/27 §3.1 PropsRule.notes, §11 item 13)", () => {
  it('is optional: stored looks without it parse as before, with no notes key', () => {
    const l = Look.parse({
      ...LOOK_STAGE,
      layers: {
        ...LOOK_STAGE.layers,
        props: { logo: false, countdown: true, clock: true, messages: true, elapsed: true, style: {} },
      },
    });
    expect('notes' in l.layers.props).toBe(false);
    expect(Look.parse(LOOK_STAGE).layers.props.notes).toBe(true);
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

  it('parses stagePreset and notesScale, enables stage notes by default on stage looks, and tokenises rich cues', () => {
    const parsed = PropsRule.parse({ stagePreset: 'split', notesScale: 'xl' });
    expect(parsed.stagePreset).toBe('split');
    expect(parsed.notesScale).toBe('xl');
    expect(PropsRule.parse({ stagePreset: 'bogus', notesScale: 'huge' }).stagePreset).toBe('auto');

    const legacyStage = Look.parse({
      ...LOOK_STAGE,
      layers: {
        ...LOOK_STAGE.layers,
        props: { logo: false, countdown: true, clock: true, messages: true, elapsed: true, style: {} },
      },
    });
    expect(stageNotesEnabled(legacyStage)).toBe(true);
    expect(
      stageNotesEnabled({
        ...legacyStage,
        layers: { ...legacyStage.layers, props: { ...legacyStage.layers.props, notes: false } },
      }),
    ).toBe(false);

    expect(parseStageNoteLine('Plain Hebrew שלום')).toEqual({
      plain: true,
      bullet: false,
      tokens: [{ kind: 'text', text: 'Plain Hebrew שלום' }],
    });
    expect(parseStageNoteLine('• Emphasize **grace** [PAUSE]')).toEqual({
      plain: false,
      bullet: true,
      tokens: [
        { kind: 'text', text: 'Emphasize ' },
        { kind: 'highlight', text: 'grace' },
        { kind: 'text', text: ' ' },
        { kind: 'cue', text: 'PAUSE' },
      ],
    });
  });
});

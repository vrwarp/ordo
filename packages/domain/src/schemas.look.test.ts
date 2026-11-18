import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, LOOK_STAGE } from './defaults.ts';
import { Look, PropsRule } from './schemas.ts';
import * as prev from './schemas.prev.test-util.ts';
import * as prev05 from './schemas.prev05.test-util.ts';
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

/*
 * design/27 §3.2 "Older builds", design/29 §1.6: a stage look this build saves, as the older builds read it. The
 * build a venue runs before wave r2b is main's 0.8.1 (PR #30), whose schema is 0.8.0's (PR #28,
 * `schemas.prev.test-util.ts`), which added the adaptive stage preset and the notes size; 0.5.0
 * (`schemas.prev05.test-util.ts`) predates them.
 */
describe('a stage look this build saves, read by the older builds', () => {
  const look = () =>
    Look.parse({
      ...LOOK_STAGE,
      layers: {
        ...LOOK_STAGE.layers,
        props: { ...LOOK_STAGE.layers.props, notes: true, stagePreset: 'prompter', notesScale: 'sm' },
      },
    });

  it('the older build (0.8.0 and 0.8.1) keeps its stage preset, notes size and notes switch, and saves back the same look', () => {
    const old = prev.Look.parse(look());
    expect(old.layers.props.stagePreset).toBe('prompter');
    expect(old.layers.props.notesScale).toBe('sm');
    expect(old.layers.props.notes).toBe(true);
    expect(Look.parse(old)).toEqual(look());
  });

  it('0.5.0 strips the stage preset and notes size and keeps the notes switch; what it saves back parses here', () => {
    const old = prev05.Look.parse(look());
    expect(old.layers.props).not.toHaveProperty('stagePreset');
    expect(old.layers.props).not.toHaveProperty('notesScale');
    expect(old.layers.props.notes).toBe(true);
    expect(Look.safeParse(old).success).toBe(true);
  });
});

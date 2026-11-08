import {
  DEFAULT_LOOKS,
  LOOK_MAIN,
  LOOK_STAGE,
  type LiveState,
  type Look,
  type Presentation,
  parseLyrics,
  type ResolvedPlaylist,
  SERVICE_COUNTDOWN_TIMER_ID,
  songFromParsed,
} from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  activeMessages,
  clearOf,
  countdownDisplay,
  currentText,
  cutNotes,
  defaultNotes,
  elapsedDisplay,
  FrameStats,
  mediaRemainingDisplay,
  flipDelay,
  nextExpiry,
  NOTES_MAX,
  nextText,
  notesText,
  overlaps,
  reconcileMessages,
  resolveStageLook,
  slideText,
  stageFontFamilies,
  stageLayout,
  stageParagraphs,
  textCss,
} from './model.ts';
import { buildView } from './view.ts';

function song(): Presentation {
  return songFromParsed(
    parseLyrics(
      'Grace\n\nVerse 1\nLine one\nLine two\nLine three\nLine four\n\nChorus\nSing it loud\nSing it proud',
    ),
    { linesPerSlide: 2 },
  );
}

function announcement(): Presentation {
  return {
    id: 'ann',
    rev: 1,
    title: 'Welcome',
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: 'sa', label: 'Slides', short: 'S', slides: [{ id: 'a1', objects: [] }] }],
    arrangements: [],
    archived: false,
  };
}

function live(): { s: LiveState; p: Presentation } {
  const p = song();
  const a = announcement();
  const resolved: ResolvedPlaylist = {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'Sunday',
      items: [
        { id: 'i1', kind: 'presentation', presentationId: p.id },
        { id: 'i2', kind: 'presentation', presentationId: a.id },
      ],
    },
    presentations: { [p.id]: p, [a.id]: a },
    media: {},
    fonts: [],
    looks: DEFAULT_LOOKS,
    files: [],
    manifestId: 'm',
  };
  let s = reduce(initialState(), { k: 'goLive', resolved });
  s = reduce(s, { k: 'go', cueIndex: 0, at: 1000 });
  return { s, p };
}

describe('stageLayout', () => {
  it('takes bands from the stage look and defaults for props', () => {
    const l = stageLayout(LOOK_STAGE);
    expect(l.current?.box).toEqual({ x: 60, y: 140, w: 1800, h: 520, rotation: 0 });
    expect(l.next?.style.fontSizePx).toBe(44);
    expect(l.clock?.box.x).toBe(60);
    expect(l.messages?.fill).toBeDefined();
    // Countdown and elapsed share the top right: stacked.
    expect(l.countdown!.box.y).toBeLessThan(l.elapsed!.box.y);
    expect(l.section?.fontSizePx).toBe(36);
  });
  it('respects look style boxes and disabled props', () => {
    const look: Look = {
      ...LOOK_STAGE,
      layers: {
        ...LOOK_STAGE.layers,
        props: {
          ...LOOK_STAGE.layers.props,
          elapsed: false,
          style: {
            clock: {
              ...(LOOK_STAGE.layers.slide.mode === 'lyricOnly'
                ? LOOK_STAGE.layers.slide.style
                : ({} as never)),
              box: { x: 1, y: 2, w: 3, h: 4, rotation: 0 },
            },
          },
        },
      },
    };
    const l = stageLayout(look);
    expect(l.clock?.box).toEqual({ x: 1, y: 2, w: 3, h: 4, rotation: 0 });
    expect(l.elapsed).toBeNull();
    expect(l.countdown?.box.h).toBe(110);
  });
  it('shows video remaining time with elapsed unless the look says otherwise', () => {
    expect(stageLayout(LOOK_STAGE).mediaRemaining).not.toBeNull();
    const props = LOOK_STAGE.layers.props;
    const withFlag = (p: Partial<typeof props>): Look => ({
      ...LOOK_STAGE,
      layers: { ...LOOK_STAGE.layers, props: { ...props, ...p } },
    });
    expect(stageLayout(withFlag({ elapsed: false })).mediaRemaining).toBeNull();
    expect(stageLayout(withFlag({ elapsed: false, mediaRemaining: true })).mediaRemaining).not.toBeNull();
    expect(stageLayout(withFlag({ elapsed: true, mediaRemaining: false })).mediaRemaining).toBeNull();
    const box = { x: 5, y: 6, w: 7, h: 8, rotation: 0 };
    const styled = withFlag({
      mediaRemaining: true,
      style: { mediaRemaining: { ...stageLayout(LOOK_STAGE).mediaRemaining!, box } },
    });
    expect(stageLayout(styled).mediaRemaining?.box).toEqual(box);
  });
  it('still shows lyrics for an authored look', () => {
    expect(stageLayout(LOOK_MAIN).current).not.toBeNull();
  });
  it('resolves the stage look', () => {
    expect(resolveStageLook('look-stage', [], DEFAULT_LOOKS).id).toBe('look-stage');
    expect(resolveStageLook('missing', undefined, DEFAULT_LOOKS).kind).toBe('stage');
    expect(resolveStageLook(undefined).id).toBe(LOOK_STAGE.id);
  });
});

describe('slide text', () => {
  it('shows current lyrics with section label and position, next slide below', () => {
    const { s } = live();
    const layout = stageLayout(LOOK_STAGE);
    const shown = s.layers.slide.content;
    expect(currentText(s, shown, layout)).toEqual({
      text: 'Line one\nLine two',
      label: 'Verse 1',
      position: '1/2',
    });
    expect(nextText(s, shown, layout)).toEqual({ text: 'Line three\nLine four' });
    const s2 = reduce(s, { k: 'next', at: 2000 });
    expect(nextText(s2, s2.layers.slide.content, layout)).toEqual({
      text: 'Sing it loud\nSing it proud',
      label: 'Chorus',
    });
  });
  it('labels the next item and shows non-song titles', () => {
    const { s } = live();
    const layout = stageLayout(LOOK_STAGE);
    let s3 = reduce(s, { k: 'go', cueIndex: 2, at: 3000 });
    expect(nextText(s3, s3.layers.slide.content, layout)).toEqual({
      text: 'Welcome',
      label: 'Next: Welcome',
    });
    s3 = reduce(s3, { k: 'next', at: 4000 });
    expect(currentText(s3, s3.layers.slide.content, layout)).toEqual({ text: 'Welcome' });
    const none = { ...layout, nonSong: 'none' as const };
    expect(currentText(s3, s3.layers.slide.content, none)).toBeNull();
  });
  it('skips hidden slides as Next does, and goes on from one a click showed (design/27 §9)', () => {
    const text = (id: string, t: string, hidden?: true) => ({
      id,
      objects: [
        {
          id: `${id}-t`,
          type: 'text' as const,
          text: t,
          box: { x: 0, y: 0, w: 1, h: 1, rotation: 0 },
          style: LOOK_MAIN as never,
          opacity: 1,
        },
      ],
      ...(hidden ? { hidden } : {}),
    });
    const deck: Presentation = {
      ...announcement(),
      sections: [
        {
          id: 'sa',
          label: 'Slides',
          short: 'S',
          slides: [
            text('a', 'Welcome'),
            text('h', 'Backup', true),
            text('b', 'Offering'),
            text('k', 'Spare', true),
          ],
        },
      ],
    };
    const after = { ...announcement(), id: 'after', title: 'Benediction' };
    const resolved: ResolvedPlaylist = {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'Sunday',
        items: [
          { id: 'i1', kind: 'presentation', presentationId: deck.id },
          { id: 'i2', kind: 'presentation', presentationId: after.id },
        ],
      },
      presentations: { [deck.id]: deck, [after.id]: after },
      media: {},
      fonts: [],
      looks: DEFAULT_LOOKS,
      files: [],
      manifestId: 'm',
    };
    const layout = stageLayout(LOOK_STAGE);
    let s = reduce(initialState(), { k: 'goLive', resolved });
    s = reduce(s, { k: 'go', cueIndex: 0, at: 1000 });
    expect(nextText(s, s.layers.slide.content, layout)).toEqual({ text: 'Offering' });
    s = reduce(s, { k: 'go', cueIndex: 1, at: 2000 });
    expect(currentText(s, s.layers.slide.content, layout)).toMatchObject({ text: 'Backup' });
    expect(nextText(s, s.layers.slide.content, layout)).toEqual({ text: 'Offering' });
    s = reduce(s, { k: 'next', at: 3000 });
    expect(s.layers.slide.content?.slideId).toBe('b');
    expect(nextText(s, s.layers.slide.content, layout)).toEqual({
      text: 'Benediction',
      label: 'Next: Benediction',
    });
  });
  it('nothing when cleared', () => {
    const { s } = live();
    const c = reduce(s, { k: 'clear', layer: 'slide', at: 5000 });
    expect(currentText(c, c.layers.slide.content, stageLayout(LOOK_STAGE))).toBeNull();
  });
  it('prefers the lyric object', () => {
    expect(
      slideText({
        id: 's',
        lyricObjectId: 'b',
        objects: [
          {
            id: 'a',
            type: 'text',
            text: 'Title',
            box: { x: 0, y: 0, w: 1, h: 1, rotation: 0 },
            style: LOOK_MAIN as never,
            opacity: 1,
          },
          {
            id: 'b',
            type: 'text',
            text: 'Lyric',
            box: { x: 0, y: 0, w: 1, h: 1, rotation: 0 },
            style: LOOK_MAIN as never,
            opacity: 1,
          },
        ],
      }),
    ).toBe('Lyric');
  });
  it('shows automatic verse numbers as text', () => {
    const box = { x: 0, y: 0, w: 1, h: 1, rotation: 0 };
    const verse = { bullet: { auto: 'arabicParenBoth', startAt: 16 } };
    expect(
      slideText({
        id: 's',
        objects: [
          {
            id: 'b',
            type: 'text',
            text: 'For God so loved the world\nFor God did not send his Son',
            box,
            style: LOOK_MAIN as never,
            opacity: 1,
            paras: [verse, verse],
          },
        ],
      }),
    ).toBe('(16)\u{a0}For God so loved the world\n(17)\u{a0}For God did not send his Son');
  });
});

describe('timers', () => {
  it('counts down to service time in the venue time zone', () => {
    const { s } = live();
    const now = Date.UTC(2026, 10, 8, 9, 50, 0);
    const t = reduce(s, {
      k: 'timer.start',
      timerId: SERVICE_COUNTDOWN_TIMER_ID,
      spec: { kind: 'countdownTo', timeOfDay: '10:00', label: 'Service' },
      at: now,
    });
    expect(countdownDisplay(t, now, 'UTC')).toEqual({
      label: 'Service',
      value: '10:00',
      running: true,
      overdue: false,
    });
    expect(countdownDisplay(t, now + 599_500, 'UTC')?.value).toBe('00:01');
    expect(countdownDisplay(t, now + 600_000, 'UTC')).toMatchObject({ value: '00:00', overdue: true });
    // Europe/London in November is UTC+0; America/New_York is UTC-5 so 10:00 local is 5 h away.
    expect(countdownDisplay(t, now, 'America/New_York')?.value).toBe('5:10:00');
    const stopped = reduce(t, { k: 'timer.stop', timerId: SERVICE_COUNTDOWN_TIMER_ID, at: now });
    expect(countdownDisplay(stopped, now, 'UTC')).toBeNull();
  });
  it('shows a running elapsed timer, then its frozen value', () => {
    const { s } = live();
    let t = reduce(s, { k: 'timer.start', timerId: 'e', spec: { kind: 'elapsed' }, at: 10_000 });
    expect(elapsedDisplay(t, 75_000)).toEqual({ label: 'Elapsed', value: '01:05', running: true });
    t = reduce(t, { k: 'timer.stop', timerId: 'e', at: 70_000 });
    expect(elapsedDisplay(t, 99_000)).toEqual({ label: 'Elapsed', value: '01:00', running: false });
    t = reduce(t, { k: 'timer.reset', timerId: 'e', at: 99_000 });
    expect(elapsedDisplay(t, 99_000)).toBeNull();
  });
});

describe('video remaining time', () => {
  function withVideo(durationMs?: number): LiveState {
    const resolved: ResolvedPlaylist = {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'x',
        items: [{ id: 'v', kind: 'media', mediaId: 'vid', loop: false }],
      },
      presentations: {},
      media: {
        vid: {
          id: 'vid',
          rev: 1,
          name: 'Welcome video',
          tags: [],
          kind: 'video',
          original: { hash: 'h', bytes: 1, mime: 'video/mp4', path: 'p' },
          state: 'ready',
          loop: false,
          isBackground: false,
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      },
      fonts: [],
      looks: DEFAULT_LOOKS,
      files: [],
      manifestId: 'm',
    };
    let s = reduce(initialState(), { k: 'goLive', resolved });
    s = reduce(s, { k: 'go', cueIndex: 0, at: 10_000 });
    return s;
  }

  it('counts down from the reducer position and the media duration', () => {
    const s = withVideo(90_000);
    expect(mediaRemainingDisplay(s, 10_000)).toEqual({
      label: 'Welcome video',
      value: '01:30',
      running: true,
      overdue: false,
    });
    expect(mediaRemainingDisplay(s, 40_500)?.value).toBe('01:00');
    expect(mediaRemainingDisplay(s, 99_200)?.value).toBe('00:01');
    expect(mediaRemainingDisplay(s, 120_000)).toMatchObject({ value: '00:00', overdue: true });
    // Paused: frozen at the pause position, dimmed.
    const paused = reduce(s, { k: 'media.pause', at: 30_000 });
    expect(mediaRemainingDisplay(paused, 80_000)).toMatchObject({ value: '01:10', running: false });
    const ended = reduce(s, { k: 'media.ended', cueIndex: 0, at: 100_000 });
    expect(mediaRemainingDisplay(ended, 100_000)).toMatchObject({ value: '00:00', overdue: true });
  });

  it('wraps for looping videos and hides when there is nothing to show', () => {
    const s = withVideo(10_000);
    const looping = {
      ...s,
      layers: {
        ...s.layers,
        media: { ...s.layers.media, content: { ...s.layers.media.content!, loop: true } },
      },
    };
    expect(mediaRemainingDisplay(looping, 23_000)?.value).toBe('00:07');
    expect(mediaRemainingDisplay(withVideo(undefined), 11_000)).toBeNull();
    expect(mediaRemainingDisplay(initialState(), 0)).toBeNull();
    expect(mediaRemainingDisplay(reduce(s, { k: 'clear', layer: 'media', at: 11_000 }), 12_000)).toBeNull();
    const image = {
      ...s,
      layers: {
        ...s.layers,
        media: { ...s.layers.media, content: { ...s.layers.media.content!, mediaKind: 'image' as const } },
      },
    };
    expect(mediaRemainingDisplay(image, 11_000)).toBeNull();
    // A clock behind the hub (now before startedAt) shows the full length rather than more than it.
    expect(mediaRemainingDisplay(s, 9_000)?.value).toBe('00:10');
  });

  it("counts down a slide's own video playing in its box, from F8 for a click start (design/27 §8)", () => {
    const base = withVideo(20_000);
    const deck: Presentation = {
      id: 'talk',
      rev: 1,
      title: 'Talk',
      kind: 'slides',
      meta: { tags: [] },
      sections: [
        {
          id: 's',
          label: 'S',
          short: 'S',
          slides: [
            {
              id: 'clip',
              objects: [
                {
                  id: 'box',
                  type: 'image',
                  box: { x: 100, y: 100, w: 800, h: 450, rotation: 0 },
                  mediaId: 'vid',
                  fit: 'contain',
                  opacity: 1,
                  radius: 0,
                  play: { mediaId: 'vid', start: 'click' },
                },
              ],
            },
          ],
        },
      ],
      arrangements: [],
      archived: false,
    };
    const resolved: ResolvedPlaylist = {
      ...base.resolved!,
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'x',
        items: [{ id: 't', kind: 'presentation', presentationId: 'talk' }],
      },
      presentations: { talk: deck },
    };
    let s = reduce(initialState(), { k: 'goLive', resolved });
    s = reduce(s, { k: 'go', cueIndex: 0, at: 10_000 });
    expect(s.layers.media.content).toMatchObject({ objectId: 'box', state: 'paused' });
    expect(mediaRemainingDisplay(s, 15_000)).toMatchObject({ value: '00:20', running: false });
    s = reduce(s, { k: 'media.play', at: 16_000 });
    expect(mediaRemainingDisplay(s, 21_000)).toMatchObject({ value: '00:15', running: true });
  });
});

describe('messages', () => {
  const m = (id: string, text: string, expiresAt?: number) => ({ id, text, sentAt: 0, expiresAt });
  it('filters expired messages and finds the next expiry', () => {
    const list = [m('a', 'A', 5000), m('b', 'B'), m('c', 'C', 3000)];
    expect(activeMessages(list, 4000).map((x) => x.id)).toEqual(['a', 'b']);
    expect(nextExpiry(list, 1000)).toBe(3000);
    expect(nextExpiry(list, 6000)).toBeUndefined();
  });
  it('fades new messages in and removed ones out for 1 s', () => {
    let shown = reconcileMessages([], [m('a', 'A')], 0);
    expect(shown).toEqual([{ id: 'a', text: 'A', phase: 'in', since: 0 }]);
    shown = reconcileMessages(shown, [m('b', 'B'), m('a', 'A')], 100);
    expect(shown.map((x) => x.id)).toEqual(['b', 'a']);
    shown = reconcileMessages(shown, [m('b', 'B')], 200);
    expect(shown.map((x) => `${x.id}:${x.phase}`)).toEqual(['b:in', 'a:out']);
    shown = reconcileMessages(shown, [m('b', 'B')], 900);
    expect(shown.find((x) => x.id === 'a')?.since).toBe(200);
    shown = reconcileMessages(shown, [m('b', 'B')], 1200);
    expect(shown.map((x) => x.id)).toEqual(['b']);
  });
  it('keeps object identity when nothing changes', () => {
    const shown = reconcileMessages([], [m('a', 'A')], 0);
    expect(reconcileMessages(shown, [m('a', 'A')], 50)[0]).toBe(shown[0]);
  });
});

describe('flip and frames', () => {
  it('delays flips until `at`', () => {
    expect(flipDelay(1033, 1000)).toBe(33);
    expect(flipDelay(900, 1000)).toBe(0);
  });
  it('counts presented frames and missed vsyncs', () => {
    const f = new FrameStats();
    let t = 0;
    for (let i = 0; i < 60; i++) f.frame((t += 1000 / 60));
    expect(f.presented).toBe(60);
    expect(f.missed).toBe(0);
    f.frame((t += (1000 / 60) * 3));
    expect(f.missed).toBe(2);
    f.frame((t += 5000)); // hidden tab: ignored
    expect(f.missed).toBe(2);
    expect(f.fps).toBeLessThanOrEqual(61);
  });
  it('adapts to a 30 Hz display', () => {
    const f = new FrameStats();
    let t = 0;
    for (let i = 0; i < 120; i++) f.frame((t += 1000 / 30));
    // A few misses while the interval estimate settles, none after.
    const settled = f.missed;
    for (let i = 0; i < 60; i++) f.frame((t += 1000 / 30));
    expect(f.missed).toBe(settled);
  });
});

describe('textCss', () => {
  it('maps outline, shadow and fill', () => {
    const css = textCss({
      fontFamily: 'Inter',
      fontWeight: 700,
      fontStyle: 'normal',
      fontSizePx: 72,
      color: { r: 255, g: 255, b: 255, a: 1 },
      align: 'left',
      valign: 'bottom',
      lineHeight: 1.2,
      letterSpacing: 0,
      padding: 10,
      transform: 'uppercase',
      outline: { width: 3, color: { r: 0, g: 0, b: 0, a: 1 } },
      shadow: { dx: 0, dy: 4, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      fill: { color: { r: 1, g: 2, b: 3, a: 1 }, radius: 8 },
    });
    expect(css).toMatchObject({
      fontSize: '72px',
      justifyContent: 'flex-end',
      WebkitTextStroke: '6px rgba(0,0,0,1)',
      textShadow: '0px 4px 12px rgba(0,0,0,0.5)',
      background: 'rgba(1,2,3,1)',
      textTransform: 'uppercase',
      borderRadius: '8px',
    });
  });
});

// ---- M4 item G (design/27 §11 item 13, §6 "Bands, stage and readable text") ----------------------------

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });

/** The stage look with the notes region on, optionally with a `style['notes']` box. */
function notesLook(styled?: { x: number; y: number; w: number; h: number; rotation: number }): Look {
  const props = LOOK_STAGE.layers.props;
  const notes = styled ? { ...defaultNotes('Inter', undefined, undefined), box: styled } : undefined;
  return {
    ...LOOK_STAGE,
    layers: {
      ...LOOK_STAGE.layers,
      props: { ...props, notes: true, style: notes ? { ...props.style, notes } : props.style },
    },
  };
}

/** A sermon presentation: a slide with notes, one without, one with notes and an English and a Hebrew line. */
function sermon(notes: (string | undefined)[]): Presentation {
  return {
    id: 'sermon',
    rev: 1,
    title: 'Sermon',
    kind: 'slides',
    meta: { tags: [] },
    sections: [
      {
        id: 'ss',
        label: 'Slides',
        short: 'S',
        slides: notes.map((n, i) => ({
          id: `s${i}`,
          objects: [
            {
              id: `t${i}`,
              type: 'text' as const,
              text: i === 2 ? 'Peace be with you\nשלום עליכם!' : `Point ${i + 1}`,
              box: box(0, 0, 100, 100),
              style: LOOK_MAIN as never,
              opacity: 1,
            },
          ],
          ...(n === undefined ? {} : { notes: n }),
        })),
      },
    ],
    arrangements: [],
    archived: false,
  };
}

function liveSermon(notes: (string | undefined)[]): LiveState {
  const p = sermon(notes);
  const resolved: ResolvedPlaylist = {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'Sunday',
      items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }],
    },
    presentations: { [p.id]: p },
    media: {},
    fonts: [],
    looks: DEFAULT_LOOKS,
    files: [],
    manifestId: 'm',
  };
  const s = reduce(initialState(), { k: 'goLive', resolved });
  return reduce(s, { k: 'go', cueIndex: 0, at: 1000 });
}

const view = (state: LiveState, look: Look) =>
  buildView({
    state,
    ready: true,
    shown: state.layers.slide.content,
    layout: stageLayout(look),
    general: { timeZone: 'UTC', clock24h: true },
    bus: 'hub',
    now: 2000,
    clockOffset: 0,
    clockFallback: false,
  });

describe('the notes region (PropsRule.notes)', () => {
  it('is off unless the look turns it on, as stored looks have it', () => {
    expect(stageLayout(LOOK_STAGE).notes).toBeNull();
    expect(stageLayout(notesLook()).notes).not.toBeNull();
    const off = notesLook();
    off.layers.props.notes = false;
    expect(stageLayout(off).notes).toBeNull();
  });

  it('sits under the next-slide band by default, at least two lines high, clear of the current lyrics', () => {
    const l = stageLayout(notesLook());
    const n = l.notes!;
    const next = l.next!.box;
    // The stage look's next band ends at 960: the notes take the rest of the screen above a margin.
    expect(n.box.x).toBe(next.x);
    expect(n.box.w).toBe(next.w);
    expect(n.box.y + n.box.h).toBe(1080 - 16);
    expect(n.box.h).toBeGreaterThanOrEqual(2 * n.fontSizePx * n.lineHeight + 2 * n.padding);
    expect(n.box.y).toBeGreaterThanOrEqual(next.y + next.h - n.box.h);
    expect(overlaps(n.box, l.current!.box)).toBe(false);
    // Smaller than the lyrics, top aligned so long notes are cut at their end, never at their start.
    expect(n.fontSizePx).toBeLessThan(l.next!.style.fontSizePx);
    expect(n.valign).toBe('top');
    expect(stageFontFamilies(l).has(n.fontFamily)).toBe(true);
  });

  it('goes under the current band when the look has no next-slide band', () => {
    const look = notesLook();
    const rule = look.layers.slide;
    if (rule.mode !== 'lyricOnly') throw new Error('stage look');
    look.layers.slide = { ...rule, nextSlide: undefined };
    const l = stageLayout(look);
    expect(l.notes!.box.y).toBe(rule.band.y + rule.band.h + 12);
    expect(l.notes!.box.y + l.notes!.box.h).toBe(1064);
  });

  it('uses the look’s own box, cut so that it never covers the current lyrics', () => {
    // Clear of the lyrics (current band 60,140 1800x520): kept as it is.
    expect(stageLayout(notesLook(box(60, 700, 900, 300))).notes!.box).toEqual(box(60, 700, 900, 300));
    // Over the lyrics' bottom: only the part below them is kept.
    expect(stageLayout(notesLook(box(60, 600, 1800, 400))).notes!.box).toEqual(box(60, 660, 1800, 340));
    // Over their top right: the larger free part (above them) wins; the strip on the right is too narrow.
    expect(stageLayout(notesLook(box(1000, 0, 920, 700))).notes!.box).toEqual(box(1000, 0, 920, 140));
    // Inside the lyrics: no notes at all rather than notes over the lyrics.
    expect(stageLayout(notesLook(box(100, 200, 800, 300))).notes).toBeNull();
  });

  it('never overlaps the current lyrics and stays inside the box the look gives (property)', () => {
    const cur = stageLayout(LOOK_STAGE).current!.box;
    fc.assert(
      fc.property(
        fc.integer({ min: -200, max: 2000 }),
        fc.integer({ min: -200, max: 1200 }),
        fc.integer({ min: 1, max: 2200 }),
        fc.integer({ min: 1, max: 1300 }),
        (x, y, w, h) => {
          const n = stageLayout(notesLook(box(x, y, w, h))).notes;
          if (!n) return;
          expect(overlaps(n.box, cur)).toBe(false);
          expect(n.box.x).toBeGreaterThanOrEqual(x);
          expect(n.box.y).toBeGreaterThanOrEqual(y);
          expect(n.box.x + n.box.w).toBeLessThanOrEqual(x + w);
          expect(n.box.y + n.box.h).toBeLessThanOrEqual(y + h);
          // A box that had to be cut keeps at least one line.
          if (overlaps(box(x, y, w, h), cur))
            expect(n.box.h).toBeGreaterThanOrEqual(n.fontSizePx * n.lineHeight);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('clearOf keeps a box that only touches, and drops parts smaller than asked', () => {
    const a = box(0, 0, 100, 100);
    expect(clearOf(box(0, 100, 100, 50), a, 10, 10)).toEqual(box(0, 100, 100, 50));
    expect(clearOf(box(0, 90, 100, 15), a, 10, 10)).toBeNull();
    expect(clearOf(box(0, 90, 100, 15), a, 10, 5)).toEqual(box(0, 100, 100, 5));
    expect(clearOf(box(0, 0, 10, 10), undefined, 10, 10)).toEqual(box(0, 0, 10, 10));
  });
});

describe('the notes the stage shows', () => {
  it('are the displayed slide’s notes, following the live slide', () => {
    let s = liveSermon(['Greet the guests.', undefined, 'Pray for the Smiths.']);
    const look = notesLook();
    expect(view(s, look).notes).toBe('Greet the guests.');
    s = reduce(s, { k: 'next', at: 2000 });
    expect(view(s, look).notes).toBeNull();
    s = reduce(s, { k: 'next', at: 3000 });
    expect(view(s, look).notes).toBe('Pray for the Smiths.');
    expect(notesText(s, s.layers.slide.content)).toBe('Pray for the Smiths.');
    // Not in the view when the look shows none, nor when the slide layer is cleared.
    expect(view(s, LOOK_STAGE).notes).toBeNull();
    const c = reduce(s, { k: 'clear', layer: 'slide', at: 4000 });
    expect(view(c, look).notes).toBeNull();
  });

  it('show for non-song slides when the look shows no non-song text', () => {
    const s = liveSermon(['Ask for volunteers.']);
    const look = notesLook();
    const rule = look.layers.slide;
    if (rule.mode !== 'lyricOnly') throw new Error('stage look');
    look.layers.slide = { ...rule, nonSong: 'none' };
    const v = view(s, look);
    expect(v.current).toBeNull();
    expect(v.notes).toBe('Ask for volunteers.');
  });

  it('are tidied: line ends, trailing spaces and runs of blank lines', () => {
    expect(cutNotes('  One  \r\nTwo\r\r\n\n\n\nThree \t\n')).toBe('One\nTwo\n\nThree');
    expect(cutNotes('   \n\n ')).toBeNull();
    expect(cutNotes(undefined)).toBeNull();
    expect(cutNotes(42)).toBeNull();
  });

  it('are cut to a bound at a word, with an ellipsis, however long they are', () => {
    const words = Array.from({ length: 60_000 }, (_, i) => `word${i}`).join(' ');
    const t = cutNotes(words)!;
    expect(t.length).toBeLessThanOrEqual(NOTES_MAX + 1);
    expect(t.endsWith('…')).toBe(true);
    expect(words.startsWith(t.slice(0, -1))).toBe(true);
    expect(words[t.length - 1]).toBe(' ');
    // A note of 200,000 characters costs no more than a long one.
    const huge = 'x'.repeat(200_000);
    const started = performance.now();
    for (let i = 0; i < 100; i++) cutNotes(huge);
    expect(performance.now() - started).toBeLessThan(500);
    expect(cutNotes(huge)!.length).toBe(NOTES_MAX + 1);
    // Never inside a surrogate pair.
    const emoji = 'a'.repeat(NOTES_MAX - 1) + '🙏'.repeat(4);
    const e = cutNotes(emoji)!;
    expect(e).toBe(`${'a'.repeat(NOTES_MAX - 1)}…`);
    // Long only in blank space read: the cut is still marked.
    expect(cutNotes(`Amen${' \n'.repeat(NOTES_MAX * 3)}and more`)).toBe('Amen…');
  });
});

describe('stage text direction (design/27 §6)', () => {
  it('splits text into its paragraphs as readableText keeps them, verse numbers in front', () => {
    const verse = { bullet: { auto: 'arabicPeriod', startAt: 16 } };
    const text = slideText({
      id: 's',
      objects: [
        {
          id: 'b',
          type: 'text',
          text: 'For God so loved the world\nבְּרֵאשִׁית בָּרָא אֱלֹהִים.\n\nAmen',
          box: box(0, 0, 1, 1),
          style: LOOK_MAIN as never,
          opacity: 1,
          paras: [verse, verse, null, null],
        },
      ],
    });
    expect(stageParagraphs(text)).toEqual([
      '16.\u{a0}For God so loved the world',
      '17.\u{a0}בְּרֵאשִׁית בָּרָא אֱלֹהִים.',
      '',
      'Amen',
    ]);
    expect(stageParagraphs('')).toEqual(['']);
  });

  it('carries the current, next and notes text paragraph by paragraph, a Hebrew line included', () => {
    let s = liveSermon(['One', 'Two', 'שלום\nPeace']);
    s = reduce(s, { k: 'go', cueIndex: 1, at: 2000 });
    const v = view(s, notesLook());
    expect(stageParagraphs(v.next!.text)).toEqual(['Peace be with you', 'שלום עליכם!']);
    s = reduce(s, { k: 'next', at: 3000 });
    const w = view(s, notesLook());
    expect(stageParagraphs(w.current!.text)).toEqual(['Peace be with you', 'שלום עליכם!']);
    expect(stageParagraphs(w.notes!)).toEqual(['שלום', 'Peace']);
  });
});

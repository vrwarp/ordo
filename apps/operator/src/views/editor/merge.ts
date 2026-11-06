import { ApiFailure } from '@ordo/client';
import { type Arrangement, Presentation, type Section, type Slide, type SlideObject } from '@ordo/domain';

/*
 * Three-way merge on a save conflict (design/27 §11 item 17, optional in M4; M4 item H). When the hub refuses a
 * save with 409 (someone else saved since the editor's base), the editor merges instead of offering only
 * "Reload theirs" or "Save mine anyway":
 * - base = the version the editor opened or last saved (`EditorState.base`),
 * - mine = the draft,
 * - theirs = the 409 body's `current` (`ApiFailure.details.current`, `theirsOf`),
 * so two volunteers editing different slides, or a volunteer and the hub's version-2 patch, do not overwrite
 * each other. `lib/pptxImport.ts` `rebaseOnJobs` is the special case already built for the PowerPoint jobs.
 *
 * The rules, level by level (every comparison is of JSON content: key order and keys holding `undefined` do
 * not count, so a draft built by the editor's ops and a version parsed from the hub compare equal):
 * - A value only one side changed takes that side's value; one both changed to the same value is kept; one
 *   both changed differently is a conflict.
 * - Presentation fields follow that rule field by field (`meta` and `source` per field inside, `meta.tags`
 *   as a set). The merge carries theirs' `rev` (and timestamps), so it saves on top of their version.
 * - Sections: their name, short name and chords per field. A section added on either side is kept; one
 *   deleted on one side goes when the other side did not rename it, and the slides it held follow the
 *   slide rule. A slide left in a section that went is a conflict.
 * - Slides, by id: one only one side changed takes that side's version; one both changed merges field by
 *   field (`pptx` per field inside, `overrides` as a set) and object by object. Added slides are kept;
 *   a slide deleted on one side goes when the other did not change it (a move is not a change), else it
 *   is a conflict. Its section follows the side that moved it.
 * - Objects, by id, are whole: one both changed differently is a conflict; added ones are kept; deleted ones
 *   go when the other side did not change them. A slide's lyric box that went is cleared.
 * - Orders (sections, the slides of each section, the objects of each slide, arrangements) follow the side
 *   that reordered them; both reordering the same list differently is a conflict. What one side added is
 *   placed after the item it follows on that side (mine's after theirs' at the same place, so an object I
 *   added stays on top).
 * - Arrangements, by id: the name per field, the section list merged as a sequence (diff3: both adding
 *   sections at the same place keeps both, theirs first); entries of sections that went are dropped.
 * Duplicate ids (a damaged presentation) are not merged.
 */

/** Where the two sides changed the same thing differently. */
export type MergeConflict = {
  level: 'presentation' | 'section' | 'slide' | 'object';
  /**
   * The presentation field ('title', 'meta.author', 'sections' for the section order, 'arrangements' for
   * their order, 'arrangements.<id>' for one), the section, slide or object id concerned, with '.<field>'
   * for a section or slide field ('<slide id>.notes').
   */
  key: string;
  slideId?: string;
  objectId?: string;
  /** What to tell the volunteer, e.g. "Slide 4: both changed the text box “Welcome”". */
  what: string;
};

/**
 * The outcome: `merged` (carrying `theirs.rev`, so it saves on top of their version) when every change of the
 * two sides fits together, else the conflicts, and the editor's dialog says what it could not merge and
 * keeps today's two choices.
 */
export type MergeResult =
  | { merged: Presentation; conflicts: [] }
  | { merged?: undefined; conflicts: MergeConflict[] };

/**
 * Merge mine and theirs over base, at slide and object level: a slide (or object) only one side changed takes
 * that side's version; one both changed identically is kept; one both changed differently is a conflict
 * (unless the changes are to different objects of it, which merge object by object). Slides added on either
 * side are kept, slides deleted on one side and unchanged on the other go, section and slide order follow
 * the side that changed it. Presentation fields follow the same rule field by field. The rules in full are at
 * the top of this file. A merge that would not be a valid presentation (too many slides, say) is a conflict.
 */
export function mergeThreeWay(base: Presentation, mine: Presentation, theirs: Presentation): MergeResult {
  return prepareMerge(base, theirs)(mine, true);
}

const INVALID: MergeConflict = {
  level: 'presentation',
  key: '',
  what: 'Together the two versions would be too large or not valid.',
};

/**
 * `mergeThreeWay` with base and theirs fixed, for merging several drafts onto the same version (the editor
 * moves its undo steps too): what theirs changed is found once and remembered. The result is validated only
 * when `validate` is set (as `mergeThreeWay` does).
 */
export function prepareMerge(
  base: Presentation,
  theirs: Presentation,
): (mine: Presentation, validate?: boolean) => MergeResult {
  const b = indexOf(base);
  const t = indexOf(theirs);
  const unchanged = new Map<string, boolean>();
  /** theirs' value under `key` is base's (remembered: theirs and base are fixed). */
  const theirsKept = (key: string, tv: unknown, bv: unknown): boolean => {
    let v = unchanged.get(key);
    if (v === undefined) {
      v = same(tv, bv);
      unchanged.set(key, v);
    }
    return v;
  };
  return (mine, validate = false) => {
    const m = indexOf(mine);
    if (!b || !t || !m) return { conflicts: [DUPLICATES] };
    const r = new Merge(base, mine, theirs, b, m, t, theirsKept).run();
    if (!validate || !r.merged || Presentation.safeParse(r.merged).success) return r;
    return { conflicts: [INVALID] };
  };
}

/**
 * The version that won a 409 save (`ApiFailure.details.current`), validated as a presentation, so a hub of
 * another version or a damaged body never reaches the merge; undefined otherwise.
 */
export function theirsOf(e: unknown): Presentation | undefined {
  if (!(e instanceof ApiFailure) || e.status !== 409) return undefined;
  const parsed = Presentation.safeParse(e.details?.current);
  return parsed.success ? parsed.data : undefined;
}

// ---- JSON equality ---------------------------------------------------------------------------------------

/**
 * The same JSON: objects compared key by key whatever their order, a key holding `undefined` as absent, and
 * `undefined` and `null` alike inside arrays (as `JSON.stringify` writes them).
 */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] ?? null;
      const y = b[i] ?? null;
      if (!same(x, y)) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  let n = 0;
  for (const k in ra) {
    if (!Object.hasOwn(ra, k) || ra[k] === undefined) continue;
    if (!same(ra[k], rb[k])) return false;
    n++;
  }
  for (const k in rb) if (Object.hasOwn(rb, k) && rb[k] !== undefined) n--;
  return n === 0;
}

// ---- the merge ---------------------------------------------------------------------------------------------

type Side = 'mine' | 'theirs';
/** An id in a remembered key: quoted, so ids holding dots or quotes cannot meet. */
const q = (id: string) => JSON.stringify(id);
const WHO: Record<Side, string> = { mine: 'you', theirs: 'they' };
const other = (s: Side): Side => (s === 'mine' ? 'theirs' : 'mine');

const DUPLICATES: MergeConflict = {
  level: 'presentation',
  key: '',
  what: 'The presentation repeats a slide, section or object id, so the two versions cannot be combined.',
};

/** A presentation's sections, slides and arrangements by id; undefined when an id repeats. */
type Index = {
  sections: Map<string, Section>;
  sectionOrder: string[];
  /** Each slide with its section and its number (1-based, in authoring order, as the slide list shows it). */
  slides: Map<string, { slide: Slide; section: string; n: number }>;
  slidesIn: Map<string, string[]>;
  arrangements: Map<string, Arrangement>;
  arrangementOrder: string[];
};

function indexOf(p: Presentation): Index | undefined {
  const ix: Index = {
    sections: new Map(),
    sectionOrder: [],
    slides: new Map(),
    slidesIn: new Map(),
    arrangements: new Map(),
    arrangementOrder: [],
  };
  let n = 0;
  for (const sec of p.sections) {
    if (ix.sections.has(sec.id)) return undefined;
    ix.sections.set(sec.id, sec);
    ix.sectionOrder.push(sec.id);
    const ids: string[] = [];
    for (const sl of sec.slides) {
      if (ix.slides.has(sl.id) || !uniqueIds(sl.objects)) return undefined;
      ix.slides.set(sl.id, { slide: sl, section: sec.id, n: ++n });
      ids.push(sl.id);
    }
    ix.slidesIn.set(sec.id, ids);
  }
  for (const a of p.arrangements) {
    if (ix.arrangements.has(a.id)) return undefined;
    ix.arrangements.set(a.id, a);
    ix.arrangementOrder.push(a.id);
  }
  return ix;
}

function uniqueIds(list: readonly { id: string }[]): boolean {
  return new Set(list.map((x) => x.id)).size === list.length;
}

/** Presentation fields the merge handles itself (structure) or takes from theirs (what the hub writes). */
const STRUCTURE = new Set(['sections', 'arrangements', 'rev', 'createdAt', 'updatedAt']);
/** How a field is merged when both sides changed it: per field inside, or as a set of strings. */
type Deep = Record<string, 'fields' | 'set'>;
const PRESENTATION_DEEP: Deep = { meta: 'fields', source: 'fields', 'meta.tags': 'set' };
const SLIDE_DEEP: Deep = { pptx: 'fields', overrides: 'set' };
const SECTION_DEEP: Deep = {};

const PRESENTATION_FIELDS: Record<string, string> = {
  title: 'the title',
  kind: 'the kind',
  meta: 'the details',
  'meta.author': 'the author',
  'meta.ccli': 'the CCLI number',
  'meta.copyright': 'the copyright',
  'meta.key': 'the key',
  'meta.tempo': 'the tempo',
  'meta.tags': 'the tags',
  folderId: 'the folder',
  themeId: 'the theme',
  backgroundMediaId: 'the default background',
  transition: 'the default transition',
  loop: 'the loop timing',
  linesPerSlide: 'the lines per slide',
  source: 'where it was imported from',
  archived: 'whether it is archived',
};
const SLIDE_FIELDS: Record<string, string> = {
  lyricObjectId: 'which box is the lyric box',
  backgroundMediaId: 'the background',
  clearBackground: 'whether it clears the background',
  durationMs: 'the timing',
  notes: 'the notes',
  overrides: 'what differs from the theme',
  hidden: 'whether it is hidden',
  transition: 'the transition',
  pptx: 'the PowerPoint settings',
  imported: 'the PowerPoint picture',
  scripture: 'the scripture',
  audio: 'the sound',
};
const SECTION_FIELDS: Record<string, string> = {
  label: 'its name',
  short: 'its short name',
  chords: 'its chords',
};

type Pick<T> = { ok: true; value: T } | { ok: false };

class Merge {
  readonly conflicts: MergeConflict[] = [];

  constructor(
    private readonly base: Presentation,
    private readonly mine: Presentation,
    private readonly theirs: Presentation,
    private readonly b: Index,
    private readonly m: Index,
    private readonly t: Index,
    /** theirs' value is base's, remembered under `key` across the drafts merged onto the same version. */
    private readonly theirsKept: (key: string, tv: unknown, bv: unknown) => boolean,
  ) {}

  run(): MergeResult {
    const out = this.fields(
      this.base as Record<string, unknown>,
      this.mine as Record<string, unknown>,
      this.theirs as Record<string, unknown>,
      'p',
      PRESENTATION_DEEP,
      STRUCTURE,
      (key) => ({
        level: 'presentation',
        key,
        what: `Presentation: both changed ${fieldName(PRESENTATION_FIELDS, key)}`,
      }),
    );
    out.rev = this.theirs.rev;
    for (const k of ['createdAt', 'updatedAt'] as const)
      if (this.theirs[k] === undefined) delete out[k];
      else out[k] = this.theirs[k];
    const sections = this.sections();
    const slides = this.slides();
    const arrangements = this.arrangements(sections);
    if (this.conflicts.length || !sections || !slides || !arrangements) return { conflicts: this.conflicts };
    // Slides one side added or moved into a section the other side deleted.
    for (const [id, s] of slides) {
      if (sections.meta.has(s.section)) continue;
      const gone: Side = this.m.sections.has(s.section) ? 'theirs' : 'mine';
      const sec =
        this.b.sections.get(s.section) ?? this.m.sections.get(s.section) ?? this.t.sections.get(s.section);
      this.conflicts.push({
        level: 'slide',
        key: id,
        slideId: id,
        what: `${this.slideName(id)}: ${WHO[other(gone)]} put it in the section “${clip(sec?.label ?? '')}”, which ${WHO[gone]} deleted`,
      });
    }
    // The slides of each section, in order.
    const placed: Section[] = [];
    const bySection = new Map<string, Set<string>>();
    for (const [id, s] of slides) {
      const set = bySection.get(s.section) ?? new Set<string>();
      set.add(id);
      bySection.set(s.section, set);
    }
    for (const secId of sections.order) {
      const keep = bySection.get(secId) ?? new Set<string>();
      const order = mergeOrder(
        this.b.slidesIn.get(secId) ?? [],
        this.m.slidesIn.get(secId) ?? [],
        this.t.slidesIn.get(secId) ?? [],
        keep,
      );
      const meta = sections.meta.get(secId)!;
      if (!order) {
        this.conflicts.push({
          level: 'section',
          key: secId,
          what: `Section “${clip(meta.label)}”: both changed the order of its slides`,
        });
        continue;
      }
      placed.push({ ...meta, slides: order.map((id) => slides.get(id)!.slide) } as Section);
    }
    if (this.conflicts.length) return { conflicts: this.conflicts };
    out.sections = placed;
    out.arrangements = arrangements;
    return { merged: out as Presentation, conflicts: [] };
  }

  // ---- fields ----

  /**
   * The three-way rule on one value. Theirs' comparison with base is remembered under `key`; mine is compared
   * by reference first (the editor's ops keep what they do not change).
   */
  private pick<T>(key: string, bv: T, mv: T, tv: T): Pick<T> {
    if (this.theirsKept(key, tv, bv)) return { ok: true, value: mv };
    if (mv === bv || same(mv, bv)) return { ok: true, value: tv };
    if (same(mv, tv)) return { ok: true, value: mv };
    return { ok: false };
  }

  /**
   * A record merged field by field (`skip` left out, `deep` fields merged inside); a field both changed
   * differently is reported through `conflict`. Fields keep mine's order, theirs' new ones after.
   */
  private fields(
    bv: Record<string, unknown> | undefined,
    mv: Record<string, unknown> | undefined,
    tv: Record<string, unknown> | undefined,
    key: string,
    deep: Deep,
    skip: ReadonlySet<string>,
    conflict: (field: string) => MergeConflict,
    prefix = '',
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const names = new Set([...Object.keys(mv ?? {}), ...Object.keys(tv ?? {}), ...Object.keys(bv ?? {})]);
    for (const k of names) {
      if (skip.has(k)) continue;
      const path = prefix + k;
      const v = this.field(bv?.[k], mv?.[k], tv?.[k], `${key}.${k}`, path, deep, conflict);
      if (v.ok && v.value !== undefined) out[k] = v.value;
    }
    return out;
  }

  private field(
    bv: unknown,
    mv: unknown,
    tv: unknown,
    key: string,
    path: string,
    deep: Deep,
    conflict: (field: string) => MergeConflict,
  ): Pick<unknown> {
    const v = this.pick(key, bv, mv, tv);
    if (v.ok) return v;
    const how = deep[path];
    if (how === 'fields' && isRecord(mv) && isRecord(tv) && (bv === undefined || isRecord(bv))) {
      const before = this.conflicts.length;
      const value = this.fields(bv, mv, tv, key, deep, new Set(), conflict, `${path}.`);
      return this.conflicts.length === before ? { ok: true, value } : { ok: false };
    }
    if (how === 'set' && isStrings(mv) && isStrings(tv) && (bv === undefined || isStrings(bv)))
      return { ok: true, value: mergeSet(bv ?? [], mv, tv) };
    this.conflicts.push(conflict(path));
    return { ok: false };
  }

  // ---- sections ----

  /** The sections that stay (without their slides) and their order; undefined after a conflict. */
  private sections(): { meta: Map<string, Omit<Section, 'slides'>>; order: string[] } | undefined {
    const meta = new Map<string, Omit<Section, 'slides'>>();
    const noSlides = new Set(['slides']);
    const ids = union(this.b.sectionOrder, this.m.sectionOrder, this.t.sectionOrder);
    const before = this.conflicts.length;
    for (const id of ids) {
      const bs = this.b.sections.get(id);
      const ms = this.m.sections.get(id);
      const ts = this.t.sections.get(id);
      const name = clip((ms ?? ts ?? bs)!.label);
      const conflict = (field: string): MergeConflict => ({
        level: 'section',
        key: `${id}.${field}`,
        what: `Section “${name}”: both changed ${SECTION_FIELDS[field] ?? field}`,
      });
      if (bs && (!ms || !ts)) {
        // Deleted on one side: it goes unless the other side changed it (its slides follow the slide rule).
        const kept = ms ? 'mine' : ts ? 'theirs' : undefined;
        if (!kept) continue;
        const k = (ms ?? ts)!;
        const changed =
          kept === 'theirs'
            ? !this.theirsKept(`s${q(id)}.meta`, sectionMeta(k), sectionMeta(bs))
            : !same(sectionMeta(k), sectionMeta(bs));
        if (changed)
          this.conflicts.push({
            level: 'section',
            key: id,
            what: `Section “${name}”: ${WHO[other(kept)]} deleted it and ${WHO[kept]} changed it`,
          });
        continue;
      }
      if (!bs) {
        // Added: kept (both adding the same id differently cannot be merged).
        if (ms && ts && !same(sectionMeta(ms), sectionMeta(ts)))
          this.conflicts.push({
            level: 'section',
            key: id,
            what: `Section “${name}”: both added it differently`,
          });
        else meta.set(id, sectionMeta((ms ?? ts)!));
        continue;
      }
      const merged = this.fields(
        bs as unknown as Record<string, unknown>,
        ms as unknown as Record<string, unknown>,
        ts as unknown as Record<string, unknown>,
        `s${q(id)}`,
        SECTION_DEEP,
        noSlides,
        conflict,
      );
      meta.set(id, { ...merged, id } as Omit<Section, 'slides'>);
    }
    const order = mergeOrder(
      this.b.sectionOrder,
      this.m.sectionOrder,
      this.t.sectionOrder,
      new Set(meta.keys()),
    );
    if (!order)
      this.conflicts.push({
        level: 'presentation',
        key: 'sections',
        what: 'Both changed the order of the sections',
      });
    return this.conflicts.length === before && order ? { meta, order } : undefined;
  }

  // ---- slides ----

  /** The slides that stay, each with its section; undefined after a conflict. */
  private slides(): Map<string, { slide: Slide; section: string }> | undefined {
    const out = new Map<string, { slide: Slide; section: string }>();
    const before = this.conflicts.length;
    const ids = union([...this.b.slides.keys()], [...this.m.slides.keys()], [...this.t.slides.keys()]);
    for (const id of ids) {
      const bs = this.b.slides.get(id);
      const ms = this.m.slides.get(id);
      const ts = this.t.slides.get(id);
      const name = this.slideName(id);
      if (bs && (!ms || !ts)) {
        if (!ms && !ts) continue;
        const kept: Side = ms ? 'mine' : 'theirs';
        const changed =
          kept === 'theirs'
            ? !this.theirsKept(`sl${q(id)}`, ts!.slide, bs.slide)
            : !same(ms!.slide, bs.slide);
        if (changed) {
          const gone = kept === 'theirs' ? this.m : this.t;
          const withSection = !gone.sections.has(bs.section)
            ? ` with its section “${clip(this.b.sections.get(bs.section)?.label ?? '')}”`
            : '';
          this.conflicts.push({
            level: 'slide',
            key: id,
            slideId: id,
            what: `${name}: ${WHO[other(kept)]} deleted it${withSection} and ${WHO[kept]} changed it`,
          });
        }
        continue;
      }
      if (!bs) {
        if (ms && ts && (ms.section !== ts.section || !same(ms.slide, ts.slide))) {
          this.conflicts.push({
            level: 'slide',
            key: id,
            slideId: id,
            what: `${name}: both added it differently`,
          });
          continue;
        }
        const s = (ms ?? ts)!;
        out.set(id, { slide: s.slide, section: s.section });
        continue;
      }
      const slide = this.slide(bs.slide, ms!.slide, ts!.slide, name);
      const section =
        ms!.section === bs.section
          ? ts!.section
          : ts!.section === bs.section || ts!.section === ms!.section
            ? ms!.section
            : undefined;
      if (section === undefined)
        this.conflicts.push({
          level: 'slide',
          key: id,
          slideId: id,
          what: `${name}: both moved it, to different sections`,
        });
      if (slide && section !== undefined) out.set(id, { slide, section });
    }
    return this.conflicts.length === before ? out : undefined;
  }

  /** One slide both sides kept: the rule on the whole slide, else field by field and object by object. */
  private slide(bs: Slide, ms: Slide, ts: Slide, name: string): Slide | undefined {
    const whole = this.pick(`sl${q(bs.id)}`, bs, ms, ts);
    if (whole.ok) return whole.value;
    const before = this.conflicts.length;
    const fields = this.fields(
      bs as Record<string, unknown>,
      ms as Record<string, unknown>,
      ts as Record<string, unknown>,
      `sl${q(bs.id)}`,
      SLIDE_DEEP,
      new Set(['id', 'objects']),
      (field) => ({
        level: 'slide',
        key: `${bs.id}.${field}`,
        slideId: bs.id,
        what: `${name}: both changed ${fieldName(SLIDE_FIELDS, field)}`,
      }),
    );
    const objects = this.objects(bs, ms, ts, name);
    if (this.conflicts.length !== before || !objects) return undefined;
    const slide = { ...fields, id: bs.id, objects } as Slide;
    if (slide.lyricObjectId && !objects.some((o) => o.id === slide.lyricObjectId)) delete slide.lyricObjectId;
    return slide;
  }

  /** The objects of a slide both sides changed, by id, in the merged z order; undefined after a conflict. */
  private objects(bs: Slide, ms: Slide, ts: Slide, name: string): SlideObject[] | undefined {
    const bo = new Map(bs.objects.map((o) => [o.id, o]));
    const mo = new Map(ms.objects.map((o) => [o.id, o]));
    const to = new Map(ts.objects.map((o) => [o.id, o]));
    const out = new Map<string, SlideObject>();
    const before = this.conflicts.length;
    const conflict = (id: string, what: string) =>
      this.conflicts.push({
        level: 'object',
        key: id,
        slideId: bs.id,
        objectId: id,
        what: `${name}: ${what}`,
      });
    for (const id of union([...bo.keys()], [...mo.keys()], [...to.keys()])) {
      const b = bo.get(id);
      const m = mo.get(id);
      const t = to.get(id);
      const key = `o${q(bs.id)}${q(id)}`;
      if (b && (!m || !t)) {
        if (!m && !t) continue;
        const kept: Side = m ? 'mine' : 'theirs';
        const changed = kept === 'theirs' ? !this.theirsKept(key, t, b) : !same(m, b);
        if (changed) conflict(id, `${WHO[other(kept)]} deleted ${describe(b)} and ${WHO[kept]} changed it`);
        continue;
      }
      if (!b) {
        if (m && t && !same(m, t)) conflict(id, `both added ${describe(m)} differently`);
        else out.set(id, (m ?? t)!);
        continue;
      }
      const v = this.pick(key, b, m!, t!);
      if (v.ok) out.set(id, v.value);
      else conflict(id, `both changed ${describe(b)}`);
    }
    if (this.conflicts.length !== before) return undefined;
    const order = mergeOrder(
      bs.objects.map((o) => o.id),
      ms.objects.map((o) => o.id),
      ts.objects.map((o) => o.id),
      new Set(out.keys()),
    );
    if (!order) {
      this.conflicts.push({
        level: 'slide',
        key: `${bs.id}.objects`,
        slideId: bs.id,
        what: `${name}: both changed which object is in front of which`,
      });
      return undefined;
    }
    return order.map((id) => out.get(id)!);
  }

  // ---- arrangements ----

  private arrangements(sections: { meta: Map<string, unknown> } | undefined): Arrangement[] | undefined {
    const out = new Map<string, Arrangement>();
    const before = this.conflicts.length;
    const ids = union(this.b.arrangementOrder, this.m.arrangementOrder, this.t.arrangementOrder);
    for (const id of ids) {
      const ba = this.b.arrangements.get(id);
      const ma = this.m.arrangements.get(id);
      const ta = this.t.arrangements.get(id);
      const name = `Arrangement “${clip((ma ?? ta ?? ba)!.name)}”`;
      const key = `arrangements.${id}`;
      if (ba && (!ma || !ta)) {
        if (!ma && !ta) continue;
        const kept: Side = ma ? 'mine' : 'theirs';
        const changed = kept === 'theirs' ? !this.theirsKept(`a${q(id)}`, ta, ba) : !same(ma, ba);
        if (changed)
          this.conflicts.push({
            level: 'presentation',
            key,
            what: `${name}: ${WHO[other(kept)]} deleted it and ${WHO[kept]} changed it`,
          });
        continue;
      }
      if (!ba) {
        if (ma && ta && !same(ma, ta))
          this.conflicts.push({ level: 'presentation', key, what: `${name}: both added it differently` });
        else out.set(id, (ma ?? ta)!);
        continue;
      }
      const whole = this.pick(`a${q(id)}`, ba, ma!, ta!);
      if (whole.ok) {
        out.set(id, whole.value);
        continue;
      }
      const fields = this.fields(
        ba as Record<string, unknown>,
        ma as Record<string, unknown>,
        ta as Record<string, unknown>,
        `a${q(id)}`,
        {},
        new Set(['id', 'sectionIds']),
        () => ({ level: 'presentation', key, what: `${name}: both renamed it` }),
      );
      const sectionIds = this.pick(`a${q(id)}.sectionIds`, ba.sectionIds, ma!.sectionIds, ta!.sectionIds);
      const seq = sectionIds.ok ? sectionIds.value : diff3(ba.sectionIds, ma!.sectionIds, ta!.sectionIds);
      if (!seq) {
        this.conflicts.push({ level: 'presentation', key, what: `${name}: both changed its sections` });
        continue;
      }
      out.set(id, { ...fields, id, sectionIds: seq } as Arrangement);
    }
    const order = mergeOrder(
      this.b.arrangementOrder,
      this.m.arrangementOrder,
      this.t.arrangementOrder,
      new Set(out.keys()),
    );
    if (!order)
      this.conflicts.push({
        level: 'presentation',
        key: 'arrangements',
        what: 'Both changed the order of the arrangements',
      });
    if (this.conflicts.length !== before || !order || !sections) return undefined;
    // A section that went leaves the arrangements (as deleting it in the editor does).
    return order.map((id) => {
      const a = out.get(id)!;
      return a.sectionIds.every((s) => sections.meta.has(s))
        ? a
        : { ...a, sectionIds: a.sectionIds.filter((s) => sections.meta.has(s)) };
    });
  }

  /** "Slide 4", numbered as the volunteer's slide list shows it (else as theirs or the base did). */
  private slideName(id: string): string {
    const n = (this.m.slides.get(id) ?? this.t.slides.get(id) ?? this.b.slides.get(id))?.n;
    return n ? `Slide ${n}` : 'A slide';
  }
}

function sectionMeta(s: Section): Omit<Section, 'slides'> {
  const { slides: _slides, ...meta } = s;
  return meta;
}

function fieldName(names: Record<string, string>, field: string): string {
  return names[field] ?? field;
}

/** How the volunteer knows an object: "the text box “Welcome”", "the picture", "the rectangle". */
export function describe(o: SlideObject): string {
  if (o.type === 'text') {
    const line = o.text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l);
    return line ? `the text box “${clip(line)}”` : 'an empty text box';
  }
  if (o.type === 'image')
    return o.play ? 'the video' : o.origin?.role === 'bg' ? 'the background picture' : 'the picture';
  return o.shape === 'rect'
    ? 'the rectangle'
    : o.shape === 'ellipse'
      ? 'the ellipse'
      : o.shape === 'line'
        ? 'the line'
        : 'the shape';
}

/** At most `n` characters of a name, with an ellipsis when cut (never inside a surrogate pair). */
function clip(s: string, n = 32): string {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length <= n
    ? chars.join('')
    : `${chars
        .slice(0, n - 1)
        .join('')
        .trimEnd()}…`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Ids of the three lists, each once: mine's order, then theirs' and base's others. */
function union(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  for (const l of lists) for (const x of l) seen.add(x);
  return [...seen];
}

/** A set of strings merged: what either side added is in, what either side removed is out; mine's order. */
export function mergeSet(b: readonly string[], m: readonly string[], t: readonly string[]): string[] {
  const inB = new Set(b);
  const inM = new Set(m);
  const inT = new Set(t);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of [...m, ...t]) {
    if (seen.has(x)) continue;
    seen.add(x);
    const removed = inB.has(x) && (!inM.has(x) || !inT.has(x));
    if (!removed) out.push(x);
  }
  return out;
}

const sameSeq = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The order of a list of unique ids: the order of the side that reordered it (theirs when neither did, or when
 * both did the same), holding exactly `keep`; null when both reordered it differently. An id the leading side
 * does not have is placed after the id it follows on its own side; mine's are placed after theirs' additions
 * at the same place.
 */
export function mergeOrder(
  b: readonly string[],
  m: readonly string[],
  t: readonly string[],
  keep: ReadonlySet<string>,
): string[] | null {
  const inB = new Set(b);
  const inM = new Set(m);
  const inT = new Set(t);
  const reordered = (side: readonly string[], inSide: ReadonlySet<string>) =>
    !sameSeq(
      b.filter((x) => inSide.has(x)),
      side.filter((x) => inB.has(x)),
    );
  const mMoved = reordered(m, inM);
  const tMoved = reordered(t, inT);
  if (mMoved && tMoved) {
    const inAll = (x: string) => inB.has(x) && inM.has(x) && inT.has(x);
    if (!sameSeq(m.filter(inAll), t.filter(inAll))) return null;
  }
  const mineLeads = mMoved && !tMoved;
  const lead = mineLeads ? m : t;
  const rest = mineLeads ? t : m;
  const out = lead.filter((x) => keep.has(x));
  const placed = new Set(out);
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i]!;
    if (!keep.has(x) || placed.has(x)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--)
      if (placed.has(rest[j]!)) {
        at = out.indexOf(rest[j]!) + 1;
        break;
      }
    // Mine's go after what theirs added (or moved) to the same place: an object I added stays on top.
    if (!mineLeads) while (at < out.length && !inM.has(out[at]!)) at++;
    out.splice(at, 0, x);
    placed.add(x);
  }
  for (const x of keep) if (!placed.has(x)) out.push(x);
  return out;
}

/** Longest common subsequence of two lists as matched index pairs; undefined past `limit` cells. */
function lcs(a: readonly string[], b: readonly string[], limit = 1_000_000): [number, number][] | undefined {
  const n = a.length;
  const w = b.length + 1;
  if ((n + 1) * w > limit) return undefined;
  const len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      len[i * w + j] =
        a[i] === b[j] ? len[(i + 1) * w + j + 1]! + 1 : Math.max(len[(i + 1) * w + j]!, len[i * w + j + 1]!);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i++, j++]);
    } else if (len[(i + 1) * w + j]! >= len[i * w + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/**
 * A sequence (with repeats: an arrangement's sections) merged by diff3: between the items both sides kept,
 * a stretch only one side changed takes that side's; both inserting at the same place keeps both, theirs
 * first; both changing the same stretch differently is null (a conflict), as are lists too long to compare.
 */
export function diff3(b: readonly string[], m: readonly string[], t: readonly string[]): string[] | null {
  const pm = lcs(b, m);
  const pt = lcs(b, t);
  if (!pm || !pt) return null;
  const inM = new Map(pm.map(([i, j]) => [i, j]));
  const inT = new Map(pt.map(([i, j]) => [i, j]));
  const out: string[] = [];
  let i = 0;
  let a = 0;
  let c = 0;
  for (;;) {
    let k = i;
    while (k < b.length && !(inM.has(k) && inT.has(k))) k++;
    const ka = k < b.length ? inM.get(k)! : m.length;
    const kc = k < b.length ? inT.get(k)! : t.length;
    const bc = b.slice(i, k);
    const mc = m.slice(a, ka);
    const tc = t.slice(c, kc);
    if (sameSeq(mc, bc)) out.push(...tc);
    else if (sameSeq(tc, bc) || sameSeq(mc, tc)) out.push(...mc);
    else if (!bc.length) out.push(...tc, ...mc);
    else return null;
    if (k >= b.length) return out;
    out.push(b[k]!);
    i = k + 1;
    a = ka + 1;
    c = kc + 1;
  }
}

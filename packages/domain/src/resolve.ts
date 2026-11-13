import { slideContent } from './content.ts';
import { SCRIPT_FALLBACK_FONTS } from './defaults.ts';
import type { ManifestFile } from './live.ts';
import { extraFontFamilies, extraText } from './m9-readers.ts';
import type {
  FileRef,
  Font,
  ImageObject,
  Look,
  Media,
  Play,
  Playlist,
  Presentation,
  Slide,
  TextStyle,
} from './schemas.ts';

/** The file an output plays or draws for a media item. */
export function playableFile(m: Media): FileRef | undefined {
  return m.delivery ?? (m.kind === 'image' ? m.original : undefined);
}

/**
 * The file a media item shows as a still: an image itself, a video's poster. An ImageObject whose media is
 * a video draws this on outputs, thumbnails and the editor alike (design/27 §8 "Output").
 */
export function stillFile(m: Media): FileRef | undefined {
  if (m.kind === 'image') return m.delivery ?? m.original;
  if (m.kind === 'video') return m.poster;
  return undefined;
}

/**
 * The ImageObject a slide plays in place: the first one with `play`, in z order. Others keep showing their
 * posters (design/27 §8: one video and one sound per slide).
 */
export function playingObject(slide: Pick<Slide, 'objects'>): (ImageObject & { play: Play }) | undefined {
  for (const o of slide.objects) if (o.type === 'image' && o.play) return o as ImageObject & { play: Play };
  return undefined;
}

/**
 * Media a slide plays when it is shown: its playing object's clip and its sound. These are optional at
 * goLive: a clip still transcoding or failed leaves the slide showing its poster (design/27 §8 "Domain").
 */
export function slideMediaIds(slide: Pick<Slide, 'objects' | 'audio'>): string[] {
  const out: string[] = [];
  const play = playingObject(slide)?.play.mediaId;
  if (play) out.push(play);
  const sound = slide.audio?.mediaId;
  if (sound && sound !== play) out.push(sound);
  return out;
}

/**
 * A slide that plays a media item in place (design/27 §8): its clip (`video`), an ImageObject's poster that is
 * its own clip (`poster`: the editor's 'Add video to slide' shows the clip's poster frame), its sound, or the
 * background of a PowerPoint slide (`background`: the importer makes a looping, muted full-slide video the
 * slide's motion background, and a clip may still be transcoding when the service goes live); or that shows
 * its PowerPoint reference picture (`picture`, design/27 §5 'Show PowerPoint picture'). Or a playlist item's
 * music (`music`, `PlaylistItem.audioMediaId`, the pre-service loop's), which has no `slideId`.
 */
export type SlidePlay = {
  presentationId: string;
  slideId?: string;
  role: 'video' | 'poster' | 'sound' | 'background' | 'picture' | 'music';
};

/**
 * Every media reference of a playlist's items and slides. A slide's pictures are the ones it draws
 * (`slideContent`, design/27 §5): on a slide set to show its PowerPoint picture, that picture and the
 * operator's own objects, not the imported objects it hides. `play` is set for what is optional at goLive:
 * the ids of `slideMediaIds`, an ImageObject's poster when that is its own clip, the reference picture, and
 * an item's music (the service goes live without it, with a warning).
 */
function visitPlaylistMedia(
  playlist: Playlist,
  presentations: Record<string, Presentation>,
  visit: (id: string | undefined, play?: SlidePlay) => void,
): void {
  for (const item of playlist.items) {
    if (item.kind === 'media') visit(item.mediaId);
    if (item.kind !== 'presentation') continue;
    visit(item.backgroundMediaId);
    visit(item.audioMediaId, { presentationId: item.presentationId, role: 'music' });
    const p = presentations[item.presentationId];
    if (!p) continue;
    visit(p.backgroundMediaId);
    for (const sec of p.sections)
      for (const sl of sec.slides) {
        const at = (role: SlidePlay['role']): SlidePlay => ({ presentationId: p.id, slideId: sl.id, role });
        visit(sl.backgroundMediaId, sl.pptx ? at('background') : undefined);
        const drawn = slideContent(sl);
        visit(drawn.pictureMediaId, drawn.reference ? at('picture') : undefined);
        for (const o of drawn.objects)
          if (o.type === 'image') visit(o.mediaId, o.play?.mediaId === o.mediaId ? at('poster') : undefined);
        visit(playingObject(sl)?.play.mediaId, at('video'));
        visit(sl.audio?.mediaId, at('sound'));
      }
  }
}

/**
 * Every media id referenced by a playlist and its presentations, plus look holding slides and the logo. A
 * slide's pictures are the ones it draws (`slideContent`), so outputs get every picture they draw.
 */
export function referencedMediaIds(
  playlist: Playlist,
  presentations: Record<string, Presentation>,
  looks: Look[] = [],
  logoMediaId?: string,
): Set<string> {
  const ids = new Set<string>();
  const add = (id?: string) => id && ids.add(id);
  visitPlaylistMedia(playlist, presentations, add);
  for (const l of looks) add(l.holdingMediaId);
  add(logoMediaId);
  return ids;
}

/**
 * Media that slides only play in place (`slideMediaIds`, a play object's poster when it is the clip itself,
 * and a PowerPoint slide's own background) or show as their PowerPoint reference picture, or that items play
 * as their music, each with the slides (or items) that use it. These are optional at goLive (design/27 §5,
 * §8 "Domain"): a clip still processing or failed is left out and its slide shows the poster; a PowerPoint
 * slide's missing background leaves the item's or presentation's background; a reference picture that is
 * missing leaves its slide showing the operator's own objects; an item whose music was deleted or is still
 * processing plays without it. An id that anything else in the playlist draws or plays stays required and
 * is not listed.
 */
export function slideOnlyMedia(
  playlist: Playlist,
  presentations: Record<string, Presentation>,
): Map<string, SlidePlay[]> {
  const required = new Set<string>();
  const played = new Map<string, SlidePlay[]>();
  visitPlaylistMedia(playlist, presentations, (id, play) => {
    if (!id) return;
    if (!play) {
      required.add(id);
      return;
    }
    const list = played.get(id) ?? [];
    // One entry per slide (a presentation in the playlist twice is listed once); its poster comes first.
    if (!list.some((x) => x.slideId === play.slideId && x.presentationId === play.presentationId))
      list.push(play);
    played.set(id, list);
  });
  for (const id of required) played.delete(id);
  return played;
}

/**
 * Font families used by any text in the presentations or looks: every text style's family and
 * `fallbackFonts`, and for text objects also their runs' and bullets' families (design/27 §10), and the
 * families of tables, charts and vector pictures (`extraFontFamilies`, M9), so goLive ships them and outputs
 * cache them before the service.
 */
export function referencedFontFamilies(presentations: Presentation[], looks: Look[]): Set<string> {
  const fam = new Set<string>();
  const add = (f: string | undefined) => {
    if (f) fam.add(f);
  };
  const addStyle = (s: TextStyle) => {
    add(s.fontFamily);
    for (const f of s.fallbackFonts ?? []) add(f);
  };
  for (const p of presentations)
    for (const sec of p.sections)
      for (const sl of sec.slides)
        for (const o of sl.objects) {
          if (o.type !== 'text') {
            for (const f of extraFontFamilies(o)) add(f);
            continue;
          }
          addStyle(o.style);
          for (const r of o.runs ?? []) add(r.fontFamily);
          for (const para of o.paras ?? []) add(para?.bullet?.fontFamily);
        }
  for (const l of looks) {
    if (l.layers.slide.mode === 'lyricOnly') {
      addStyle(l.layers.slide.style);
      if (l.layers.slide.nextSlide) addStyle(l.layers.slide.nextSlide.style);
    }
    for (const s of Object.values(l.layers.props.style)) addStyle(s);
  }
  for (const f of scriptFontFamilies(presentations)) fam.add(f);
  return fam;
}

/** Manifest file list for a set of media and fonts: playable files plus video posters. */
export function manifestFiles(media: Media[], fonts: Font[]): ManifestFile[] {
  const out = new Map<string, ManifestFile>();
  const add = (f?: FileRef) => f && out.set(f.hash, { hash: f.hash, bytes: f.bytes, mime: f.mime });
  for (const m of media) {
    add(playableFile(m));
    add(m.poster);
  }
  for (const f of fonts) add(f.file);
  return [...out.values()];
}

/**
 * The scripts `SCRIPT_FALLBACK_FONTS` has faces for (ISO 15924 codes, the ones `textScripts` reports), each
 * with its test: the goLive font scan (design/27 §10).
 */
const FALLBACK_SCRIPT_TESTS: readonly (readonly [code: string, test: RegExp])[] = [
  ['Grek', /\p{Script=Greek}/u],
  ['Cyrl', /\p{Script=Cyrillic}/u],
  ['Hebr', /\p{Script=Hebrew}/u],
  ['Arab', /\p{Script=Arabic}/u],
  ['Deva', /\p{Script=Devanagari}/u],
  ['Taml', /\p{Script=Tamil}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Mymr', /\p{Script=Myanmar}/u],
  ['Hani', /\p{Script=Han}/u],
  ['Hira', /\p{Script=Hiragana}/u],
  ['Kana', /\p{Script=Katakana}/u],
  ['Hang', /\p{Script=Hangul}/u],
];

/** Any character of a `FALLBACK_SCRIPT_TESTS` script: most text has none and is answered in one pass. */
const ANY_FALLBACK_SCRIPT = new RegExp(`[${FALLBACK_SCRIPT_TESTS.map(([, re]) => re.source).join('')}]`, 'u');

/**
 * Han, Kana and Hangul: their fallback faces (Noto CJK) are large, so goLive ships them only with text in
 * these scripts and the output-config fonts never carry them (design/27 §10). The other script fallbacks
 * are bundled and go to every output.
 */
export const ON_DEMAND_FONT_SCRIPTS: readonly string[] = ['Hani', 'Hira', 'Kana', 'Hang'];

/** The `SCRIPT_FALLBACK_FONTS` scripts (ISO 15924 codes) of the characters in `text`. */
export function fallbackFontScripts(text: string): Set<string> {
  const out = new Set<string>();
  if (!ANY_FALLBACK_SCRIPT.test(text)) return out;
  for (const [code, re] of FALLBACK_SCRIPT_TESTS) if (re.test(text)) out.add(code);
  return out;
}

/**
 * The script fallback families the presentations' text needs: `SCRIPT_FALLBACK_FONTS` of every script
 * present in a text object, a table's cells or a chart's text (`extraText`, M9). `referencedFontFamilies`
 * includes them, so goLive ships the faces the library has of these families, and CJK faces reach outputs
 * only this way (design/27 §10: by text scan). Han in a text with Kana or Hangul is Japanese or Korean, whose
 * family covers it; Han alone names every CJK family and goLive ships the ones the venue added.
 */
export function scriptFontFamilies(presentations: Presentation[]): Set<string> {
  const scripts = new Set<string>();
  for (const p of presentations)
    for (const sec of p.sections)
      for (const sl of sec.slides)
        for (const o of sl.objects) {
          const text = o.type === 'text' ? o.text : extraText(o);
          if (!text) continue;
          const found = fallbackFontScripts(text);
          const kanaOrHangul = found.has('Hira') || found.has('Kana') || found.has('Hang');
          for (const code of found) if (code !== 'Hani' || !kanaOrHangul) scripts.add(code);
        }
  const fam = new Set<string>();
  for (const code of scripts) for (const f of SCRIPT_FALLBACK_FONTS[code] ?? []) fam.add(f);
  return fam;
}

/** The families of `ON_DEMAND_FONT_SCRIPTS`, lower case. */
const ON_DEMAND_FAMILIES: ReadonlySet<string> = new Set(
  ON_DEMAND_FONT_SCRIPTS.flatMap((code) => SCRIPT_FALLBACK_FONTS[code] ?? []).map((f) => f.toLowerCase()),
);

/**
 * Is `family` a CJK fallback family (case-insensitive)? Its faces go to an output only in a goLive whose
 * text needs them, or when something names the family (design/27 §10).
 */
export function isOnDemandFontFamily(family: string): boolean {
  return ON_DEMAND_FAMILIES.has(family.trim().toLowerCase());
}

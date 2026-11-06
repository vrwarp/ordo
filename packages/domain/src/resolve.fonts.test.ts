import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERAL, DEFAULT_LOOKS, SCRIPT_FALLBACK_FONTS } from './defaults.ts';
import { type GoLiveInputs, localDigest, resolvePlaylist } from './goLive.ts';
import { parseLyrics, songFromParsed } from './lyrics.ts';
import {
  fallbackFontScripts,
  isOnDemandFontFamily,
  ON_DEMAND_FONT_SCRIPTS,
  referencedFontFamilies,
  scriptFontFamilies,
} from './resolve.ts';
import type { Font, Presentation } from './schemas.ts';

const song = (lyrics: string, title = 'Song'): Presentation =>
  songFromParsed(parseLyrics(`Verse 1\n${lyrics}`), { title });

let n = 0;
const font = (family: string, weight = 400, unicodeRange?: string): Font => {
  const hash = (++n).toString(16).padStart(64, '0');
  return {
    id: `font${n}`,
    family,
    weight,
    style: 'normal',
    file: { hash, bytes: 10, mime: 'font/woff2', path: `fonts/${hash}.woff2` },
    source: family.startsWith('Noto Sans') && unicodeRange ? 'google' : 'bundled',
    ...(unicodeRange ? { unicodeRange } : {}),
  };
};

/** A library like a venue's after a Korean and a Japanese family came from Google Fonts (two subsets each). */
const LIBRARY: Font[] = [
  font('Inter'),
  font('Inter', 700),
  font('Noto Sans Hebrew', 400, 'U+591-5F4'),
  font('Noto Sans KR', 400, 'U+AC00-D7A3'),
  font('Noto Sans KR', 400, 'U+0-FF'),
  font('Noto Sans JP', 400, 'U+3040-30FF'),
];

function goLive(...presentations: Presentation[]) {
  const playlist = {
    id: 'pl',
    rev: 1,
    name: 'Sunday',
    items: presentations.map((p, i) => ({ id: `i${i}`, kind: 'presentation', presentationId: p.id })),
  };
  const inputs: GoLiveInputs = {
    playlist,
    presentation: (id) => presentations.find((p) => p.id === id),
    media: () => undefined,
    fonts: () => LIBRARY,
    looks: DEFAULT_LOOKS,
    general: DEFAULT_GENERAL,
  };
  return resolvePlaylist(inputs, 'pl', { digest: localDigest });
}

describe('script fallback fonts by text scan (design/27 §10)', () => {
  it('reports the scripts SCRIPT_FALLBACK_FONTS has faces for', () => {
    expect(fallbackFontScripts('Amazing grace, how sweet the sound')).toEqual(new Set());
    expect(fallbackFontScripts('Ἀμήν и аминь')).toEqual(new Set(['Grek', 'Cyrl']));
    expect(fallbackFontScripts('הללויה مرحبا')).toEqual(new Set(['Hebr', 'Arab']));
    expect(fallbackFontScripts('नमस्ते தமிழ் สวัสดี မင်္ဂလာပါ')).toEqual(new Set(['Deva', 'Taml', 'Thai', 'Mymr']));
    expect(fallbackFontScripts('주 하나님 독생자 예수')).toEqual(new Set(['Hang']));
    expect(fallbackFontScripts('主の祈り')).toEqual(new Set(['Hani', 'Hira']));
    expect(fallbackFontScripts('カタカナ 你好')).toEqual(new Set(['Kana', 'Hani']));
    // Every code the scan reports has families, and every table code is scanned.
    for (const code of Object.keys(SCRIPT_FALLBACK_FONTS))
      expect(SCRIPT_FALLBACK_FONTS[code]!.length).toBeGreaterThan(0);
  });

  it('adds the families of the scripts in the text to the referenced families', () => {
    const latin = song('Amazing grace\nhow sweet the sound');
    const korean = song('주 하나님 지으신 모든 세계\n내 마음 속에 그리어 볼 때');
    expect(scriptFontFamilies([latin])).toEqual(new Set());
    expect(scriptFontFamilies([latin, korean])).toEqual(new Set(['Noto Sans KR']));
    // Korean with hanja is still Korean; Japanese with kanji is Japanese.
    expect(scriptFontFamilies([song('主 하나님')])).toEqual(new Set(['Noto Sans KR']));
    expect(scriptFontFamilies([song('主の祈り')])).toEqual(new Set(['Noto Sans JP']));
    expect(scriptFontFamilies([song('ברוך הבא')])).toEqual(new Set(['Noto Sans Hebrew']));
    // Han names every CJK family: goLive ships those the library has (the venue's choice).
    expect(scriptFontFamilies([song('哈利路亚')])).toEqual(new Set(SCRIPT_FALLBACK_FONTS.Hani));
    const fam = referencedFontFamilies([latin, korean], DEFAULT_LOOKS);
    expect(fam.has('Noto Sans KR')).toBe(true);
    expect(fam.has('Inter')).toBe(true);
    expect(referencedFontFamilies([latin], DEFAULT_LOOKS).has('Noto Sans KR')).toBe(false);
  });

  it('knows which families are CJK fallbacks (never in the output-config fonts)', () => {
    expect(ON_DEMAND_FONT_SCRIPTS).toEqual(['Hani', 'Hira', 'Kana', 'Hang']);
    for (const f of ['Noto Sans SC', 'noto sans tc', ' Noto Sans JP', 'NOTO SANS KR'])
      expect(isOnDemandFontFamily(f)).toBe(true);
    for (const f of ['Noto Sans', 'Noto Sans Hebrew', 'Inter', 'Carlito'])
      expect(isOnDemandFontFamily(f)).toBe(false);
  });
});

describe('goLive manifests carry the faces the text needs', () => {
  it('ships CJK faces only with CJK text, every subset of the family', () => {
    const latin = goLive(song('Amazing grace\nhow sweet the sound'));
    expect(latin.fonts.map((f) => f.family).sort()).toEqual(['Inter', 'Inter']);

    const korean = goLive(song('Amazing grace'), song('주 하나님 지으신 모든 세계', 'Korean'));
    const kr = korean.fonts.filter((f) => f.family === 'Noto Sans KR');
    expect(kr.map((f) => f.unicodeRange).sort()).toEqual(['U+0-FF', 'U+AC00-D7A3']);
    expect(korean.fonts.some((f) => f.family === 'Noto Sans JP')).toBe(false);
    // The manifest lists their files, so outputs cache them before the service.
    const files = new Set(korean.files.map((f) => f.hash));
    for (const f of kr) expect(files.has(f.file.hash)).toBe(true);

    const japanese = goLive(song('主の祈り'));
    // Han with Kana is Japanese: the Japanese family covers it, the others stay home.
    expect(japanese.fonts.map((f) => f.family).sort()).toEqual(['Inter', 'Inter', 'Noto Sans JP']);
    // Han alone (Chinese) names every CJK family; the library has two of them.
    const chinese = goLive(song('哈利路亚 赞美主'));
    expect(new Set(chinese.fonts.map((f) => f.family))).toEqual(
      new Set(['Inter', 'Noto Sans JP', 'Noto Sans KR']),
    );
  });

  it('ships a bundled script fallback with text in its script', () => {
    const hebrew = goLive(song('הללויה'));
    expect(hebrew.fonts.map((f) => f.family)).toContain('Noto Sans Hebrew');
    expect(goLive(song('Hallelujah')).fonts.map((f) => f.family)).not.toContain('Noto Sans Hebrew');
  });
});

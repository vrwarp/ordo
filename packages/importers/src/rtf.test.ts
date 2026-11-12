import { describe, expect, it } from 'vitest';
import { isRtf, parseRtf, splitFontName } from './rtf.ts';

const COCOA = String.raw`{\rtf1\ansi\ansicpg1252\cocoartf2639
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fnil\fcharset0 HelveticaNeue-Bold;\f1\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;\red255\green200\blue0;\red0\green0\blue0;}
{\*\expandedcolortbl;;\csgenericrgb\c100000\c78431\c0;}
\deftab1680
\pard\pardeftab1680\pardirnatural\qc\partightenfactor0

\f0\b\fs120 \cf2 \outl0\strokewidth-40 \strokec3 Amazing grace, how sweet\
the sound}`;

describe('parseRtf', () => {
  it("reports the first paragraph's line spacing and space after", () => {
    const r = parseRtf(String.raw`{\rtf1\ansi{\fonttbl\f0 Tahoma;}\pard\sa426\sl360\slmult1\qc\f0\fs128 one\
two\pard\sa0 three}`);
    expect(r.lineSpacing).toBe(1.5);
    expect(r.spaceAfterPt).toBeCloseTo(21.3);
    expect(parseRtf(String.raw`{\rtf1\ansi\pard\sl-300 exact}`).lineSpacing).toBeUndefined();
  });

  it('extracts Cocoa \\slleading line spacing without overwriting \\sl\\slmult', () => {
    const r = parseRtf(
      String.raw`{\rtf1\ansi{\fonttbl\f0 Arial;}\pard\sl480\slmult1\slleading500\f0\fs24 Hello}`,
    );
    expect(r.lineSpacing).toBe(2);
    expect(r.leadingPt).toBe(25);
  });

  it('detects bullet lists and skips \\listtext destination without duplicating bullets in text', () => {
    const r = parseRtf(
      String.raw`{\rtf1\ansi{\fonttbl\f0 Arial;}\pard\li820\fi-820{\listtext	\uc0\u8226 	}Point one\par{\listtext	\uc0\u8226 	}Point two}`,
    );
    expect(r.text).toBe('Point one\nPoint two');
    expect(r.hasBulletList).toBe(true);
    expect(r.indentPt).toBe(41);
    expect(r.firstLinePt).toBe(-41);
  });

  it('decodes hex escapes in the font charset: Big5 and GBK double-byte characters, ansicpg for the rest', () => {
    // Cocoa writes a Chinese run as Big5 bytes under a `\fcharset136` font (ProPresenter on a Mac).
    const big5 = String.raw`{\rtf1\ansi\ansicpg1252{\fonttbl\f0\fnil\fcharset0 Tahoma;\f1\fnil\fcharset136 PingFangTC;}
\f0\fs48 Hello\
\f1 \'a7\'41\'a6\'6e
\f0 !}`;
    expect(parseRtf(big5).text).toBe('Hello\n你好!');
    const gbk = String.raw`{\rtf1\ansi{\fonttbl\f0\fnil\fcharset134 SimSun;}\f0 \'c4\'e3\'ba\'c3}`;
    expect(parseRtf(gbk).text).toBe('你好');
    const cyrillic = String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl\f0\fnil\fcharset0 Arial;}\f0 \'cf\'f0\'e8\'e2\'e5\'f2}`;
    expect(parseRtf(cyrillic).text).toBe('Привет');
    // A \uN character's fallback is counted in bytes: a double-byte fallback is skipped whole.
    const fallback = String.raw`{\rtf1\ansi{\fonttbl\f0\fnil\fcharset136 PingFangTC;}\f0\uc2\u20320 \'a7\'41\'a6\'6e}`;
    expect(parseRtf(fallback).text).toBe('你好');
    // Latin-1 escapes in a Western font are unchanged.
    expect(parseRtf(String.raw`{\rtf1\ansi\ansicpg1252{\fonttbl\f0 Arial;}\f0 Caf\'e9}`).text).toBe('Café');
  });

  it('extracts Cocoa RTF text and first-run style', () => {
    const r = parseRtf(COCOA);
    expect(r.text).toBe('Amazing grace, how sweet\nthe sound');
    expect(r.fontName).toBe('HelveticaNeue-Bold');
    expect(r.fontSizePt).toBe(60);
    expect(r.color).toEqual({ r: 255, g: 200, b: 0, a: 1 });
    expect(r.bold).toBe(true);
    expect(r.align).toBe('center');
    expect(r.strokeWidth).toBe(-40);
    expect(r.strokeColor).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(r.styleRuns).toBe(1);
  });

  it('handles \\par, \\line, hex escapes and unicode with fallback skipping', () => {
    const r = parseRtf(
      "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0\\fs48 Caf\\'e9\\par line two\\line \\uc1\\u8364?uro \\u-3913?x}",
    );
    expect(r.text).toBe('Café\nline two\n€uro x');
    expect(r.fontName).toBe('Arial');
    expect(r.fontSizePt).toBe(24);
  });

  it('skips ignorable destinations and info groups', () => {
    const r = parseRtf(
      String.raw`{\rtf1{\info{\title Secret}}{\*\generator Foo;}{\stylesheet{\s0 Normal;}}Hello {\b world}}`,
    );
    expect(r.text).toBe('Hello world');
    expect(r.styleRuns).toBe(2);
  });

  it('maps cp1252 specials and escaped braces', () => {
    const r = parseRtf(String.raw`{\rtf1 \'93Quote\'94 \{x\} back\\slash}`);
    expect(r.text).toBe('“Quote” {x} back\\slash');
  });

  it('turns U+2028 line separators into newlines', () => {
    const r = parseRtf('{\\rtf1\\uc0\\u8232 one\\uc0\\u8232 two}');
    expect(r.text).toBe('one\ntwo');
  });

  it('takes non-RTF input as plain text and keeps its line breaks', () => {
    expect(isRtf(COCOA)).toBe(true);
    expect(isRtf('hello')).toBe(false);
    expect(parseRtf('one\r\ntwo\nthree\u2028four\n')).toEqual({
      text: 'one\ntwo\nthree\nfour',
      plain: true,
      bold: false,
      italic: false,
      styleRuns: 0,
    });
    expect(parseRtf(new TextEncoder().encode('\uFEFFCafé\nnoir')).text).toBe('Café\nnoir');
  });

  it('accepts bytes', () => {
    const r = parseRtf(new TextEncoder().encode(String.raw`{\rtf1 Hi\par}`));
    expect(r.text).toBe('Hi');
  });

  it('overrides legacy colortbl entries with Cocoa expandedcolortbl', () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1252{\fonttbl\f0 Arial;}
{\colortbl;\red0\green0\blue0;\red33\green40\blue44;}
{\*\expandedcolortbl;;\cssrgb\c17088\c20858\c22823;}
\pard\f0\fs24\cf2 Modern Cocoa Color}`;
    const r = parseRtf(rtf);
    expect(r.text).toBe('Modern Cocoa Color');
    expect(r.color).toEqual({ r: 44, g: 53, b: 58, a: 1 });
    expect(r.spans?.[0]?.color).toEqual({ r: 44, g: 53, b: 58, a: 1 });

    // Test with alpha and csgray
    const rtfGray = String.raw`{\rtf1\ansi{\fonttbl\f0 Arial;}
{\colortbl;\red0\green0\blue0;}
{\*\expandedcolortbl;\csgray\c50000\ca50000;}
\pard\f0\fs24\cf1 Gray Alpha}`;
    const rGray = parseRtf(rtfGray);
    expect(rGray.color).toEqual({ r: 128, g: 128, b: 128, a: 0.5 });
  });

  it('extracts multi-run character spans with exact offsets through tidyLines trimming', () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl\f0 Arial;}{\colortbl;\red0\green0\blue0;\red255\green0\blue0;}
\par
\pard
  The \b\cf2 quick\b0\cf1  brown fox  \par
\par}`;
    const r = parseRtf(rtf);
    expect(r.text).toBe('  The quick brown fox');
    expect(r.spans).toBeDefined();
    expect(r.spans!.length).toBe(3);

    const [s0, s1, s2] = r.spans!;
    expect(r.text.slice(s0!.start, s0!.end)).toBe('  The ');
    expect(s0!.bold).toBeUndefined();

    expect(r.text.slice(s1!.start, s1!.end)).toBe('quick');
    expect(s1!.bold).toBe(true);
    expect(s1!.color).toEqual({ r: 255, g: 0, b: 0, a: 1 });

    expect(r.text.slice(s2!.start, s2!.end)).toBe(' brown fox');
    expect(s2!.bold).toBeUndefined();
    expect(s2!.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });

    expect(s0!.start).toBe(0);
    expect(s2!.end).toBe(r.text.length);
  });

  it('tracks underline, strike, super/subscript, small caps, highlight, and spaceBeforePt', () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl\f0 Arial;}{\colortbl;\red0\green0\blue0;\red255\green255\blue0;}
\pard\sb120\sa60
\f0\fs24
\ul Underlined\ul0  
\strike Striked\strike0  
Normal\super Super\nosupersub  
Normal\sub Sub\nosupersub  
\scaps Small Caps\scaps0  
\highlight2 Highlighted\highlight0
\par\pard\sb240 Line two}`;
    const r = parseRtf(rtf);
    expect(r.paras).toBeDefined();
    expect(r.paras!.length).toBe(2);
    expect(r.paras![0]!.spaceBeforePt).toBe(6);
    expect(r.paras![0]!.spaceAfterPt).toBe(3);
    expect(r.paras![1]!.spaceBeforePt).toBe(12);

    const spans = r.spans!;
    const underSpan = spans.find((s) => r.text.slice(s.start, s.end).includes('Underlined'));
    expect(underSpan?.underline).toBe(true);

    const strikeSpan = spans.find((s) => r.text.slice(s.start, s.end).includes('Striked'));
    expect(strikeSpan?.strike).toBe(true);

    const superSpan = spans.find((s) => r.text.slice(s.start, s.end).includes('Super'));
    expect(superSpan?.baseline).toBe(0.33);

    const subSpan = spans.find((s) => r.text.slice(s.start, s.end).includes('Sub'));
    expect(subSpan?.baseline).toBe(-0.2);

    const scapsSpan = spans.find((s) => r.text.slice(s.start, s.end).includes('Small Caps'));
    expect(scapsSpan?.caps).toBe('small');

    const hlSpan = spans.find((s) => r.text.slice(s.start, s.end).includes('Highlighted'));
    expect(hlSpan?.highlight).toEqual({ r: 255, g: 255, b: 0, a: 1 });
  });

  it('tracks letter spacing, baseline shifts, and bullet paragraph styles', () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl\f0 Arial;}
\pard\li720\fi-360{\listtext\uc0\u8226\tab}Item 1\par
\pard\li720\fi-360{\listtext\uc0\u8226\tab}\expndtw40\up6 Item 2}`;
    const r = parseRtf(rtf);
    expect(r.hasBulletList).toBe(true);
    expect(r.paras).toBeDefined();
    expect(r.paras!.length).toBe(2);
    expect(r.paras![0]!.isBullet).toBe(true);
    expect(r.paras![0]!.bulletChar).toBe('•');
    expect(r.paras![0]!.indentPt).toBe(36);
    expect(r.paras![0]!.firstLinePt).toBe(-18);

    const item2Span = r.spans!.find((s) => r.text.slice(s.start, s.end).includes('Item 2'));
    expect(item2Span?.letterSpacingPt).toBe(2);
    expect(item2Span?.baseline).toBe(0.25);
  });
});

describe('splitFontName', () => {
  it('splits PostScript names', () => {
    expect(splitFontName('HelveticaNeue-Bold')).toEqual({
      family: 'Helvetica Neue',
      weight: 700,
      italic: false,
    });
    expect(splitFontName('OpenSans-SemiboldItalic')).toEqual({
      family: 'Open Sans',
      weight: 600,
      italic: true,
    });
    expect(splitFontName('Arial')).toEqual({ family: 'Arial', weight: 400, italic: false });
    expect(splitFontName('Montserrat Black')).toEqual({ family: 'Montserrat', weight: 900, italic: false });
  });
});

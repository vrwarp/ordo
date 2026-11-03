import { describe, expect, it } from 'vitest';
import { parseRtf, splitFontName } from './rtf.ts';

const COCOA = String.raw`{\rtf1\ansi\ansicpg1252\cocoartf2639
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fnil\fcharset0 HelveticaNeue-Bold;\f1\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;\red255\green200\blue0;\red0\green0\blue0;}
{\*\expandedcolortbl;;\csgenericrgb\c100000\c78431\c0;}
\deftab1680
\pard\pardeftab1680\pardirnatural\qc\partightenfactor0

\f0\b\fs120 \cf2 \outl0\strokewidth-40 \strokec3 Amazing grace, how sweet\
the sound}`;

describe('parseRtf', () => {
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

  it('accepts bytes', () => {
    const r = parseRtf(new TextEncoder().encode(String.raw`{\rtf1 Hi\par}`));
    expect(r.text).toBe('Hi');
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

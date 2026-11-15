import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Bytes, sha256Text } from './sha256.ts';

/** Node's own SHA-256 of a string's UTF-8 bytes: the oracle for lengths and texts NIST does not list. */
const node = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256 (FIPS 180-4, plain JavaScript)', () => {
  it('gives the NIST example digests', () => {
    // FIPS 180-2 appendix B and the NIST CSRC examples (SHA256.pdf).
    expect(sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(
      sha256Text(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it('gives the digest of the empty string', () => {
    expect(sha256Text('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Bytes(new Uint8Array(0))).toBe(sha256Text(''));
  });

  it('gives the digest of a million "a" (1 MB, the NIST long message)', () => {
    expect(sha256Text('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('hashes the UTF-8 bytes of non-ASCII text (accents, Hangul, an emoji pair)', () => {
    for (const s of ['Señor, ten piedad', '주님의 은혜', 'Glória 🙏 ✝', 'שלום עליכם', 'é́'])
      expect(sha256Text(s)).toBe(node(s));
    // A lone surrogate is encoded as U+FFFD by TextEncoder, as Node's UTF-8 encoder does.
    expect(sha256Text('a\ud800b')).toBe(node('a\ud800b'));
  });

  it('pads every length around a block boundary correctly', () => {
    for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000])
      expect(sha256Text('x'.repeat(n)), `length ${n}`).toBe(node('x'.repeat(n)));
  });

  it('hashes bytes as given (not only text)', () => {
    const b = new Uint8Array(300);
    for (let i = 0; i < b.length; i++) b[i] = (i * 37) & 0xff;
    expect(sha256Bytes(b)).toBe(createHash('sha256').update(b).digest('hex'));
  });
});

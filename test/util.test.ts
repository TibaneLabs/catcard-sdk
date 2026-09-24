import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CborTag, cborDecode, cborEncode } from '../src/cbor';
import { base32Decode, base32Encode } from '../src/util/base32';
import { bytesToHex, hexToBytes, utf8Encode } from '../src/util/bytes';
import { crc32 } from '../src/util/crc32';
import { sha256 } from '../src/util/sha256';

describe('sha256', () => {
  it('matches node:crypto for many lengths', () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_000]) {
      const data = new Uint8Array(len).map((_, i) => (i * 31 + len) & 0xff);
      expect(bytesToHex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});

describe('crc32', () => {
  it('matches known vectors', () => {
    expect(crc32(utf8Encode('Hello, world!'))).toBe(0xebe6c6e6);
    expect(crc32(utf8Encode('Wolf'))).toBe(0x598c84dc);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('base32', () => {
  it('matches RFC 4648 vectors without padding', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(utf8Encode(plain))).toBe(encoded);
      expect(base32Decode(encoded)).toEqual(utf8Encode(plain));
    }
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('MZ1W')).toThrow();
  });
});

describe('cbor', () => {
  it('encodes integers minimally', () => {
    const cases: [number | bigint, string][] = [
      [0, '00'],
      [23, '17'],
      [24, '1818'],
      [255, '18ff'],
      [256, '190100'],
      [65536, '1a00010000'],
      [0xffffffff, '1affffffff'],
      [2 ** 32, '1b0000000100000000'],
      [0xffffffffffffffffn, '1bffffffffffffffff'],
      [-1, '20'],
      [-500, '3901f3'],
    ];
    for (const [value, hex] of cases) {
      expect(bytesToHex(cborEncode(value))).toBe(hex);
      expect(cborDecode(hexToBytes(hex))).toEqual(value);
    }
  });

  it('round-trips nested structures', () => {
    const value = new Map<any, any>([
      [1, new Uint8Array([1, 2, 3])],
      [2, 'text ✓'],
      [3, [true, false, null, new CborTag(304, new Map([[1, 42]]))]],
    ]);
    expect(cborDecode(cborEncode(value))).toEqual(value);
  });

  it('rejects truncated and oversized input', () => {
    expect(() => cborDecode(hexToBytes('5a ffffffff'.replace(' ', '')))).toThrow();
    expect(() => cborDecode(hexToBytes('83 01 02'.replace(/ /g, '')))).toThrow();
    expect(() => cborDecode(hexToBytes('0000'))).toThrow(/Trailing/);
  });
});

import { joinQRs as refJoin, splitQRs as refSplit } from 'bbqr';
import { describe, expect, it } from 'vitest';
import { bbqrJoin, bbqrSplit, parseBBQrHeader, type BBQrEncoding } from '../src/bbqr';
import { utf8Encode } from '../src/util/bytes';
import { Xoshiro256 } from '../src/ur';

const random = (length: number): Uint8Array => new Xoshiro256(utf8Encode(`bbqr${length}`)).nextData(length);
// Compressible, PSBT-like data.
const repetitive = (length: number): Uint8Array =>
  new Uint8Array(length).map((_, i) => [0x70, 0x73, 0x62, 0x74, 0xff, 0, 0, 1][i % 8]! ^ (i >> 9));

const ENCODINGS: BBQrEncoding[] = ['Z', '2', 'H'];

describe('bbqr', () => {
  for (const encoding of ENCODINGS) {
    for (const [name, data] of [
      ['small random', random(20)],
      ['large random', random(9000)],
      ['large repetitive', repetitive(20000)],
    ] as const) {
      it(`${encoding}: ${name} round-trips and interoperates with the reference`, () => {
        const ours = bbqrSplit(data, 'P', { encoding, maxVersion: 20 });
        const ref = refSplit(data, 'P', { encoding, maxVersion: 20 });
        expect(ours.version).toBe(ref.version);
        expect(ours.encoding).toBe(ref.encoding);
        expect(ours.parts.length).toBe(ref.parts.length);

        expect(bbqrJoin([...ours.parts].reverse()).data).toEqual(data);
        expect(refJoin(ours.parts).raw).toEqual(data);
        expect(bbqrJoin(ref.parts).data).toEqual(data);
      });
    }
  }

  it('falls back to base32 when compression does not help', () => {
    expect(bbqrSplit(random(500), 'B').encoding).toBe('2');
    expect(bbqrSplit(repetitive(500), 'B').encoding).toBe('Z');
  });

  it('writes a correct header', () => {
    const { parts } = bbqrSplit(random(5000), 'T', { encoding: 'H', maxVersion: 10 });
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((part, i) => {
      expect(parseBBQrHeader(part)).toEqual({ encoding: 'H', fileType: 'T', total: parts.length, index: i });
    });
  });

  it('rejects inconsistent or incomplete sets', () => {
    const a = bbqrSplit(random(3000), 'P', { encoding: 'H', maxVersion: 10 }).parts;
    const b = bbqrSplit(random(3000), 'T', { encoding: 'H', maxVersion: 10 }).parts;
    expect(() => bbqrJoin(a.slice(1))).toThrow(/missing/);
    expect(() => bbqrJoin([a[0]!, b[1]!])).toThrow(/different/);
    expect(() => bbqrJoin([a[0]!, a[0]!.slice(0, -2) + '00'])).toThrow(/different content/);
  });
});

import { UR as RefUR, URDecoder as RefURDecoder, UREncoder as RefUREncoder } from '@ngraveio/bc-ur';
import { chooseFragments as refChooseFragments } from '@ngraveio/bc-ur/dist/fountainUtils.js';
import RefXoshiro from '@ngraveio/bc-ur/dist/xoshiro.js';
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../src/util/bytes';
import { crc32 } from '../src/util/crc32';
import { chooseFragments, UR, URDecoder, UREncoder, Xoshiro256 } from '../src/ur';

const makeMessage = (length: number, seed = 'Wolf'): Uint8Array =>
  new Xoshiro256(utf8Encode(seed)).nextData(length);

describe('Xoshiro256', () => {
  it('matches the BC-UR reference test vector', () => {
    const rng = new Xoshiro256(utf8Encode('Wolf'));
    const numbers = Array.from({ length: 100 }, () => Number(rng.next() % 100n));
    expect(numbers.slice(0, 10)).toEqual([42, 81, 85, 8, 82, 84, 76, 73, 70, 88]);
  });

  it('matches the reference implementation', () => {
    const ours = new Xoshiro256(utf8Encode('Wolf'));
    const ref = new RefXoshiro(Buffer.from('Wolf'));
    for (let i = 0; i < 1000; i++) expect(ours.nextInt(1, 17)).toBe(ref.nextInt(1, 17));
  });
});

describe('chooseFragments', () => {
  it('matches the reference implementation', () => {
    for (const [size, fragmentLength] of [[1024, 100], [5000, 90], [30000, 200]] as const) {
      const message = makeMessage(size);
      const checksum = crc32(message);
      const seqLength = Math.ceil(size / fragmentLength);
      for (let seqNum = 1; seqNum <= 200; seqNum++) {
        const ref = [...refChooseFragments(seqNum, seqLength, checksum)].sort((a: number, b: number) => a - b);
        expect(chooseFragments(seqNum, seqLength, checksum)).toEqual(ref);
      }
    }
  });
});

describe('UREncoder', () => {
  for (const size of [1, 50, 99, 100, 101, 256, 1024, 5000]) {
    it(`produces the same parts as the reference for ${size} bytes`, () => {
      const message = makeMessage(size);
      const ours = new UREncoder(UR.fromBytes(message, 'crypto-psbt'), { maxFragmentLength: 90 });
      const ref = new RefUREncoder(RefUR.fromBuffer(Buffer.from(message)), 90, 0, 10);
      for (let i = 0; i < 60; i++) {
        expect(ours.nextPart()).toBe(ref.nextPart().replace('ur:bytes/', 'ur:crypto-psbt/'));
      }
    });
  }
});

describe('URDecoder', () => {
  it('decodes reference parts with frames missing', () => {
    const message = makeMessage(3000, 'catcard');
    const ref = new RefUREncoder(RefUR.fromBuffer(Buffer.from(message)), 120, 0, 10);
    const decoder = new URDecoder();
    let i = 0;
    while (!decoder.isComplete()) {
      const part = ref.nextPart();
      if (i++ % 3 !== 1) decoder.receivePart(part.toUpperCase());
      expect(i).toBeLessThan(500);
    }
    expect(decoder.result()!.type).toBe('bytes');
    expect(decoder.result()!.toBytes()).toEqual(message);
  });

  it('produces parts the reference decoder accepts', () => {
    const message = makeMessage(2000, 'catcard');
    const encoder = new UREncoder(UR.fromBytes(message), { maxFragmentLength: 150 });
    const ref = new RefURDecoder();
    let i = 0;
    while (!ref.isComplete()) {
      const part = encoder.nextPart();
      if (i++ % 2 === 0) ref.receivePart(part);
      expect(i).toBeLessThan(500);
    }
    expect(ref.isSuccess()).toBe(true);
    expect(new Uint8Array(ref.resultUR().decodeCBOR())).toEqual(message);
  });

  it('handles single-part URs', () => {
    const ur = UR.fromBytes(utf8Encode('hello'));
    const decoder = new URDecoder();
    decoder.receivePart(new UREncoder(ur).nextPart());
    expect(decoder.result()!.toBytes()).toEqual(utf8Encode('hello'));
  });

  it('rejects corrupted parts and mixed URs', () => {
    const a = new UREncoder(UR.fromBytes(makeMessage(500)), { maxFragmentLength: 100 });
    const b = new UREncoder(UR.fromBytes(makeMessage(600)), { maxFragmentLength: 100 });
    const decoder = new URDecoder();
    const part = a.nextPart();
    const corrupted = part.slice(0, -3) + (part[part.length - 3] === 'a' ? 'b' : 'a') + part.slice(-2);
    expect(() => decoder.receivePart(corrupted)).toThrow();
    decoder.receivePart(part);
    expect(() => decoder.receivePart(b.nextPart())).toThrow();
  });
});

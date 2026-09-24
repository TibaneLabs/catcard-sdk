import { sha256 } from '../util/sha256';

const MASK = 0xffffffffffffffffn;
const TWO_POW_64 = 2 ** 64;

const rotl = (x: bigint, k: bigint): bigint => ((x << k) | (x >> (64n - k))) & MASK;

/**
 * xoshiro256** PRNG, seeded exactly as the BC-UR reference implementation does
 * (SHA-256 of the seed bytes, read as four big-endian 64-bit words).
 */
export class Xoshiro256 {
  private s: [bigint, bigint, bigint, bigint];

  constructor(seed: Uint8Array) {
    const digest = sha256(seed);
    const words: bigint[] = [];
    for (let i = 0; i < 4; i++) {
      let v = 0n;
      for (let n = 0; n < 8; n++) v = (v << 8n) | BigInt(digest[i * 8 + n]!);
      words.push(v);
    }
    this.s = words as [bigint, bigint, bigint, bigint];
  }

  next(): bigint {
    const s = this.s;
    const result = (rotl((s[1] * 5n) & MASK, 7n) * 9n) & MASK;
    const t = (s[1] << 17n) & MASK;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 45n);
    return result;
  }

  /** Uniform double in [0, 1), matching the reference `next() / (UINT64_MAX + 1)`. */
  nextDouble(): number {
    return Number(this.next()) / TWO_POW_64;
  }

  /** Uniform integer in [low, high]. */
  nextInt(low: number, high: number): number {
    return Math.floor(this.nextDouble() * (high - low + 1)) + low;
  }

  nextByte(): number {
    return this.nextInt(0, 255);
  }

  nextData(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = this.nextByte();
    return out;
  }
}

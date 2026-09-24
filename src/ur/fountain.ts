// Luby-transform fountain codes as specified by BCR-2020-005 (Uniform Resources).
// Fragment selection must match the reference implementation bit for bit, as
// the decoder recomputes it from (seqNum, seqLen, checksum).

import { cborDecode, cborEncode } from '../cbor';
import { QRDecodeError, QREncodeError } from '../errors';
import { concatBytes, uint32BE } from '../util/bytes';
import { crc32 } from '../util/crc32';
import { RandomSampler } from './sampler';
import { Xoshiro256 } from './xoshiro';

export interface FountainPart {
  seqNum: number;
  seqLength: number;
  messageLength: number;
  checksum: number;
  data: Uint8Array;
}

export function encodeFountainPart(part: FountainPart): Uint8Array {
  return cborEncode([part.seqNum, part.seqLength, part.messageLength, part.checksum, part.data]);
}

const isUint32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

export function decodeFountainPart(cbor: Uint8Array): FountainPart {
  let value;
  try {
    value = cborDecode(cbor);
  } catch (e) {
    throw new QRDecodeError(`Invalid multipart UR body: ${(e as Error).message}`);
  }
  if (!Array.isArray(value) || value.length !== 5) throw new QRDecodeError('Invalid multipart UR body');
  const [seqNum, seqLength, messageLength, checksum, data] = value;
  if (!isUint32(seqNum) || !isUint32(seqLength) || !isUint32(messageLength) || !isUint32(checksum)) {
    throw new QRDecodeError('Invalid multipart UR header fields');
  }
  if (!(data instanceof Uint8Array)) throw new QRDecodeError('Invalid multipart UR fragment');
  return { seqNum, seqLength, messageLength, checksum, data };
}

/** Picks the fragment length giving the fewest fragments no longer than `maxFragmentLength`. */
export function findNominalFragmentLength(messageLength: number, minFragmentLength: number, maxFragmentLength: number): number {
  if (messageLength <= 0) throw new QREncodeError('Cannot fountain-encode an empty message');
  if (minFragmentLength <= 0 || maxFragmentLength < minFragmentLength) {
    throw new QREncodeError('Invalid fragment length bounds');
  }
  const maxFragmentCount = Math.max(1, Math.floor(messageLength / minFragmentLength));
  let fragmentLength = 0;
  for (let count = 1; count <= maxFragmentCount; count++) {
    fragmentLength = Math.ceil(messageLength / count);
    if (fragmentLength <= maxFragmentLength) break;
  }
  return fragmentLength;
}

function chooseDegree(seqLength: number, rng: Xoshiro256): number {
  const weights: number[] = [];
  for (let i = 1; i <= seqLength; i++) weights.push(1 / i);
  return new RandomSampler(weights).next(() => rng.nextDouble()) + 1;
}

function shuffled<T>(items: readonly T[], rng: Xoshiro256): T[] {
  const remaining = [...items];
  const result: T[] = [];
  while (remaining.length > 0) {
    const index = rng.nextInt(0, remaining.length - 1);
    result.push(remaining.splice(index, 1)[0]!);
  }
  return result;
}

/** Indexes of the fragments XOR-ed together in part `seqNum`, sorted ascending. */
export function chooseFragments(seqNum: number, seqLength: number, checksum: number): number[] {
  if (seqNum <= seqLength) return [seqNum - 1];
  const rng = new Xoshiro256(concatBytes([uint32BE(seqNum), uint32BE(checksum)]));
  const degree = chooseDegree(seqLength, rng);
  const indexes = Array.from({ length: seqLength }, (_, i) => i);
  return shuffled(indexes, rng)
    .slice(0, degree)
    .sort((a, b) => a - b);
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i]! ^= source[i]!;
}

export class FountainEncoder {
  readonly messageLength: number;
  readonly checksum: number;
  readonly fragmentLength: number;
  private readonly fragments: Uint8Array[];
  private seqNum: number;

  constructor(message: Uint8Array, maxFragmentLength = 100, firstSeqNum = 0, minFragmentLength = 10) {
    this.messageLength = message.length;
    this.checksum = crc32(message);
    this.fragmentLength = findNominalFragmentLength(message.length, minFragmentLength, maxFragmentLength);
    this.fragments = [];
    for (let offset = 0; offset < message.length; offset += this.fragmentLength) {
      const fragment = new Uint8Array(this.fragmentLength);
      fragment.set(message.subarray(offset, offset + this.fragmentLength));
      this.fragments.push(fragment);
    }
    this.seqNum = firstSeqNum >>> 0;
  }

  get seqLength(): number {
    return this.fragments.length;
  }

  /** Sequence number of the last part returned by {@link nextPart}. */
  get lastSeqNum(): number {
    return this.seqNum;
  }

  isSinglePart(): boolean {
    return this.fragments.length === 1;
  }

  /** True once every pure fragment has been emitted at least once. */
  isComplete(): boolean {
    return this.seqNum >= this.fragments.length;
  }

  nextPart(): FountainPart {
    this.seqNum = (this.seqNum + 1) >>> 0;
    const indexes = chooseFragments(this.seqNum, this.fragments.length, this.checksum);
    const data = new Uint8Array(this.fragmentLength);
    for (const i of indexes) xorInto(data, this.fragments[i]!);
    return {
      seqNum: this.seqNum,
      seqLength: this.fragments.length,
      messageLength: this.messageLength,
      checksum: this.checksum,
      data,
    };
  }
}

interface MixedPart {
  indexes: number[];
  data: Uint8Array;
}

export interface FountainDecoderOptions {
  /**
   * Refuse messages larger than this many bytes, to bound memory use when fed hostile input.
   * @default 16 MiB
   */
  maxMessageLength?: number;
}

export class FountainDecoder {
  private readonly maxMessageLength: number;
  private expected?: { seqLength: number; messageLength: number; checksum: number; fragmentLength: number };
  private readonly simpleParts = new Map<number, Uint8Array>();
  private mixedParts = new Map<string, MixedPart>();
  private readonly queue: MixedPart[] = [];
  private message?: Uint8Array;
  private _processedPartsCount = 0;

  constructor(options: FountainDecoderOptions = {}) {
    this.maxMessageLength = options.maxMessageLength ?? 16 * 1024 * 1024;
  }

  get expectedPartCount(): number {
    return this.expected?.seqLength ?? 0;
  }

  /** Number of distinct pure fragments recovered so far. */
  get receivedFragmentCount(): number {
    return this.simpleParts.size;
  }

  get processedPartsCount(): number {
    return this._processedPartsCount;
  }

  isComplete(): boolean {
    return this.message !== undefined;
  }

  result(): Uint8Array | undefined {
    return this.message;
  }

  /** Rough completion estimate in [0, 1], following the reference heuristic. */
  estimatedPercentComplete(): number {
    if (this.message) return 1;
    if (!this.expected) return 0;
    const estimatedInputParts = this.expected.seqLength * 1.75;
    return Math.min(0.99, this._processedPartsCount / estimatedInputParts);
  }

  /**
   * Feeds one part to the decoder. Returns `false` if the part was ignored (already complete).
   * Throws {@link QRDecodeError} if the part is inconsistent with previously received parts.
   */
  receivePart(part: FountainPart): boolean {
    if (this.message) return false;
    this.validate(part);
    this.queue.push({ indexes: chooseFragments(part.seqNum, part.seqLength, part.checksum), data: part.data });
    this._processedPartsCount++;
    while (this.queue.length > 0 && !this.message) {
      const next = this.queue.shift()!;
      if (next.indexes.length === 1) this.processSimple(next);
      else this.processMixed(next);
    }
    return true;
  }

  private validate(part: FountainPart): void {
    if (!this.expected) {
      const { seqLength, messageLength, checksum } = part;
      const fragmentLength = part.data.length;
      if (seqLength < 1 || fragmentLength < 1) throw new QRDecodeError('Invalid fountain part dimensions');
      if (messageLength > this.maxMessageLength) throw new QRDecodeError('UR message exceeds maximum allowed size');
      if (messageLength > seqLength * fragmentLength || messageLength <= (seqLength - 1) * fragmentLength) {
        throw new QRDecodeError('Inconsistent fountain part dimensions');
      }
      this.expected = { seqLength, messageLength, checksum, fragmentLength };
      return;
    }
    const e = this.expected;
    if (
      part.seqLength !== e.seqLength ||
      part.messageLength !== e.messageLength ||
      part.checksum !== e.checksum ||
      part.data.length !== e.fragmentLength
    ) {
      throw new QRDecodeError('Fountain part does not belong to the current message');
    }
  }

  private processSimple(part: MixedPart): void {
    const index = part.indexes[0]!;
    if (this.simpleParts.has(index)) return;
    this.simpleParts.set(index, part.data);
    const e = this.expected!;
    if (this.simpleParts.size === e.seqLength) {
      const fragments: Uint8Array[] = [];
      for (let i = 0; i < e.seqLength; i++) fragments.push(this.simpleParts.get(i)!);
      const message = concatBytes(fragments).slice(0, e.messageLength);
      if (crc32(message) !== e.checksum) throw new QRDecodeError('UR message checksum mismatch');
      this.message = message;
      return;
    }
    this.reduceMixedBy(part);
  }

  private processMixed(part: MixedPart): void {
    if (this.mixedParts.has(part.indexes.join())) return;
    let reduced = part;
    for (const [index, data] of this.simpleParts) reduced = reduce(reduced, { indexes: [index], data });
    for (const mixed of this.mixedParts.values()) reduced = reduce(reduced, mixed);
    if (reduced.indexes.length === 0) return;
    if (reduced.indexes.length === 1) {
      this.queue.push(reduced);
    } else {
      this.reduceMixedBy(reduced);
      this.mixedParts.set(reduced.indexes.join(), reduced);
    }
  }

  private reduceMixedBy(by: MixedPart): void {
    const next = new Map<string, MixedPart>();
    for (const mixed of this.mixedParts.values()) {
      const reduced = reduce(mixed, by);
      if (reduced.indexes.length === 1) this.queue.push(reduced);
      else if (reduced.indexes.length > 1) next.set(reduced.indexes.join(), reduced);
    }
    this.mixedParts = next;
  }
}

/** If `b`'s fragments are a strict subset of `a`'s, XOR them out of `a`. */
function reduce(a: MixedPart, b: MixedPart): MixedPart {
  if (b.indexes.length >= a.indexes.length) return a;
  const aSet = new Set(a.indexes);
  if (!b.indexes.every((i) => aSet.has(i))) return a;
  const data = a.data.slice();
  xorInto(data, b.data);
  const bSet = new Set(b.indexes);
  return { indexes: a.indexes.filter((i) => !bSet.has(i)), data };
}

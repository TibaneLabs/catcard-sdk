import { QRDecodeError } from '../errors';
import { bytewordsDecodeMinimal } from './bytewords';
import { decodeFountainPart, FountainDecoder, type FountainDecoderOptions } from './fountain';
import { isValidURType, UR } from './ur';

export type URDecoderOptions = FountainDecoderOptions;

export function isURPart(text: string): boolean {
  return /^ur:/i.test(text);
}

interface ParsedURPart {
  type: string;
  seq?: { num: number; length: number };
  body: string;
}

function parseURPart(text: string): ParsedURPart {
  const lower = text.trim().toLowerCase();
  if (!lower.startsWith('ur:')) throw new QRDecodeError('Not a UR: missing "ur:" scheme');
  const components = lower.slice(3).split('/');
  const type = components[0]!;
  if (!isValidURType(type)) throw new QRDecodeError('Invalid UR type');
  if (components.length === 2) return { type, body: components[1]! };
  if (components.length === 3) {
    const m = /^([1-9][0-9]*)-([1-9][0-9]*)$/.exec(components[1]!);
    if (!m) throw new QRDecodeError('Invalid UR sequence component');
    return { type, seq: { num: Number(m[1]), length: Number(m[2]) }, body: components[2]! };
  }
  throw new QRDecodeError('Invalid UR path');
}

/** Decodes a single-part `ur:` string. */
export function decodeSinglePartUR(text: string): UR {
  const part = parseURPart(text);
  if (part.seq) throw new QRDecodeError('Expected a single-part UR');
  return new UR(part.type, bytewordsDecodeMinimal(part.body));
}

/** Accumulates `ur:` strings (single or multi-part, any order) until the UR is complete. */
export class URDecoder {
  private readonly fountain: FountainDecoder;
  private type?: string;
  private ur?: UR;

  constructor(options: URDecoderOptions = {}) {
    this.fountain = new FountainDecoder(options);
  }

  get expectedType(): string | undefined {
    return this.type;
  }

  get expectedPartCount(): number {
    return this.ur && !this.fountain.expectedPartCount ? 1 : this.fountain.expectedPartCount;
  }

  get receivedFragmentCount(): number {
    return this.ur && !this.fountain.expectedPartCount ? 1 : this.fountain.receivedFragmentCount;
  }

  estimatedPercentComplete(): number {
    return this.ur ? 1 : this.fountain.estimatedPercentComplete();
  }

  isComplete(): boolean {
    return this.ur !== undefined;
  }

  result(): UR | undefined {
    return this.ur;
  }

  /**
   * Feeds one scanned string. Returns `false` if it was ignored because decoding is already complete.
   * Throws {@link QRDecodeError} for malformed parts or parts from a different UR.
   */
  receivePart(text: string): boolean {
    if (this.ur) return false;
    const part = parseURPart(text);
    if (this.type !== undefined && part.type !== this.type) {
      throw new QRDecodeError(`UR type changed from ${this.type} to ${part.type}`);
    }
    if (!part.seq) {
      this.type = part.type;
      this.ur = new UR(part.type, bytewordsDecodeMinimal(part.body));
      return true;
    }
    const fountainPart = decodeFountainPart(bytewordsDecodeMinimal(part.body));
    if (fountainPart.seqNum !== part.seq.num || fountainPart.seqLength !== part.seq.length) {
      throw new QRDecodeError('UR sequence component does not match part header');
    }
    this.fountain.receivePart(fountainPart);
    this.type = part.type;
    const message = this.fountain.result();
    if (message) this.ur = new UR(part.type, message);
    return true;
  }
}

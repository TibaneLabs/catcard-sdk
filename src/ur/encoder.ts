import { bytewordsEncodeMinimal } from './bytewords';
import { encodeFountainPart, FountainEncoder } from './fountain';
import type { UR } from './ur';

export interface UREncoderOptions {
  /** Maximum fragment payload per QR, in bytes. @default 100 */
  maxFragmentLength?: number;
  /** @default 10 */
  minFragmentLength?: number;
  /** @default 0 */
  firstSeqNum?: number;
}

/**
 * Produces the (potentially endless) stream of `ur:` strings for a UR. The first
 * {@link fragmentCount} parts are the pure fragments; after that, fountain-coded
 * mixes follow so a scanner that missed frames can still complete.
 */
export class UREncoder {
  private readonly fountain: FountainEncoder;

  constructor(
    readonly ur: UR,
    options: UREncoderOptions = {},
  ) {
    this.fountain = new FountainEncoder(
      ur.cbor,
      options.maxFragmentLength ?? 100,
      options.firstSeqNum ?? 0,
      options.minFragmentLength ?? 10,
    );
  }

  get fragmentCount(): number {
    return this.fountain.seqLength;
  }

  isSinglePart(): boolean {
    return this.fountain.isSinglePart();
  }

  /** Next part as a lowercase `ur:` string. Uppercase it for denser (alphanumeric mode) QR codes. */
  nextPart(): string {
    if (this.fountain.isSinglePart()) return encodeSinglePartUR(this.ur);
    const part = this.fountain.nextPart();
    const body = bytewordsEncodeMinimal(encodeFountainPart(part));
    return `ur:${this.ur.type}/${part.seqNum}-${part.seqLength}/${body}`;
  }
}

export function encodeSinglePartUR(ur: UR): string {
  return `ur:${ur.type}/${bytewordsEncodeMinimal(ur.cbor)}`;
}

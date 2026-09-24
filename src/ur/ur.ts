import { cborDecode, cborEncode, type CborValue } from '../cbor';
import { CatCardError } from '../errors';

const TYPE_RE = /^[a-z0-9-]+$/;

export function isValidURType(type: string): boolean {
  return TYPE_RE.test(type);
}

/** A Uniform Resource: a registry type name plus its CBOR-encoded payload. */
export class UR {
  constructor(
    readonly type: string,
    readonly cbor: Uint8Array,
  ) {
    if (!isValidURType(type)) throw new CatCardError(`Invalid UR type: ${JSON.stringify(type)}`);
  }

  /** Wraps raw bytes as a CBOR byte string, e.g. for `crypto-psbt` or `bytes`. */
  static fromBytes(bytes: Uint8Array, type = 'bytes'): UR {
    return new UR(type, cborEncode(bytes));
  }

  static fromValue(value: CborValue, type: string): UR {
    return new UR(type, cborEncode(value));
  }

  decodeCbor(): CborValue {
    return cborDecode(this.cbor);
  }

  /** Unwraps a UR whose payload is a single CBOR byte string. */
  toBytes(): Uint8Array {
    const value = this.decodeCbor();
    if (!(value instanceof Uint8Array)) throw new CatCardError(`UR ${this.type} payload is not a byte string`);
    return value;
  }
}

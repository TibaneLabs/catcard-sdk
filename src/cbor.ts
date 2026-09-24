// Minimal CBOR (RFC 8949) codec covering what BC-UR registry types need.
//
// Mapping between CBOR and JavaScript values:
//   unsigned / negative int  <->  number (safe integers) or bigint (beyond 2^53)
//   byte string              <->  Uint8Array
//   text string              <->  string
//   array                    <->  Array
//   map                      <->  Map (keys keep their CBOR type)
//   tag                      <->  CborTag
//   false / true / null / undefined  <->  same
//   float                    <-   number (decode only)
//
// Only definite-length items are supported, which is what deterministic CBOR (and thus UR) uses.

import { utf8Decode, utf8Encode } from './util/bytes';

export class CborTag {
  constructor(
    readonly tag: number,
    readonly value: CborValue,
  ) {}
}

export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>
  | CborTag;

const MAX_DEPTH = 64;

export function cborEncode(value: CborValue): Uint8Array {
  const out: number[] = [];
  encodeItem(value, out, 0);
  return Uint8Array.from(out);
}

function writeHead(major: number, arg: number | bigint, out: number[]): void {
  const n = BigInt(arg);
  if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError('CBOR argument out of range');
  const m = major << 5;
  if (n < 24n) {
    out.push(m | Number(n));
  } else if (n <= 0xffn) {
    out.push(m | 24, Number(n));
  } else if (n <= 0xffffn) {
    out.push(m | 25, Number(n >> 8n), Number(n & 0xffn));
  } else if (n <= 0xffffffffn) {
    out.push(m | 26);
    for (let s = 24n; s >= 0n; s -= 8n) out.push(Number((n >> s) & 0xffn));
  } else {
    out.push(m | 27);
    for (let s = 56n; s >= 0n; s -= 8n) out.push(Number((n >> s) & 0xffn));
  }
}

function encodeItem(value: CborValue, out: number[], depth: number): void {
  if (depth > MAX_DEPTH) throw new RangeError('CBOR nesting too deep');
  if (typeof value === 'number' || typeof value === 'bigint') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new TypeError(`Only safe integers can be CBOR-encoded as numbers (got ${value})`);
    }
    const n = BigInt(value);
    if (n >= 0n) writeHead(0, n, out);
    else writeHead(1, -1n - n, out);
  } else if (typeof value === 'string') {
    const bytes = utf8Encode(value);
    writeHead(3, bytes.length, out);
    for (const b of bytes) out.push(b);
  } else if (value instanceof Uint8Array) {
    writeHead(2, value.length, out);
    for (const b of value) out.push(b);
  } else if (Array.isArray(value)) {
    writeHead(4, value.length, out);
    for (const item of value) encodeItem(item, out, depth + 1);
  } else if (value instanceof Map) {
    writeHead(5, value.size, out);
    for (const [k, v] of value) {
      encodeItem(k, out, depth + 1);
      encodeItem(v, out, depth + 1);
    }
  } else if (value instanceof CborTag) {
    writeHead(6, value.tag, out);
    encodeItem(value.value, out, depth + 1);
  } else if (value === false) {
    out.push(0xf4);
  } else if (value === true) {
    out.push(0xf5);
  } else if (value === null) {
    out.push(0xf6);
  } else if (value === undefined) {
    out.push(0xf7);
  } else {
    throw new TypeError('Unsupported value for CBOR encoding');
  }
}

export function cborDecode(data: Uint8Array): CborValue {
  const reader = new Reader(data);
  const value = reader.item(0);
  if (reader.pos !== data.length) throw new SyntaxError('Trailing bytes after CBOR item');
  return value;
}

class Reader {
  pos = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.data.length) throw new SyntaxError('Unexpected end of CBOR data');
  }

  private byte(): number {
    this.need(1);
    return this.data[this.pos++]!;
  }

  private argument(info: number): bigint {
    if (info < 24) return BigInt(info);
    let size: number;
    if (info === 24) size = 1;
    else if (info === 25) size = 2;
    else if (info === 26) size = 4;
    else if (info === 27) size = 8;
    else throw new SyntaxError(`Unsupported CBOR additional info ${info}`);
    this.need(size);
    let n = 0n;
    for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(this.data[this.pos++]!);
    return n;
  }

  private length(info: number): number {
    const n = this.argument(info);
    // Every element occupies at least one byte, so no valid length can exceed what is left.
    if (n > BigInt(this.data.length - this.pos)) {
      throw new SyntaxError('CBOR length exceeds input size');
    }
    return Number(n);
  }

  private bytes(len: number): Uint8Array {
    this.need(len);
    const out = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new SyntaxError('CBOR nesting too deep');
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0:
        return toNumber(this.argument(info));
      case 1:
        return toNumber(-1n - this.argument(info));
      case 2:
        return this.bytes(this.length(info));
      case 3:
        return utf8Decode(this.bytes(this.length(info)));
      case 4: {
        const len = this.length(info);
        const arr: CborValue[] = [];
        for (let i = 0; i < len; i++) arr.push(this.item(depth + 1));
        return arr;
      }
      case 5: {
        const len = this.length(info);
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < len; i++) {
          const key = this.item(depth + 1);
          map.set(key, this.item(depth + 1));
        }
        return map;
      }
      case 6: {
        const tag = this.argument(info);
        if (tag > BigInt(Number.MAX_SAFE_INTEGER)) throw new SyntaxError('CBOR tag too large');
        return new CborTag(Number(tag), this.item(depth + 1));
      }
      default:
        return this.simple(info);
    }
  }

  private simple(info: number): CborValue {
    switch (info) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 25: {
        this.need(2);
        const half = this.view.getUint16(this.pos);
        this.pos += 2;
        return decodeHalf(half);
      }
      case 26: {
        this.need(4);
        const v = this.view.getFloat32(this.pos);
        this.pos += 4;
        return v;
      }
      case 27: {
        this.need(8);
        const v = this.view.getFloat64(this.pos);
        this.pos += 8;
        return v;
      }
      default:
        throw new SyntaxError(`Unsupported CBOR simple value ${info}`);
    }
  }
}

function toNumber(n: bigint): number | bigint {
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

function decodeHalf(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exp = (half >> 10) & 0x1f;
  const mant = half & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

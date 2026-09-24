import { CborTag, type CborValue } from '../cbor';
import { QRDecodeError } from '../errors';

export type CborMap = Map<CborValue, CborValue>;

/** Builds a CBOR map with integer keys in ascending order, skipping undefined values. */
export function intKeyMap(entries: Record<number, CborValue | undefined>): CborMap {
  const map: CborMap = new Map();
  for (const key of Object.keys(entries).map(Number).sort((a, b) => a - b)) {
    const value = entries[key];
    if (value !== undefined) map.set(key, value);
  }
  return map;
}

export function expectMap(value: CborValue, what: string): CborMap {
  if (!(value instanceof Map)) throw new QRDecodeError(`${what}: expected a CBOR map`);
  return value;
}

/** Strips a CBOR tag if present, checking it when `tag` is given. */
export function untag(value: CborValue, tag?: number): CborValue {
  if (value instanceof CborTag) {
    if (tag !== undefined && value.tag !== tag) throw new QRDecodeError(`Unexpected CBOR tag ${value.tag}, expected ${tag}`);
    return value.value;
  }
  return value;
}

export function optBytes(map: CborMap, key: number, what: string): Uint8Array | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  const inner = untag(value);
  if (!(inner instanceof Uint8Array)) throw new QRDecodeError(`${what}: field ${key} must be bytes`);
  return inner;
}

export function reqBytes(map: CborMap, key: number, what: string): Uint8Array {
  const value = optBytes(map, key, what);
  if (!value) throw new QRDecodeError(`${what}: missing field ${key}`);
  return value;
}

export function optUint(map: CborMap, key: number, what: string): number | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new QRDecodeError(`${what}: field ${key} must be an unsigned integer`);
  }
  return value;
}

export function optText(map: CborMap, key: number, what: string): string | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new QRDecodeError(`${what}: field ${key} must be text`);
  return value;
}

export function optBool(map: CborMap, key: number, what: string): boolean | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new QRDecodeError(`${what}: field ${key} must be a boolean`);
  return value;
}

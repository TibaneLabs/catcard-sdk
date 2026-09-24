import { inflateRaw } from 'pako';
import { QRDecodeError } from '../errors';
import { base32Decode } from '../util/base32';
import { concatBytes, hexToBytes } from '../util/bytes';
import { BBQR_HEADER_LENGTH, type BBQrEncoding } from './constants';

export interface BBQrPartHeader {
  encoding: BBQrEncoding;
  fileType: string;
  total: number;
  index: number;
}

export interface BBQrJoinResult {
  encoding: BBQrEncoding;
  fileType: string;
  data: Uint8Array;
}

const HEADER_RE = /^B\$([HZ2])([A-Z])([0-9A-Z]{2})([0-9A-Z]{2})/;

export function isBBQrPart(text: string): boolean {
  return text.startsWith('B$');
}

export function parseBBQrHeader(part: string): BBQrPartHeader {
  const m = HEADER_RE.exec(part);
  if (!m) throw new QRDecodeError('Not a valid BBQr part header');
  const total = parseInt(m[3]!, 36);
  const index = parseInt(m[4]!, 36);
  if (total < 1) throw new QRDecodeError('BBQr part count must be at least 1');
  if (index >= total) throw new QRDecodeError(`BBQr part index ${index} out of range (total ${total})`);
  return { encoding: m[1] as BBQrEncoding, fileType: m[2]!, total, index };
}

function decodeBody(body: string, encoding: BBQrEncoding): Uint8Array {
  try {
    return encoding === 'H' ? hexToBytes(body) : base32Decode(body);
  } catch (e) {
    throw new QRDecodeError(`Invalid BBQr part body: ${(e as Error).message}`);
  }
}

/** Decodes the ordered bodies of a complete BBQr sequence into the original bytes. */
export function decodeBBQrBodies(bodies: readonly string[], encoding: BBQrEncoding): Uint8Array {
  const joined = concatBytes(bodies.map((b) => decodeBody(b, encoding)));
  if (encoding !== 'Z') return joined;
  try {
    return inflateRaw(joined, { windowBits: 10 });
  } catch (e) {
    throw new QRDecodeError(`BBQr decompression failed: ${String(e)}`);
  }
}

/** Joins a complete set of BBQr parts (in any order, duplicates allowed). */
export function bbqrJoin(parts: readonly string[]): BBQrJoinResult {
  if (parts.length === 0) throw new QRDecodeError('No BBQr parts given');
  const first = parseBBQrHeader(parts[0]!);
  const bodies = new Map<number, string>();
  for (const part of parts) {
    const header = parseBBQrHeader(part);
    if (header.encoding !== first.encoding || header.fileType !== first.fileType || header.total !== first.total) {
      throw new QRDecodeError('BBQr parts belong to different sequences');
    }
    const body = part.slice(BBQR_HEADER_LENGTH);
    const existing = bodies.get(header.index);
    if (existing !== undefined && existing !== body) {
      throw new QRDecodeError(`BBQr part ${header.index} received twice with different content`);
    }
    bodies.set(header.index, body);
  }
  const ordered: string[] = [];
  for (let i = 0; i < first.total; i++) {
    const body = bodies.get(i);
    if (body === undefined) throw new QRDecodeError(`BBQr part ${i} is missing`);
    ordered.push(body);
  }
  return { encoding: first.encoding, fileType: first.fileType, data: decodeBBQrBodies(ordered, first.encoding) };
}

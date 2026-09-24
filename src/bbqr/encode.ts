import { deflateRaw } from 'pako';
import { QREncodeError } from '../errors';
import { base32Encode } from '../util/base32';
import { bytesToHex } from '../util/bytes';
import {
  BBQR_HEADER_LENGTH,
  BBQR_MAX_PARTS,
  BBQR_SPLIT_MOD,
  QR_ALPHANUMERIC_CAPACITY_L,
  type BBQrEncoding,
  type BBQrFileType,
} from './constants';

export interface BBQrSplitOptions {
  /**
   * Requested encoding. With `Z` (the default), falls back to `2` when compression does not help.
   * @default 'Z'
   */
  encoding?: BBQrEncoding;
  /** @default 1 */
  minSplit?: number;
  /** @default 1295 */
  maxSplit?: number;
  /** Smallest QR version to use. @default 5 */
  minVersion?: number;
  /**
   * Largest QR version to use. Dense QR codes are hard to scan on small screens and
   * slow camera modules, so this can be lowered to trade frame count for readability.
   * @default 40
   */
  maxVersion?: number;
}

export interface BBQrSplitResult {
  /** QR version each part was sized for (alphanumeric mode, error correction L). */
  version: number;
  /** Encoding actually used. */
  encoding: BBQrEncoding;
  fileType: string;
  /** QR payload strings, in order. */
  parts: string[];
}

export function toBase36(n: number): string {
  return n.toString(36).toUpperCase().padStart(2, '0');
}

function encodeData(data: Uint8Array, encoding: BBQrEncoding): { encoding: BBQrEncoding; encoded: string } {
  if (encoding === 'H') return { encoding, encoded: bytesToHex(data).toUpperCase() };
  if (encoding === 'Z') {
    const compressed = deflateRaw(data, { windowBits: 10, level: 9 });
    if (compressed.length < data.length) return { encoding: 'Z', encoded: base32Encode(compressed) };
    encoding = '2';
  }
  return { encoding, encoded: base32Encode(data) };
}

function partsForVersion(version: number, length: number, encoding: BBQrEncoding): { count: number; perPart: number } {
  const capacity = QR_ALPHANUMERIC_CAPACITY_L[version - 1]! - BBQR_HEADER_LENGTH;
  const mod = BBQR_SPLIT_MOD[encoding];
  const perPart = capacity - (capacity % mod);
  return { count: Math.max(1, Math.ceil(length / perPart)), perPart };
}

/**
 * Encodes `data` as a sequence of BBQr QR payloads, choosing the QR version that
 * yields the fewest parts (and the smallest version among equals).
 */
export function bbqrSplit(data: Uint8Array, fileType: BBQrFileType, options: BBQrSplitOptions = {}): BBQrSplitResult {
  if (!/^[A-Z]$/.test(fileType)) throw new QREncodeError('BBQr file type must be a single uppercase letter');
  const minVersion = options.minVersion ?? 5;
  const maxVersion = options.maxVersion ?? 40;
  const minSplit = options.minSplit ?? 1;
  const maxSplit = options.maxSplit ?? BBQR_MAX_PARTS;
  if (!(1 <= minVersion && minVersion <= maxVersion && maxVersion <= 40)) {
    throw new QREncodeError('min/max QR version out of range');
  }
  if (!(1 <= minSplit && minSplit <= maxSplit && maxSplit <= BBQR_MAX_PARTS)) {
    throw new QREncodeError('min/max split out of range');
  }

  const { encoding, encoded } = encodeData(data, options.encoding ?? 'Z');

  let best: { version: number; count: number; perPart: number } | undefined;
  for (let version = minVersion; version <= maxVersion; version++) {
    const { count, perPart } = partsForVersion(version, encoded.length, encoding);
    if (count < minSplit || count > maxSplit) continue;
    if (!best || count < best.count) best = { version, count, perPart };
  }
  if (!best) throw new QREncodeError('Data does not fit within the requested split/version limits');

  const header = `B$${encoding}${fileType}${toBase36(best.count)}`;
  const parts: string[] = [];
  for (let i = 0; i < best.count; i++) {
    parts.push(header + toBase36(i) + encoded.slice(i * best.perPart, (i + 1) * best.perPart));
  }
  return { version: best.version, encoding, fileType, parts };
}

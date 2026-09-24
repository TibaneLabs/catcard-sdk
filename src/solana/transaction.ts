// Solana wire-format transactions: just enough parsing to find a signer's slot and fill it in.

import { CatCardError } from '../errors';
import { equalBytes } from '../util/bytes';

export interface ParsedSolanaTransaction {
  version: 'legacy' | 0 | 1;
  /** Byte offset of each signature slot in the transaction. */
  signatureOffsets: number[];
  /** The message bytes: what signers sign. */
  message: Uint8Array;
  /** Public keys of the required signers, in slot order. */
  signers: Uint8Array[];
}

function readShortVec(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) throw new CatCardError('Truncated Solana transaction');
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return [value, offset + i + 1];
  }
  throw new CatCardError('Invalid compact-u16 in Solana transaction');
}

/** First byte of a v1 (SIMD-0385) transaction. Legacy and v0 ones start with a signature count, always below 128. */
const V1_VERSION_BYTE = 0x81;

// v1 layout: version byte, 3-byte header, u32 config mask, 32-byte lifetime, u8 instruction count, u8 address count,
// addresses, config values (4 bytes per mask bit), instruction headers (u8 program, u8 accounts, u16 data length),
// instruction payloads (account indices then data), then the signatures, with no length prefix.
function parseV1Transaction(tx: Uint8Array): ParsedSolanaTransaction {
  const truncated = () => new CatCardError('Truncated Solana transaction');
  if (tx.length < 42) throw truncated();
  const requiredSignatures = tx[1]!;
  const configMask = (tx[4]! | (tx[5]! << 8) | (tx[6]! << 16) | (tx[7]! << 24)) >>> 0;
  const instructionCount = tx[40]!;
  const addressCount = tx[41]!;
  if (addressCount < requiredSignatures) throw new CatCardError('Malformed Solana transaction account keys');
  const keysStart = 42;
  let configCount = 0;
  for (let mask = configMask; mask; mask >>>= 1) configCount += mask & 1;
  const headersStart = keysStart + addressCount * 32 + configCount * 4;
  let offset = headersStart + instructionCount * 4;
  if (offset > tx.length) throw truncated();
  for (let i = 0; i < instructionCount; i++) {
    const header = headersStart + i * 4;
    offset += tx[header + 1]! + (tx[header + 2]! | (tx[header + 3]! << 8));
  }
  const end = offset + requiredSignatures * 64;
  if (end > tx.length) throw truncated();
  if (end < tx.length) throw new CatCardError('Trailing data after Solana transaction signatures');
  return {
    version: 1,
    signatureOffsets: Array.from({ length: requiredSignatures }, (_, i) => offset + i * 64),
    message: tx.subarray(0, offset),
    signers: Array.from({ length: requiredSignatures }, (_, i) => tx.subarray(keysStart + i * 32, keysStart + (i + 1) * 32)),
  };
}

export function parseSolanaTransaction(tx: Uint8Array): ParsedSolanaTransaction {
  if (tx[0] === V1_VERSION_BYTE) return parseV1Transaction(tx);
  const [signatureCount, afterCount] = readShortVec(tx, 0);
  const signatureOffsets = Array.from({ length: signatureCount }, (_, i) => afterCount + i * 64);
  const messageStart = afterCount + signatureCount * 64;
  const message = tx.subarray(messageStart);
  if (message.length < 4) throw new CatCardError('Truncated Solana transaction');

  let headerOffset = 0;
  let version: ParsedSolanaTransaction['version'] = 'legacy';
  if (message[0]! & 0x80) {
    const v = message[0]! & 0x7f;
    if (v !== 0) throw new CatCardError(`Unsupported Solana transaction version ${v}`);
    version = 0;
    headerOffset = 1;
  }
  const requiredSignatures = message[headerOffset]!;
  if (requiredSignatures !== signatureCount) {
    throw new CatCardError('Solana transaction signature count does not match its message header');
  }
  const [keyCount, keysStart] = readShortVec(message, headerOffset + 3);
  if (keyCount < requiredSignatures || keysStart + keyCount * 32 > message.length) {
    throw new CatCardError('Malformed Solana transaction account keys');
  }
  const signers = Array.from({ length: requiredSignatures }, (_, i) => message.subarray(keysStart + i * 32, keysStart + (i + 1) * 32));
  return { version, signatureOffsets, message, signers };
}

/** Returns a copy of `tx` with `signature` placed in `publicKey`'s signature slot. */
export function addSolanaSignature(tx: Uint8Array, publicKey: Uint8Array, signature: Uint8Array): Uint8Array {
  const parsed = parseSolanaTransaction(tx);
  const index = parsed.signers.findIndex((s) => equalBytes(s, publicKey));
  if (index < 0) throw new CatCardError('This account is not a signer of the transaction');
  // Copy with the Uint8Array constructor: a Node Buffer's slice() would alias the caller's bytes.
  const out = new Uint8Array(tx);
  out.set(signature, parsed.signatureOffsets[index]);
  return out;
}

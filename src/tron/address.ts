import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { createBase58check } from '@scure/base';
import { CatCardError } from '../errors';
import { bytesToHex, hexToBytes } from '../util/bytes';
import { uncompressPublicKey } from '../util/secp';

const base58check = createBase58check(sha256);

/** 21-byte Tron address (0x41 prefix) from a compressed secp256k1 public key. */
export function tronAddressBytes(publicKey: Uint8Array): Uint8Array {
  const hash = keccak_256(uncompressPublicKey(publicKey).subarray(1));
  const out = new Uint8Array(21);
  out[0] = 0x41;
  out.set(hash.subarray(12), 1);
  return out;
}

/** Base58 (`T...`) form of a 21-byte address. */
export function tronAddressToBase58(bytes: Uint8Array): string {
  return base58check.encode(bytes);
}

/** Accepts a base58 (`T...`) or hex (`41...`) address and returns its 21 bytes. */
export function tronAddressFromString(address: string): Uint8Array {
  let bytes: Uint8Array;
  if (/^(0x)?41[0-9a-fA-F]{40}$/.test(address)) bytes = hexToBytes(address.replace(/^0x/, ''));
  else {
    try {
      bytes = base58check.decode(address);
    } catch {
      throw new CatCardError(`Invalid Tron address: ${address}`);
    }
  }
  if (bytes.length !== 21 || bytes[0] !== 0x41) throw new CatCardError(`Invalid Tron address: ${address}`);
  return bytes;
}

export function tronAddressToHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

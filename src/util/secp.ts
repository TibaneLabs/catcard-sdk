import { secp256k1 } from '@noble/curves/secp256k1';
import { QRDecodeError } from '../errors';
import { equalBytes } from './bytes';

export interface RecoveredSignature {
  r: bigint;
  s: bigint;
  /** Recovery bit for the (low-s normalized) signature. */
  recovery: 0 | 1;
}

/**
 * Finds which recovery bit makes `r || s` a signature of `hash` by `publicKey` (33-byte
 * compressed), whatever `v` convention the device used, and normalizes to low-s.
 */
export function recoverSignature(hash: Uint8Array, rs: Uint8Array, publicKey: Uint8Array, message: string): RecoveredSignature {
  let sig;
  try {
    sig = secp256k1.Signature.fromCompact(rs.subarray(0, 64));
  } catch {
    throw new QRDecodeError('Malformed signature');
  }
  for (const recovery of [0, 1] as const) {
    let recovered: Uint8Array;
    try {
      recovered = sig.addRecoveryBit(recovery).recoverPublicKey(hash).toRawBytes(true);
    } catch {
      continue;
    }
    if (!equalBytes(recovered, publicKey)) continue;
    const high = sig.hasHighS();
    return { r: sig.r, s: high ? secp256k1.CURVE.n - sig.s : sig.s, recovery: (high ? 1 - recovery : recovery) as 0 | 1 };
  }
  throw new QRDecodeError(message);
}

export function uncompressPublicKey(publicKey: Uint8Array): Uint8Array {
  return secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
}

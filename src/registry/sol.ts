import { CborTag } from '../cbor';
import { QRDecodeError } from '../errors';
import { UR } from '../ur';
import { expectMap, intKeyMap, optBytes, optText, optUint, reqBytes } from './cbor-helpers';
import { KeyPath } from './keypath';
import { TAGS } from './tags';

/** `sign-type` values of `sol-sign-request`. */
export const SolSignType = {
  /** Serialized transaction message (legacy or versioned). */
  Transaction: 1,
  /** Off-chain message bytes. */
  Message: 2,
} as const;

export type SolSignType = (typeof SolSignType)[keyof typeof SolSignType];

export interface SolSignRequest {
  requestId: Uint8Array;
  signData: Uint8Array;
  derivationPath: KeyPath;
  /** 32-byte public key. */
  address?: Uint8Array;
  origin?: string;
  signType: SolSignType;
}

export interface SolSignature {
  requestId?: Uint8Array;
  /** 64-byte ed25519 signature. */
  signature: Uint8Array;
}

export function encodeSolSignRequest(req: SolSignRequest): UR {
  return UR.fromValue(
    intKeyMap({
      1: new CborTag(TAGS.uuid, req.requestId),
      2: req.signData,
      3: req.derivationPath.toTagged(),
      4: req.address,
      5: req.origin,
      6: req.signType,
    }),
    'sol-sign-request',
  );
}

export function decodeSolSignRequest(ur: UR): SolSignRequest {
  if (ur.type !== 'sol-sign-request') throw new QRDecodeError(`Expected ur:sol-sign-request, got ur:${ur.type}`);
  const w = 'sol-sign-request';
  const map = expectMap(ur.decodeCbor(), w);
  const path = map.get(3);
  if (path === undefined) throw new QRDecodeError(`${w}: missing derivation path`);
  return {
    requestId: reqBytes(map, 1, w),
    signData: reqBytes(map, 2, w),
    derivationPath: KeyPath.fromCbor(path),
    address: optBytes(map, 4, w),
    origin: optText(map, 5, w),
    signType: (optUint(map, 6, w) ?? SolSignType.Transaction) as SolSignType,
  };
}

export function encodeSolSignature(sig: SolSignature): UR {
  return UR.fromValue(intKeyMap({ 1: sig.requestId && new CborTag(TAGS.uuid, sig.requestId), 2: sig.signature }), 'sol-signature');
}

export function decodeSolSignature(ur: UR): SolSignature {
  if (ur.type !== 'sol-signature') throw new QRDecodeError(`Expected ur:sol-signature, got ur:${ur.type}`);
  const map = expectMap(ur.decodeCbor(), 'sol-signature');
  const signature = reqBytes(map, 2, 'sol-signature');
  if (signature.length !== 64) throw new QRDecodeError('sol-signature: signature must be 64 bytes');
  return { requestId: optBytes(map, 1, 'sol-signature'), signature };
}

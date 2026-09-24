import { CborTag } from '../cbor';
import { QRDecodeError } from '../errors';
import { UR } from '../ur';
import { expectMap, intKeyMap, optBytes, optText, optUint, reqBytes } from './cbor-helpers';
import { KeyPath } from './keypath';
import { TAGS } from './tags';

/** `data-type` values of `eth-sign-request`. */
export const EthDataType = {
  /** Legacy (EIP-155) transaction, RLP-encoded for signing. */
  Transaction: 1,
  /** EIP-712 typed data, as UTF-8 JSON. */
  TypedData: 2,
  /** `personal_sign` message bytes (the device adds the EIP-191 prefix). */
  PersonalMessage: 3,
  /** EIP-2718 typed transaction, unsigned serialization. */
  TypedTransaction: 4,
} as const;

export type EthDataType = (typeof EthDataType)[keyof typeof EthDataType];

export interface EthSignRequest {
  requestId: Uint8Array;
  signData: Uint8Array;
  dataType: EthDataType;
  chainId?: number;
  derivationPath: KeyPath;
  /** 20-byte address. */
  address?: Uint8Array;
  origin?: string;
}

export interface EthSignature {
  requestId?: Uint8Array;
  /** r (32) || s (32) || v (1 or more bytes). */
  signature: Uint8Array;
  origin?: string;
}

export function encodeEthSignRequest(req: EthSignRequest): UR {
  return UR.fromValue(
    intKeyMap({
      1: new CborTag(TAGS.uuid, req.requestId),
      2: req.signData,
      3: req.dataType,
      4: req.chainId,
      5: req.derivationPath.toTagged(),
      6: req.address,
      7: req.origin,
    }),
    'eth-sign-request',
  );
}

export function decodeEthSignRequest(ur: UR): EthSignRequest {
  if (ur.type !== 'eth-sign-request') throw new QRDecodeError(`Expected ur:eth-sign-request, got ur:${ur.type}`);
  const map = expectMap(ur.decodeCbor(), 'eth-sign-request');
  const w = 'eth-sign-request';
  const path = map.get(5);
  if (path === undefined) throw new QRDecodeError(`${w}: missing derivation path`);
  return {
    requestId: reqBytes(map, 1, w),
    signData: reqBytes(map, 2, w),
    dataType: optUint(map, 3, w) as EthDataType,
    chainId: optUint(map, 4, w),
    derivationPath: KeyPath.fromCbor(path),
    address: optBytes(map, 6, w),
    origin: optText(map, 7, w),
  };
}

export function encodeEthSignature(sig: EthSignature): UR {
  return UR.fromValue(
    intKeyMap({ 1: sig.requestId && new CborTag(TAGS.uuid, sig.requestId), 2: sig.signature, 3: sig.origin }),
    'eth-signature',
  );
}

export function decodeEthSignature(ur: UR): EthSignature {
  if (ur.type !== 'eth-signature') throw new QRDecodeError(`Expected ur:eth-signature, got ur:${ur.type}`);
  const map = expectMap(ur.decodeCbor(), 'eth-signature');
  const signature = reqBytes(map, 2, 'eth-signature');
  if (signature.length < 65) throw new QRDecodeError('eth-signature: signature too short');
  return { requestId: optBytes(map, 1, 'eth-signature'), signature, origin: optText(map, 3, 'eth-signature') };
}

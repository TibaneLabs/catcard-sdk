import { CborTag } from '../cbor';
import { QRDecodeError } from '../errors';
import { UR } from '../ur';
import { expectMap, intKeyMap, optBytes, optText, optUint, reqBytes } from './cbor-helpers';
import { KeyPath } from './keypath';
import { TAGS } from './tags';

/** `data-type` values of `tron-sign-request`. */
export const TronDataType = {
  /** Transaction `raw_data` (protobuf bytes, i.e. `raw_data_hex`). */
  Transaction: 1,
  /** Message bytes; the device applies the TIP-191 prefix (`signMessageV2`). */
  PersonalMessage: 2,
} as const;

export type TronDataType = (typeof TronDataType)[keyof typeof TronDataType];

export interface TronSignRequest {
  requestId: Uint8Array;
  signData: Uint8Array;
  dataType: TronDataType;
  derivationPath: KeyPath;
  /** 21-byte address (0x41 prefix + 20 bytes). */
  address?: Uint8Array;
  origin?: string;
}

export interface TronSignature {
  requestId?: Uint8Array;
  /** r (32) || s (32) || v (1). */
  signature: Uint8Array;
}

export function encodeTronSignRequest(req: TronSignRequest): UR {
  return UR.fromValue(
    intKeyMap({
      1: new CborTag(TAGS.uuid, req.requestId),
      2: req.signData,
      3: req.dataType,
      4: req.derivationPath.toTagged(),
      5: req.address,
      6: req.origin,
    }),
    'tron-sign-request',
  );
}

export function decodeTronSignRequest(ur: UR): TronSignRequest {
  const w = 'tron-sign-request';
  if (ur.type !== w) throw new QRDecodeError(`Expected ur:${w}, got ur:${ur.type}`);
  const map = expectMap(ur.decodeCbor(), w);
  const path = map.get(4);
  if (path === undefined) throw new QRDecodeError(`${w}: missing derivation path`);
  return {
    requestId: reqBytes(map, 1, w),
    signData: reqBytes(map, 2, w),
    dataType: optUint(map, 3, w) as TronDataType,
    derivationPath: KeyPath.fromCbor(path),
    address: optBytes(map, 5, w),
    origin: optText(map, 6, w),
  };
}

export function encodeTronSignature(sig: TronSignature): UR {
  return UR.fromValue(intKeyMap({ 1: sig.requestId && new CborTag(TAGS.uuid, sig.requestId), 2: sig.signature }), 'tron-signature');
}

export function decodeTronSignature(ur: UR): TronSignature {
  const w = 'tron-signature';
  if (ur.type !== w) throw new QRDecodeError(`Expected ur:${w}, got ur:${ur.type}`);
  const map = expectMap(ur.decodeCbor(), w);
  const signature = reqBytes(map, 2, w);
  if (signature.length < 65) throw new QRDecodeError(`${w}: signature too short`);
  return { requestId: optBytes(map, 1, w), signature };
}

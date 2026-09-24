import { CborTag } from '../cbor';
import { QRDecodeError } from '../errors';
import { UR } from '../ur';
import { expectMap, intKeyMap, optBytes, optText, optUint, reqBytes } from './cbor-helpers';
import { KeyPath } from './keypath';
import { TAGS } from './tags';

/** `data-type` values of `btc-sign-request`. Transactions go through PSBTs instead. */
export const BtcDataType = {
  /** Message signed with the "Bitcoin Signed Message" scheme. */
  Message: 1,
} as const;

export type BtcDataType = (typeof BtcDataType)[keyof typeof BtcDataType];

export interface BtcSignRequest {
  requestId: Uint8Array;
  signData: Uint8Array;
  dataType: BtcDataType;
  derivationPaths: KeyPath[];
  addresses?: string[];
  origin?: string;
}

export interface BtcSignature {
  requestId?: Uint8Array;
  signature: Uint8Array;
  publicKey?: Uint8Array;
}

export function encodeBtcSignRequest(req: BtcSignRequest): UR {
  return UR.fromValue(
    intKeyMap({
      1: new CborTag(TAGS.uuid, req.requestId),
      2: req.signData,
      3: req.dataType,
      4: req.derivationPaths.map((p) => p.toTagged()),
      5: req.addresses,
      6: req.origin,
    }),
    'btc-sign-request',
  );
}

export function decodeBtcSignRequest(ur: UR): BtcSignRequest {
  const w = 'btc-sign-request';
  if (ur.type !== w) throw new QRDecodeError(`Expected ur:${w}, got ur:${ur.type}`);
  const map = expectMap(ur.decodeCbor(), w);
  const paths = map.get(4);
  const addresses = map.get(5);
  if (!Array.isArray(paths)) throw new QRDecodeError(`${w}: missing derivation paths`);
  if (addresses !== undefined && !(Array.isArray(addresses) && addresses.every((a) => typeof a === 'string'))) {
    throw new QRDecodeError(`${w}: invalid addresses`);
  }
  return {
    requestId: reqBytes(map, 1, w),
    signData: reqBytes(map, 2, w),
    dataType: optUint(map, 3, w) as BtcDataType,
    derivationPaths: paths.map((p) => KeyPath.fromCbor(p)),
    addresses: addresses as string[] | undefined,
    origin: optText(map, 6, w),
  };
}

export function encodeBtcSignature(sig: BtcSignature): UR {
  return UR.fromValue(
    intKeyMap({ 1: sig.requestId && new CborTag(TAGS.uuid, sig.requestId), 2: sig.signature, 3: sig.publicKey }),
    'btc-signature',
  );
}

export function decodeBtcSignature(ur: UR): BtcSignature {
  const w = 'btc-signature';
  if (ur.type !== w) throw new QRDecodeError(`Expected ur:${w}, got ur:${ur.type}`);
  const map = expectMap(ur.decodeCbor(), w);
  return { requestId: optBytes(map, 1, w), signature: reqBytes(map, 2, w), publicKey: optBytes(map, 3, w) };
}

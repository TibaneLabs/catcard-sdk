import { CborTag, type CborValue } from '../cbor';
import { QRDecodeError } from '../errors';
import { expectMap, intKeyMap, optBool, optBytes, optText, optUint, reqBytes, untag } from './cbor-helpers';
import { KeyPath } from './keypath';
import { TAGS } from './tags';

/** A `crypto-hdkey` (BCR-2020-007): a public key, optionally extended with a chain code. */
export interface CryptoHDKey {
  isMaster?: boolean;
  isPrivate?: boolean;
  /** 33-byte compressed secp256k1 key, or a 32-byte ed25519 key. */
  key: Uint8Array;
  chainCode?: Uint8Array;
  /** SLIP-44 coin type and network, when given. */
  useInfo?: { type?: number; network?: number };
  /** Path of this key from the master key. */
  origin?: KeyPath;
  /** Path of the children meant to be derived from it (e.g. `0/*`). */
  children?: KeyPath;
  parentFingerprint?: number;
  name?: string;
  note?: string;
}

export function encodeCryptoHDKey(key: CryptoHDKey): CborValue {
  return intKeyMap({
    1: key.isMaster || undefined,
    2: key.isPrivate,
    3: key.key,
    4: key.chainCode,
    5: key.useInfo ? new CborTag(TAGS.cryptoCoinInfo, intKeyMap({ 1: key.useInfo.type, 2: key.useInfo.network })) : undefined,
    6: key.origin?.toTagged(),
    7: key.children?.toTagged(),
    8: key.parentFingerprint || undefined,
    9: key.name,
    10: key.note,
  });
}

export function decodeCryptoHDKey(value: CborValue): CryptoHDKey {
  const map = expectMap(untag(value, TAGS.cryptoHDKey), 'crypto-hdkey');
  const what = 'crypto-hdkey';
  if (optBool(map, 2, what)) throw new QRDecodeError('Refusing to import a private key');
  const useInfoRaw = map.get(5);
  let useInfo: CryptoHDKey['useInfo'];
  if (useInfoRaw !== undefined) {
    const info = expectMap(untag(useInfoRaw, TAGS.cryptoCoinInfo), 'crypto-coin-info');
    useInfo = { type: optUint(info, 1, 'crypto-coin-info'), network: optUint(info, 2, 'crypto-coin-info') };
  }
  const origin = map.get(6);
  const children = map.get(7);
  return {
    isMaster: optBool(map, 1, what),
    key: reqBytes(map, 3, what),
    chainCode: optBytes(map, 4, what),
    useInfo,
    origin: origin === undefined ? undefined : KeyPath.fromCbor(origin),
    children: children === undefined ? undefined : KeyPath.fromCbor(children),
    parentFingerprint: optUint(map, 8, what),
    name: optText(map, 9, what),
    note: optText(map, 10, what),
  };
}

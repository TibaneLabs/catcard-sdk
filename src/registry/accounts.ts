import type { CborValue } from '../cbor';
import { CborTag } from '../cbor';
import { QRDecodeError } from '../errors';
import type { UR } from '../ur';
import { expectMap, intKeyMap, optText, optUint, untag } from './cbor-helpers';
import { decodeCryptoHDKey, encodeCryptoHDKey, type CryptoHDKey } from './hdkey';
import { KeyPath } from './keypath';
import { TAGS } from './tags';

/** Keys exported by the device, normalized from the various UR account formats. */
export interface AccountExport {
  /** Master key fingerprint; needed by the device to recognise its own keys in sign requests. */
  masterFingerprint?: number;
  device?: string;
  deviceId?: string;
  keys: CryptoHDKey[];
}

export const ACCOUNT_UR_TYPES: readonly string[] = ['crypto-hdkey', 'crypto-account', 'crypto-multi-accounts'];

/** Decodes the `crypto-hdkey` inside a `crypto-output`, keeping its script expression tags. */
function decodeOutput(value: CborValue): CryptoHDKey {
  const scriptExpressions: number[] = [];
  let current = value;
  while (current instanceof CborTag && current.tag !== TAGS.cryptoHDKey) {
    scriptExpressions.push(current.tag);
    current = current.value;
  }
  if (!(current instanceof CborTag)) throw new QRDecodeError('crypto-output does not contain an HD key');
  const key = decodeCryptoHDKey(current);
  return scriptExpressions.length ? { ...key, scriptExpressions } : key;
}

/** Decodes a `crypto-hdkey`, `crypto-account` or `crypto-multi-accounts` UR. */
export function decodeAccountExport(ur: UR): AccountExport {
  const value = ur.decodeCbor();
  switch (ur.type) {
    case 'crypto-hdkey': {
      const key = decodeCryptoHDKey(value);
      return { masterFingerprint: key.origin?.sourceFingerprint, keys: [key] };
    }
    case 'crypto-account': {
      const map = expectMap(untag(value, TAGS.cryptoAccount), 'crypto-account');
      const outputs = map.get(2);
      if (!Array.isArray(outputs)) throw new QRDecodeError('crypto-account: missing output descriptors');
      return {
        masterFingerprint: optUint(map, 1, 'crypto-account'),
        keys: outputs.map(decodeOutput),
      };
    }
    case 'crypto-multi-accounts': {
      const map = expectMap(untag(value, TAGS.cryptoMultiAccounts), 'crypto-multi-accounts');
      const keys = map.get(2);
      if (!Array.isArray(keys)) throw new QRDecodeError('crypto-multi-accounts: missing keys');
      return {
        masterFingerprint: optUint(map, 1, 'crypto-multi-accounts'),
        device: optText(map, 3, 'crypto-multi-accounts'),
        deviceId: optText(map, 4, 'crypto-multi-accounts'),
        keys: keys.map(decodeCryptoHDKey),
      };
    }
    default:
      throw new QRDecodeError(`Not an account export: ur:${ur.type}`);
  }
}

/** Encodes a `crypto-multi-accounts` payload (mainly useful for tests and device simulators). */
export function encodeMultiAccounts(accounts: AccountExport): CborValue {
  return intKeyMap({
    1: accounts.masterFingerprint,
    2: accounts.keys.map((k) => new CborTag(TAGS.cryptoHDKey, encodeCryptoHDKey(k))),
    3: accounts.device,
    4: accounts.deviceId,
  });
}

/** Source fingerprint for a key: its own origin's, or the export's master fingerprint. */
export function keySourceFingerprint(accounts: AccountExport, key: CryptoHDKey): number | undefined {
  return key.origin?.sourceFingerprint || accounts.masterFingerprint;
}

/**
 * The SLIP-44 coin type of a key: the second component of a BIP43-style origin path
 * (`m/purpose'/coin'/...`, e.g. BIP44/49/84/86), or its use-info.
 */
export function keyCoinType(key: CryptoHDKey): number | undefined {
  const [purpose, coin] = key.origin?.components ?? [];
  if (purpose?.hardened && coin?.hardened && coin.index !== null) return coin.index;
  return key.useInfo?.type;
}

export { KeyPath };

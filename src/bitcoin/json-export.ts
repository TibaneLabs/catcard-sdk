// Coldcard-style "generic JSON" wallet export, shown by Bitcoin firmwares over BBQr (file type J).
//
//   { "xfp": "0F056943", "bip84": { "name": "p2wpkh", "deriv": "m/84'/0'/0'", "xpub": "xpub..." }, ... }

import { sha256 } from '@noble/hashes/sha256';
import { createBase58check } from '@scure/base';
import { CatCardError } from '../errors';
import type { AccountExport } from '../registry/accounts';
import type { CryptoHDKey } from '../registry/hdkey';
import { KeyPath } from '../registry/keypath';
import { SCRIPT_TAGS } from './script';

const base58check = createBase58check(sha256);

const SECTIONS: Record<string, number[]> = {
  bip44: [SCRIPT_TAGS.pkh],
  bip49: [SCRIPT_TAGS.sh, SCRIPT_TAGS.wpkh],
  bip84: [SCRIPT_TAGS.wpkh],
  bip86: [SCRIPT_TAGS.tr],
};

/** Decodes a BIP32 extended public key (any version bytes: xpub, tpub, zpub...). */
export function decodeExtendedPublicKey(xpub: string): { key: Uint8Array; chainCode: Uint8Array; depth: number; parentFingerprint: number } {
  let raw: Uint8Array;
  try {
    raw = base58check.decode(xpub);
  } catch {
    throw new CatCardError('Invalid extended public key');
  }
  if (raw.length !== 78 || (raw[45] !== 2 && raw[45] !== 3)) throw new CatCardError('Invalid extended public key');
  const view = new DataView(raw.buffer, raw.byteOffset);
  return { depth: raw[4]!, parentFingerprint: view.getUint32(5), chainCode: raw.slice(13, 45), key: raw.slice(45, 78) };
}

export function isBitcoinJsonExport(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.keys(SECTIONS).some((k) => k in (value as object));
}

/** Converts a Coldcard-style JSON export into an {@link AccountExport}. */
export function parseBitcoinJsonExport(value: unknown): AccountExport {
  if (!isBitcoinJsonExport(value)) throw new CatCardError('Not a Bitcoin wallet export');
  const json = value as Record<string, unknown>;
  const xfp = typeof json.xfp === 'string' && /^[0-9a-fA-F]{8}$/.test(json.xfp) ? parseInt(json.xfp, 16) : undefined;
  const keys: CryptoHDKey[] = [];
  for (const [section, scriptExpressions] of Object.entries(SECTIONS)) {
    const entry = json[section] as { deriv?: unknown; xpub?: unknown } | undefined;
    if (!entry || typeof entry.deriv !== 'string' || typeof entry.xpub !== 'string') continue;
    const { key, chainCode, parentFingerprint } = decodeExtendedPublicKey(entry.xpub);
    keys.push({
      key,
      chainCode,
      parentFingerprint,
      origin: KeyPath.parse(entry.deriv, xfp),
      children: KeyPath.parse('0/*'),
      scriptExpressions,
    });
  }
  if (keys.length === 0) throw new CatCardError('No single-signature Bitcoin account found in this export');
  return { masterFingerprint: xfp, keys };
}

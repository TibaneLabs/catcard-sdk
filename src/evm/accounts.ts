import { secp256k1 } from '@noble/curves/secp256k1';
import { getAddress, type Address } from 'viem';
import { HDKey, publicKeyToAddress } from 'viem/accounts';
import { keyCoinType, keySourceFingerprint, type AccountExport } from '../registry/accounts';
import type { CryptoHDKey } from '../registry/hdkey';
import { KeyPath } from '../registry/keypath';
import { bytesToHex } from '../util/bytes';

const ETH_COIN_TYPE = 60;

/** An EVM address on the device, with what the device needs to find its key. */
export interface EvmAccount {
  address: Address;
  /** Full derivation path, e.g. `m/44'/60'/0'/0/0`. */
  path: string;
  /** Master key fingerprint. */
  sourceFingerprint?: number;
}

function toAddress(compressedPublicKey: Uint8Array): Address {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(compressedPublicKey).toRawBytes(false);
  return getAddress(publicKeyToAddress(`0x${bytesToHex(uncompressed)}`));
}

function isEvmKey(key: CryptoHDKey): boolean {
  if (key.key.length !== 33) return false;
  const coinType = keyCoinType(key);
  return coinType === undefined || coinType === ETH_COIN_TYPE;
}

/**
 * Derives EVM accounts from a device export.
 *
 * - Account-level extended keys (e.g. `m/44'/60'/0'`) yield `count` addresses along their
 *   `children` template (default `0/*`), i.e. `m/44'/60'/0'/0/0`, `.../0/1`, ...
 * - Leaf keys (e.g. Ledger Live style `m/44'/60'/n'/0/0`) yield their own address.
 */
export function deriveEvmAccounts(accounts: AccountExport, count = 5): EvmAccount[] {
  const out: EvmAccount[] = [];
  const seen = new Set<string>();
  const push = (account: EvmAccount) => {
    if (seen.has(account.address)) return;
    seen.add(account.address);
    out.push(account);
  };

  for (const key of accounts.keys) {
    if (!isEvmKey(key)) continue;
    const sourceFingerprint = keySourceFingerprint(accounts, key);
    const origin = key.origin ?? new KeyPath([]);
    const template = key.children ?? (key.chainCode && origin.components.length <= 3 ? KeyPath.parse('0/*') : undefined);

    if (!template || !key.chainCode || template.components.some((c) => c.hardened)) {
      push({ address: toAddress(key.key), path: origin.toString(), sourceFingerprint });
      continue;
    }

    const parent = new HDKey({ publicKey: key.key, chainCode: key.chainCode });
    const hasWildcard = template.components.some((c) => c.index === null);
    for (let i = 0; i < (hasWildcard ? count : 1); i++) {
      const relative = new KeyPath(template.components.map((c) => ({ index: c.index ?? i, hardened: false })));
      let child = parent;
      for (const index of relative.toIndexes()) child = child.deriveChild(index);
      push({ address: toAddress(child.publicKey!), path: origin.concat(relative).toString(), sourceFingerprint });
    }
  }
  return out;
}

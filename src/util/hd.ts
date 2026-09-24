import { HDKey } from '@scure/bip32';
import { keyCoinType, keySourceFingerprint, type AccountExport } from '../registry/accounts';
import type { CryptoHDKey } from '../registry/hdkey';
import { KeyPath } from '../registry/keypath';

export interface DerivedKey {
  /** 33-byte compressed secp256k1 public key. */
  publicKey: Uint8Array;
  /** Full derivation path from the master key. */
  path: KeyPath;
  sourceFingerprint?: number;
  /** The exported key it was derived from. */
  source: CryptoHDKey;
}

/**
 * Derives secp256k1 keys from an account export.
 *
 * - Account-level extended keys (depth ≤ 3, e.g. `m/44'/60'/0'`) yield `count` keys along their
 *   `children` template (default `0/*`): `.../0/0`, `.../0/1`, ...
 * - Leaf keys (e.g. Ledger Live style `m/44'/60'/n'/0/0`) yield themselves.
 */
export function deriveSecp256k1Keys(
  accounts: AccountExport,
  accept: (key: CryptoHDKey, coinType: number | undefined) => boolean,
  count: number,
): DerivedKey[] {
  const out: DerivedKey[] = [];
  for (const key of accounts.keys) {
    if (key.key.length !== 33 || !accept(key, keyCoinType(key))) continue;
    const sourceFingerprint = keySourceFingerprint(accounts, key);
    const origin = key.origin ?? new KeyPath([]);
    const template = key.children ?? (key.chainCode && origin.components.length <= 3 ? KeyPath.parse('0/*') : undefined);

    if (!template || !key.chainCode || template.components.some((c) => c.hardened)) {
      out.push({ publicKey: key.key, path: new KeyPath(origin.components, sourceFingerprint), sourceFingerprint, source: key });
      continue;
    }
    const parent = new HDKey({ publicKey: key.key, chainCode: key.chainCode });
    const hasWildcard = template.components.some((c) => c.index === null);
    for (let i = 0; i < (hasWildcard ? count : 1); i++) {
      const relative = new KeyPath(template.components.map((c) => ({ index: c.index ?? i, hardened: false })));
      let child = parent;
      for (const index of relative.toIndexes()) child = child.deriveChild(index);
      const path = new KeyPath([...origin.components, ...relative.components], sourceFingerprint);
      out.push({ publicKey: child.publicKey!, path, sourceFingerprint, source: key });
    }
  }
  return out;
}

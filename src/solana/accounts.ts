import { base58 } from '@scure/base';
import { keyCoinType, keySourceFingerprint, type AccountExport } from '../registry/accounts';
import { bytesToHex } from '../util/bytes';

const SOL_COIN_TYPE = 501;

export interface SolanaAccount {
  /** Base58 public key. */
  address: string;
  /** Hex public key (JSON-friendly; see {@link solanaPublicKey}). */
  publicKey: string;
  path: string;
  sourceFingerprint?: number;
}

/** Extracts Solana accounts (ed25519 keys under coin type 501) from a device export. */
export function deriveSolanaAccounts(accounts: AccountExport): SolanaAccount[] {
  const out: SolanaAccount[] = [];
  for (const key of accounts.keys) {
    if (keyCoinType(key) !== SOL_COIN_TYPE) continue;
    // Some exports prefix ed25519 keys with a zero byte to fit the 33-byte key field.
    const raw = key.key.length === 33 && key.key[0] === 0 ? key.key.subarray(1) : key.key;
    if (raw.length !== 32 || !key.origin) continue;
    const address = base58.encode(raw);
    if (out.some((a) => a.address === address)) continue;
    out.push({ address, publicKey: bytesToHex(raw), path: key.origin.toString(), sourceFingerprint: keySourceFingerprint(accounts, key) });
  }
  return out;
}

export function solanaPublicKey(account: SolanaAccount): Uint8Array {
  return base58.decode(account.address);
}

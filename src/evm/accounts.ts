import { getAddress, type Address } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import type { AccountExport } from '../registry/accounts';
import { bytesToHex } from '../util/bytes';
import { deriveSecp256k1Keys } from '../util/hd';
import { uncompressPublicKey } from '../util/secp';

const ETH_COIN_TYPE = 60;

/** An EVM address on the device, with what the device needs to find its key. */
export interface EvmAccount {
  address: Address;
  /** Full derivation path, e.g. `m/44'/60'/0'/0/0`. */
  path: string;
  /** Master key fingerprint. */
  sourceFingerprint?: number;
}

/**
 * Derives EVM accounts from a device export: `count` addresses along account-level keys
 * (`m/44'/60'/0'/0/i`), or the address of each leaf key (Ledger Live style).
 */
export function deriveEvmAccounts(accounts: AccountExport, count = 5): EvmAccount[] {
  const seen = new Set<string>();
  const out: EvmAccount[] = [];
  const keys = deriveSecp256k1Keys(accounts, (_, coinType) => coinType === undefined || coinType === ETH_COIN_TYPE, count);
  for (const key of keys) {
    const address = getAddress(publicKeyToAddress(`0x${bytesToHex(uncompressPublicKey(key.publicKey))}`));
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({ address, path: key.path.toString(), sourceFingerprint: key.sourceFingerprint });
  }
  return out;
}

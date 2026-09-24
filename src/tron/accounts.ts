import type { AccountExport } from '../registry/accounts';
import { bytesToHex } from '../util/bytes';
import { deriveSecp256k1Keys } from '../util/hd';
import { tronAddressBytes, tronAddressToBase58 } from './address';

const TRX_COIN_TYPE = 195;

export interface TronAccount {
  /** Base58 address (`T...`). */
  address: string;
  /** Hex address (`41...`). */
  hexAddress: string;
  /** Compressed public key, hex. */
  publicKey: string;
  path: string;
  sourceFingerprint?: number;
}

/** Derives Tron accounts (`m/44'/195'/0'/0/i`) from a device export. */
export function deriveTronAccounts(accounts: AccountExport, count = 5): TronAccount[] {
  const seen = new Set<string>();
  const out: TronAccount[] = [];
  for (const key of deriveSecp256k1Keys(accounts, (_, coinType) => coinType === TRX_COIN_TYPE, count)) {
    const bytes = tronAddressBytes(key.publicKey);
    const address = tronAddressToBase58(bytes);
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({
      address,
      hexAddress: bytesToHex(bytes),
      publicKey: bytesToHex(key.publicKey),
      path: key.path.toString(),
      sourceFingerprint: key.sourceFingerprint,
    });
  }
  return out;
}

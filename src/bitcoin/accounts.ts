import * as btc from '@scure/btc-signer';
import type { AccountExport } from '../registry/accounts';
import type { CryptoHDKey } from '../registry/hdkey';
import { bytesToHex } from '../util/bytes';
import { deriveSecp256k1Keys } from '../util/hd';
import { SCRIPT_TAGS } from './script';

export type BitcoinNetwork = 'mainnet' | 'testnet' | 'testnet4' | 'signet' | 'regtest';
export type BitcoinAddressType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr';

export interface BitcoinAccount {
  address: string;
  addressType: BitcoinAddressType;
  /** Compressed public key (33 bytes), hex. */
  publicKey: string;
  path: string;
  sourceFingerprint?: number;
  network: BitcoinNetwork;
}

const REGTEST: typeof btc.NETWORK = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export function btcNetwork(network: BitcoinNetwork): typeof btc.NETWORK {
  if (network === 'mainnet') return btc.NETWORK;
  return network === 'regtest' ? REGTEST : btc.TEST_NETWORK;
}

const PURPOSE_TYPES: Record<number, BitcoinAddressType> = { 44: 'p2pkh', 49: 'p2sh-p2wpkh', 84: 'p2wpkh', 86: 'p2tr' };

function addressTypeOf(key: CryptoHDKey): BitcoinAddressType | undefined {
  const tags = key.scriptExpressions?.join();
  if (tags === `${SCRIPT_TAGS.pkh}`) return 'p2pkh';
  if (tags === `${SCRIPT_TAGS.sh},${SCRIPT_TAGS.wpkh}`) return 'p2sh-p2wpkh';
  if (tags === `${SCRIPT_TAGS.wpkh}`) return 'p2wpkh';
  if (tags === `${SCRIPT_TAGS.tr}`) return 'p2tr';
  if (tags) return undefined; // Multisig or other scripts: not a single-key account.
  const purpose = key.origin?.components[0];
  return purpose?.hardened && purpose.index !== null ? PURPOSE_TYPES[purpose.index] : undefined;
}

/** The fields of a btc-signer payment the SDK relies on. */
export interface BitcoinPayment {
  address?: string;
  script: Uint8Array;
  redeemScript?: Uint8Array;
  tapInternalKey?: Uint8Array;
}

/** The output script (and address) of an account's key. */
export function bitcoinPayment(publicKey: Uint8Array, type: BitcoinAddressType, network: BitcoinNetwork): BitcoinPayment {
  const net = btcNetwork(network);
  switch (type) {
    case 'p2pkh':
      return btc.p2pkh(publicKey, net);
    case 'p2sh-p2wpkh':
      return btc.p2sh(btc.p2wpkh(publicKey, net), net);
    case 'p2wpkh':
      return btc.p2wpkh(publicKey, net);
    case 'p2tr':
      return btc.p2tr(publicKey.subarray(1), undefined, net);
  }
}

/**
 * Derives single-key Bitcoin accounts (BIP44/49/84/86) for `network` from a device export:
 * the first `count` receive addresses of each account.
 */
export function deriveBitcoinAccounts(accounts: AccountExport, network: BitcoinNetwork = 'mainnet', count = 1): BitcoinAccount[] {
  const coinType = network === 'mainnet' ? 0 : 1;
  const types = new Map<CryptoHDKey, BitcoinAddressType>();
  for (const key of accounts.keys) {
    const type = addressTypeOf(key);
    if (type) types.set(key, type);
  }
  const keys = deriveSecp256k1Keys(accounts, (key, keyCoinType) => types.has(key) && keyCoinType === coinType, count);
  return keys.map((k) => {
    const addressType = types.get(k.source)!;
    return {
      address: bitcoinPayment(k.publicKey, addressType, network).address!,
      addressType,
      publicKey: bytesToHex(k.publicKey),
      path: k.path.toString(),
      sourceFingerprint: k.sourceFingerprint,
      network,
    };
  });
}

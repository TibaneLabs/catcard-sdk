import { CatCardError } from './errors';

export type ChainFamily = 'bitcoin' | 'utxo' | 'evm' | 'solana' | 'tron';

export interface ChainInfo {
  name: string;
  symbol: string;
  family: ChainFamily;
}

export type ChainId =
  | 'bitcoin'
  | 'bitcoin-testnet'
  | 'bitcoin-cash'
  | 'litecoin'
  | 'dogecoin'
  | 'monacoin'
  | 'evm'
  | 'solana'
  | 'tron';

/**
 * Chains supported by the multi-chain CatCard firmware. `bitcoin` family chains are
 * the only ones handled by the Bitcoin-only firmware.
 */
export const CHAINS: Readonly<Record<ChainId, ChainInfo>> = {
  bitcoin: { name: 'Bitcoin', symbol: 'BTC', family: 'bitcoin' },
  'bitcoin-testnet': { name: 'Bitcoin Testnet', symbol: 'tBTC', family: 'bitcoin' },
  'bitcoin-cash': { name: 'Bitcoin Cash', symbol: 'BCH', family: 'utxo' },
  litecoin: { name: 'Litecoin', symbol: 'LTC', family: 'utxo' },
  dogecoin: { name: 'Dogecoin', symbol: 'DOGE', family: 'utxo' },
  monacoin: { name: 'Monacoin', symbol: 'MONA', family: 'utxo' },
  evm: { name: 'EVM', symbol: 'ETH', family: 'evm' },
  solana: { name: 'Solana', symbol: 'SOL', family: 'solana' },
  tron: { name: 'Tron', symbol: 'TRX', family: 'tron' },
};

/** Air-gapped QR encodings understood by CatCard. */
export type QRFormat = 'bbqr' | 'ur';

/**
 * - `multi`: full firmware, all chains, BBQr and BC-UR.
 * - `bitcoin-only`: Bitcoin (and testnet) only, BBQr only.
 */
export type FirmwareVariant = 'multi' | 'bitcoin-only';

export function getChain(chain: ChainId): ChainInfo {
  const info: ChainInfo | undefined = CHAINS[chain];
  if (!info) throw new CatCardError(`Unknown chain: ${String(chain)}`);
  return info;
}

export function supportedFormats(firmware: FirmwareVariant): readonly QRFormat[] {
  return firmware === 'bitcoin-only' ? ['bbqr'] : ['bbqr', 'ur'];
}

/**
 * Default QR format for a chain: BBQr for Bitcoin, since every firmware variant
 * (including Bitcoin-only) reads it; BC-UR for everything else.
 */
export function defaultFormat(chain: ChainId): QRFormat {
  return getChain(chain).family === 'bitcoin' ? 'bbqr' : 'ur';
}

export interface FormatSelection {
  chain?: ChainId;
  firmware?: FirmwareVariant;
  /** Force a format instead of the chain default. */
  format?: QRFormat;
}

/** Resolves the QR format to use, validating it against the target firmware. */
export function resolveFormat({ chain = 'bitcoin', firmware = 'multi', format }: FormatSelection): QRFormat {
  const info = getChain(chain);
  if (firmware === 'bitcoin-only' && info.family !== 'bitcoin') {
    throw new CatCardError(`${info.name} is not supported by the Bitcoin-only firmware`);
  }
  const resolved = format ?? defaultFormat(chain);
  if (!supportedFormats(firmware).includes(resolved)) {
    throw new CatCardError(`The ${firmware} firmware does not support ${resolved.toUpperCase()}`);
  }
  return resolved;
}

import { announceProvider, type ProviderInfo } from '../discovery';

export { deriveTronAccounts, type TronAccount } from './accounts';
export { tronAddressBytes, tronAddressFromString, tronAddressToBase58 } from './address';
export {
  CatCardTronProvider,
  TRON_MAINNET_CHAIN_ID,
  TRON_NETWORKS,
  type TronNetwork,
  type TronProviderOptions,
  type TronWebFactory,
  type TronWebLike,
} from './provider';
export { CatCardTronSigner, hashTronMessage, type TronSignerOptions, type TronTransaction } from './signer';

/** Announces a TIP-1193 provider via TIP-6963 (how TronLink-era adapters discover wallets). */
export function announceTIP6963Provider(provider: unknown, info: Partial<ProviderInfo> = {}): () => void {
  return announceProvider('TIP6963', provider, info);
}

import { announceProvider, type ProviderInfo } from '../discovery';

export { CATCARD_RDNS } from '../discovery';
export type EIP6963ProviderInfo = ProviderInfo;

/**
 * Announces a provider to dapps via EIP-6963 (as wallet pickers like RainbowKit,
 * ConnectKit, Web3Modal and wagmi's `injected` discover wallets), without touching
 * `window.ethereum`. Returns a function that stops answering discovery requests.
 */
export function announceEIP6963Provider(provider: unknown, info: Partial<EIP6963ProviderInfo> = {}): () => void {
  return announceProvider('eip6963', provider, info);
}

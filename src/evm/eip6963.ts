import { CATCARD_ICON } from '../icon';

export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

/** Reverse-DNS identifier used for EIP-6963 announcements. */
export const CATCARD_RDNS = 'net.tibane.catcard';

/**
 * Announces a provider to dapps via EIP-6963 (as wallet pickers like RainbowKit,
 * ConnectKit, Web3Modal and wagmi's `injected` discover wallets), without touching
 * `window.ethereum`. Returns a function that stops answering discovery requests.
 */
export function announceEIP6963Provider(provider: unknown, info: Partial<EIP6963ProviderInfo> = {}): () => void {
  if (typeof window === 'undefined') return () => {};
  const detail = Object.freeze({
    info: Object.freeze({
      uuid: info.uuid ?? crypto.randomUUID(),
      name: info.name ?? 'CatCard',
      icon: info.icon ?? CATCARD_ICON,
      rdns: info.rdns ?? CATCARD_RDNS,
    }),
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  return () => window.removeEventListener('eip6963:requestProvider', announce);
}

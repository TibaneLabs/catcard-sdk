import { CATCARD_ICON } from './icon';

/** EIP-6963 / TIP-6963 provider info. */
export interface ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

/** Reverse-DNS identifier used in provider announcements. */
export const CATCARD_RDNS = 'net.tibane.catcard-sdk';

/**
 * Announces a provider using the EIP-6963 event protocol (`eip6963:*` for EVM,
 * `TIP6963:*` for Tron). Returns a function that stops answering discovery requests.
 */
export function announceProvider(prefix: 'eip6963' | 'TIP6963', provider: unknown, info: Partial<ProviderInfo> = {}): () => void {
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
  const announce = () => window.dispatchEvent(new CustomEvent(`${prefix}:announceProvider`, { detail }));
  window.addEventListener(`${prefix}:requestProvider`, announce);
  announce();
  return () => window.removeEventListener(`${prefix}:requestProvider`, announce);
}

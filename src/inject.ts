import type { CatCardBridge } from './bridge';
import { announceEIP6963Provider, CatCardEthereumProvider, type EIP6963ProviderInfo, type EvmProviderOptions } from './evm';
import { CatCardSolanaWallet, registerCatCardSolanaWallet, type SolanaWalletOptions } from './solana';
import { defaultStorage, type KeyValueStorage } from './storage';
import { createModalBridge, type ModalBridgeOptions } from './ui';

export interface InjectOptions {
  /** How to talk to the user. @default the built-in modal ({@link createModalBridge}) */
  bridge?: CatCardBridge;
  /** Options for the built-in modal, when no `bridge` is given. */
  modal?: ModalBridgeOptions;
  /** @default localStorage, or in-memory */
  storage?: KeyValueStorage;
  /** App name shown on the device. @default location.hostname */
  origin?: string;
  /** EVM provider options (RPC endpoints, chains...), or `false` to disable. */
  ethereum?: false | (Partial<Omit<EvmProviderOptions, 'bridge'>> & { eip6963?: Partial<EIP6963ProviderInfo> });
  /** Solana wallet options (RPC endpoints, chains...), or `false` to disable. */
  solana?: false | Partial<Omit<SolanaWalletOptions, 'bridge'>>;
  /**
   * Also expose the wallets as `window.catcard` (like `window.phantom`), for dapps that
   * look wallets up by name rather than through EIP-6963 / Wallet Standard.
   * `window.ethereum` is never touched. @default true
   */
  exposeGlobal?: boolean;
}

/** The injected wallets; also available as `window.catcard` and through {@link getCatCard}. */
export interface CatCard {
  readonly isCatCard: true;
  readonly bridge: CatCardBridge;
  /** EIP-1193 provider. */
  readonly ethereum?: CatCardEthereumProvider;
  /** Wallet Standard wallet. */
  readonly solana?: CatCardSolanaWallet;
}

const INJECTED = Symbol.for('catcard-sdk.injected');

declare global {
  interface Window {
    catcard?: CatCard;
  }
}

/** The instance created by {@link injectCatCard}, if any. */
export function getCatCard(): CatCard | undefined {
  return (globalThis as { [INJECTED]?: CatCard })[INJECTED];
}

/**
 * Makes CatCard available to the page's dapps, like a browser wallet extension would:
 * an EIP-1193 provider announced via EIP-6963 for EVM, and a Wallet Standard wallet for
 * Solana. Calling it again returns the existing instance.
 *
 * @example
 * injectCatCard({ ethereum: { rpc: { 1: 'https://eth.example/rpc' } } });
 */
export function injectCatCard(options: InjectOptions = {}): CatCard {
  const existing = getCatCard();
  if (existing) return existing;

  const bridge = options.bridge ?? createModalBridge(options.modal);
  const storage = options.storage ?? defaultStorage();
  const origin = options.origin ?? (typeof location !== 'undefined' ? location.hostname : undefined);

  let ethereum: CatCardEthereumProvider | undefined;
  if (options.ethereum !== false) {
    const { eip6963, ...evm } = options.ethereum ?? {};
    ethereum = new CatCardEthereumProvider({ origin, storage, ...evm, bridge });
    announceEIP6963Provider(ethereum, eip6963);
  }
  let solana: CatCardSolanaWallet | undefined;
  if (options.solana !== false) {
    solana = new CatCardSolanaWallet({ origin, storage, ...options.solana, bridge });
    registerCatCardSolanaWallet(solana);
  }

  const catcard: CatCard = Object.freeze({ isCatCard: true, bridge, ethereum, solana });
  (globalThis as { [INJECTED]?: CatCard })[INJECTED] = catcard;
  if (options.exposeGlobal !== false && typeof window !== 'undefined' && !window.catcard) {
    Object.defineProperty(window, 'catcard', { value: catcard, configurable: true, enumerable: false });
  }
  return catcard;
}

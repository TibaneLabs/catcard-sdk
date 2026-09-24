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
  evm?: false | (Partial<Omit<EvmProviderOptions, 'bridge'>> & { eip6963?: Partial<EIP6963ProviderInfo> });
  /** Solana wallet options (RPC endpoints, chains...), or `false` to disable. */
  solana?: false | Partial<Omit<SolanaWalletOptions, 'bridge'>>;
}

export interface InjectedCatCard {
  bridge: CatCardBridge;
  evm?: CatCardEthereumProvider;
  solana?: CatCardSolanaWallet;
}

const INJECTED = Symbol.for('catcard-sdk.injected');

/**
 * Makes CatCard available to the page's dapps, like a browser wallet extension would:
 * an EIP-1193 provider announced via EIP-6963 for EVM, and a Wallet Standard wallet for
 * Solana. Calling it again returns the existing instance.
 *
 * @example
 * injectCatCard({ evm: { rpc: { 1: 'https://eth.example/rpc' } } });
 */
export function injectCatCard(options: InjectOptions = {}): InjectedCatCard {
  const g = globalThis as { [INJECTED]?: InjectedCatCard };
  if (g[INJECTED]) return g[INJECTED];

  const bridge = options.bridge ?? createModalBridge(options.modal);
  const storage = options.storage ?? defaultStorage();
  const origin = options.origin ?? (typeof location !== 'undefined' ? location.hostname : undefined);
  const injected: InjectedCatCard = { bridge };

  if (options.evm !== false) {
    const { eip6963, ...evm } = options.evm ?? {};
    injected.evm = new CatCardEthereumProvider({ origin, storage, ...evm, bridge });
    announceEIP6963Provider(injected.evm, eip6963);
  }
  if (options.solana !== false) {
    injected.solana = new CatCardSolanaWallet({ origin, storage, ...options.solana, bridge });
    registerCatCardSolanaWallet(injected.solana);
  }
  g[INJECTED] = injected;
  return injected;
}

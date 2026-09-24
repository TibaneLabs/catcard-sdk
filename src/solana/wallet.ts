import { base58, base64 } from '@scure/base';
import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignAndSendTransactionInput,
  type SolanaSignAndSendTransactionOutput,
  type SolanaSignMessageFeature,
  type SolanaSignMessageInput,
  type SolanaSignMessageOutput,
  type SolanaSignTransactionFeature,
  type SolanaSignTransactionInput,
  type SolanaSignTransactionOutput,
} from '@solana/wallet-standard-features';
import type { IdentifierString, Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardConnectInput,
  type StandardConnectOutput,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
  type StandardEventsListeners,
  type StandardEventsNames,
} from '@wallet-standard/features';
import { ReadonlyWalletAccount, registerWallet } from '@wallet-standard/wallet';
import type { CatCardBridge } from '../bridge';
import { CatCardError } from '../errors';
import { CATCARD_ICON } from '../icon';
import { ACCOUNT_UR_TYPES, decodeAccountExport } from '../registry/accounts';
import { defaultStorage, readJSON, writeJSON, type KeyValueStorage } from '../storage';
import { deriveSolanaAccounts, solanaPublicKey, type SolanaAccount } from './accounts';
import { CatCardSolanaSigner, type SolanaSignerOptions } from './signer';
import { parseSolanaTransaction } from './transaction';

export type SolanaChain = 'solana:mainnet' | 'solana:devnet' | 'solana:testnet' | 'solana:localnet';

/** Public cluster endpoints, used when no RPC is configured. They are rate-limited. */
export const DEFAULT_SOLANA_RPC: Readonly<Record<SolanaChain, string>> = {
  'solana:mainnet': 'https://api.mainnet-beta.solana.com',
  'solana:devnet': 'https://api.devnet.solana.com',
  'solana:testnet': 'https://api.testnet.solana.com',
  'solana:localnet': 'http://127.0.0.1:8899',
};

export interface SolanaWalletOptions extends SolanaSignerOptions {
  bridge: CatCardBridge;
  /** @default localStorage, or in-memory */
  storage?: KeyValueStorage;
  /** @default 'catcard:solana' */
  storageKey?: string;
  /** Chains advertised to dapps. @default mainnet, devnet and testnet */
  chains?: readonly SolanaChain[];
  /** RPC endpoint per chain, used by `signAndSendTransaction`. Defaults to {@link DEFAULT_SOLANA_RPC}. */
  rpc?: Partial<Record<SolanaChain, string>>;
  /** `fetch` implementation for RPC calls. @default globalThis.fetch */
  fetch?: typeof fetch;
}

const FEATURES_PER_ACCOUNT = [SolanaSignAndSendTransaction, SolanaSignTransaction, SolanaSignMessage] as const;
const TRANSACTION_VERSIONS = ['legacy', 0, 1] as const;

export type CatCardSolanaFeatures = StandardConnectFeature &
  StandardDisconnectFeature &
  StandardEventsFeature &
  SolanaSignTransactionFeature &
  SolanaSignAndSendTransactionFeature &
  SolanaSignMessageFeature;

/**
 * A Wallet Standard wallet backed by a CatCard, discoverable by `@solana/wallet-adapter`,
 * `@solana/react`, and any dapp that supports Wallet Standard (as Phantom, Solflare... do).
 */
export class CatCardSolanaWallet implements Wallet {
  readonly version = '1.0.0' as const;
  readonly name = 'CatCard';
  readonly icon: typeof CATCARD_ICON = CATCARD_ICON;
  readonly chains: readonly IdentifierString[];

  private readonly storage: KeyValueStorage;
  private readonly storageKey: string;
  private readonly listeners: { [E in StandardEventsNames]?: Set<StandardEventsListeners[E]> } = {};
  private stored: SolanaAccount[];
  private walletAccounts: ReadonlyWalletAccount[] = [];

  constructor(private readonly options: SolanaWalletOptions) {
    this.chains = options.chains ?? ['solana:mainnet', 'solana:devnet', 'solana:testnet'];
    this.storage = options.storage ?? defaultStorage();
    this.storageKey = options.storageKey ?? 'catcard:solana';
    this.stored = readJSON<SolanaAccount[]>(this.storage, this.storageKey) ?? [];
    this.rebuildAccounts();
  }

  get accounts(): readonly WalletAccount[] {
    return this.walletAccounts;
  }

  get features(): CatCardSolanaFeatures {
    return {
      [StandardConnect]: { version: '1.0.0', connect: this.connect },
      [StandardDisconnect]: { version: '1.0.0', disconnect: this.disconnect },
      [StandardEvents]: { version: '1.0.0', on: this.on },
      [SolanaSignTransaction]: {
        version: '1.0.0',
        supportedTransactionVersions: TRANSACTION_VERSIONS,
        signTransaction: this.signTransaction,
      },
      [SolanaSignAndSendTransaction]: {
        version: '1.0.0',
        supportedTransactionVersions: TRANSACTION_VERSIONS,
        signAndSendTransaction: this.signAndSendTransaction,
      },
      [SolanaSignMessage]: { version: '1.1.0', signMessage: this.signMessage },
    };
  }

  private rebuildAccounts(): void {
    this.walletAccounts = this.stored.map(
      (a) =>
        new ReadonlyWalletAccount({
          address: a.address,
          publicKey: solanaPublicKey(a),
          chains: this.chains,
          features: FEATURES_PER_ACCOUNT,
          label: `CatCard ${a.path}`,
        }),
    );
  }

  private emitChange(): void {
    for (const listener of this.listeners.change ?? []) listener({ accounts: this.accounts });
  }

  private signerFor(account: WalletAccount): CatCardSolanaSigner {
    const stored = this.stored.find((a) => a.address === account.address);
    if (!stored) throw new CatCardError('Unknown account: connect the CatCard first');
    return new CatCardSolanaSigner(stored, this.options.bridge, { origin: this.options.origin, qr: this.options.qr });
  }

  private rpcUrl(chain: IdentifierString): string {
    const url = this.options.rpc?.[chain as SolanaChain] ?? DEFAULT_SOLANA_RPC[chain as SolanaChain];
    if (!url) throw new CatCardError(`No RPC endpoint for ${chain}`);
    return url;
  }

  // Arrow functions: dapps call feature methods detached from the wallet.

  private connect = async ({ silent }: StandardConnectInput = {}): Promise<StandardConnectOutput> => {
    if (this.stored.length > 0 || silent) return { accounts: this.accounts };
    this.stored = await this.options.bridge.exchange({
      title: 'Connect CatCard',
      description: 'On your CatCard, open the account export for Solana, then scan the QR code it shows.',
      parse: (result) => {
        if (result.format !== 'ur' || !ACCOUNT_UR_TYPES.includes(result.ur.type)) {
          throw new CatCardError('This is not a CatCard account QR code');
        }
        const accounts = deriveSolanaAccounts(decodeAccountExport(result.ur));
        if (accounts.length === 0) throw new CatCardError('No Solana account found in this QR code');
        return accounts;
      },
    });
    writeJSON(this.storage, this.storageKey, this.stored);
    this.rebuildAccounts();
    this.emitChange();
    return { accounts: this.accounts };
  };

  private disconnect = async (): Promise<void> => {
    this.stored = [];
    this.storage.removeItem(this.storageKey);
    this.rebuildAccounts();
    this.emitChange();
  };

  private on = <E extends StandardEventsNames>(event: E, listener: StandardEventsListeners[E]): (() => void) => {
    const set = (this.listeners[event] ??= new Set()) as Set<StandardEventsListeners[E]>;
    set.add(listener);
    return () => set.delete(listener);
  };

  // Inputs are signed one at a time: each needs its own QR round trip with the device.

  private signTransaction = async (...inputs: readonly SolanaSignTransactionInput[]): Promise<readonly SolanaSignTransactionOutput[]> => {
    const outputs: SolanaSignTransactionOutput[] = [];
    for (const input of inputs) {
      outputs.push({ signedTransaction: await this.signerFor(input.account).signTransaction(input.transaction) });
    }
    return outputs;
  };

  private signAndSendTransaction = async (
    ...inputs: readonly SolanaSignAndSendTransactionInput[]
  ): Promise<readonly SolanaSignAndSendTransactionOutput[]> => {
    const outputs: SolanaSignAndSendTransactionOutput[] = [];
    for (const input of inputs) {
      const signed = await this.signerFor(input.account).signTransaction(input.transaction);
      await this.sendTransaction(input.chain, signed, input.options);
      // The transaction ID is its first signature (the fee payer's).
      const first = parseSolanaTransaction(signed).signatureOffsets[0]!;
      outputs.push({ signature: signed.slice(first, first + 64) });
    }
    return outputs;
  };

  private signMessage = async (...inputs: readonly SolanaSignMessageInput[]): Promise<readonly SolanaSignMessageOutput[]> => {
    const outputs: SolanaSignMessageOutput[] = [];
    for (const input of inputs) {
      const signature = await this.signerFor(input.account).signMessage(input.message);
      outputs.push({ signedMessage: input.message, signature, signatureType: 'ed25519' });
    }
    return outputs;
  };

  private async sendTransaction(
    chain: IdentifierString,
    transaction: Uint8Array,
    options: SolanaSignAndSendTransactionInput['options'] = {},
  ): Promise<string> {
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const response = await doFetch(this.rpcUrl(chain), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          base64.encode(transaction),
          {
            encoding: 'base64',
            skipPreflight: options.skipPreflight,
            preflightCommitment: options.preflightCommitment ?? options.commitment,
            maxRetries: options.maxRetries,
            minContextSlot: options.minContextSlot,
          },
        ],
      }),
    });
    const body = (await response.json()) as { result?: string; error?: { code: number; message: string } };
    if (body.error) throw new CatCardError(`Solana RPC error ${body.error.code}: ${body.error.message}`);
    if (typeof body.result !== 'string' || base58.decode(body.result).length !== 64) {
      throw new CatCardError('Unexpected Solana RPC response');
    }
    return body.result;
  }
}

/** Registers the wallet with Wallet Standard so dapps can discover it (a no-op outside browsers). */
export function registerCatCardSolanaWallet(wallet: CatCardSolanaWallet): void {
  if (typeof window !== 'undefined') registerWallet(wallet);
}

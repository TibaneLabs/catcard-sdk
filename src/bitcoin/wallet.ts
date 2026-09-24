import type { IdentifierString, Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
  type StandardEventsListeners,
  type StandardEventsNames,
} from '@wallet-standard/features';
import { ReadonlyWalletAccount, registerWallet } from '@wallet-standard/wallet';
import type { CatCardBridge } from '../bridge';
import { CatCardError } from '../errors';
import { CATCARD_ICON } from '../icon';
import { interpretScan } from '../payloads';
import { ACCOUNT_UR_TYPES, decodeAccountExport, type AccountExport } from '../registry/accounts';
import { defaultStorage, readJSON, writeJSON, type KeyValueStorage } from '../storage';
import { hexToBytes } from '../util/bytes';
import { deriveBitcoinAccounts, type BitcoinAccount, type BitcoinNetwork } from './accounts';
import { isBitcoinJsonExport, parseBitcoinJsonExport } from './json-export';
import { findOwnInputs, finalizePsbt, type BitcoinSigHashFlag, type InputToSign } from './psbt';
import { CatCardSatsConnectProvider } from './sats-connect';
import { CatCardBitcoinSigner, type BitcoinMessageSignature, type BitcoinSignerOptions } from './signer';

// Bitcoin Wallet Standard feature names (https://github.com/ExodusMovement/bitcoin-wallet-standard,
// as implemented by Exodus and MetaMask).
export const BitcoinConnect = 'bitcoin:connect';
export const BitcoinDisconnect = 'bitcoin:disconnect';
export const BitcoinEvents = 'bitcoin:events';
export const BitcoinSignTransaction = 'bitcoin:signTransaction';
export const BitcoinSignAndSendTransaction = 'bitcoin:signAndSendTransaction';
export const BitcoinSignMessage = 'bitcoin:signMessage';
export const SatsConnectFeature = 'sats-connect:';

export type BitcoinAddressPurpose = 'payment' | 'ordinals';

export interface BitcoinSignTransactionInput {
  readonly psbt: Uint8Array;
  readonly inputsToSign: readonly { readonly account: WalletAccount; readonly signingIndexes: readonly number[]; readonly sigHash?: BitcoinSigHashFlag }[];
  readonly chain?: IdentifierString;
}

/** Public Esplora API endpoints (mempool.space), used when no `rpc` is configured. */
export const DEFAULT_ESPLORA: Readonly<Partial<Record<BitcoinNetwork, string>>> = {
  mainnet: 'https://mempool.space/api',
  testnet: 'https://mempool.space/testnet/api',
  testnet4: 'https://mempool.space/testnet4/api',
  signet: 'https://mempool.space/signet/api',
};

export interface BitcoinWalletOptions extends BitcoinSignerOptions {
  bridge: CatCardBridge;
  /** @default 'mainnet' */
  network?: BitcoinNetwork;
  /** @default localStorage, or in-memory */
  storage?: KeyValueStorage;
  /** @default 'catcard:bitcoin' */
  storageKey?: string;
  /** Esplora-compatible API base URL per network, used to broadcast. Defaults to {@link DEFAULT_ESPLORA}. */
  rpc?: Partial<Record<BitcoinNetwork, string>>;
  /** Custom broadcast (e.g. through your own node); returns the transaction ID. Overrides `rpc`. */
  broadcast?: (transactionHex: string, network: BitcoinNetwork) => Promise<string>;
  /** `fetch` implementation for the Esplora API. @default globalThis.fetch */
  fetch?: typeof fetch;
}

const PAYMENT_TYPES = ['p2wpkh', 'p2sh-p2wpkh', 'p2pkh'] as const;

function readAccountExport(result: Parameters<Parameters<CatCardBridge['exchange']>[0]['parse']>[0]): AccountExport {
  if (result.format === 'ur' && ACCOUNT_UR_TYPES.includes(result.ur.type)) return decodeAccountExport(result.ur);
  const payload = interpretScan(result);
  let json: unknown;
  if (payload.kind === 'json') json = payload.value;
  else if (payload.kind === 'text') {
    try {
      json = JSON.parse(payload.text);
    } catch {
      // Not JSON.
    }
  }
  if (isBitcoinJsonExport(json)) return parseBitcoinJsonExport(json);
  throw new CatCardError('This is not a CatCard account QR code');
}

/**
 * A Bitcoin Wallet Standard wallet backed by a CatCard. Also provides a sats-connect
 * compatible provider ({@link provider}) for dapps using sats-connect / WBIP.
 */
export class CatCardBitcoinWallet implements Wallet {
  readonly version = '1.0.0' as const;
  readonly name = 'CatCard';
  readonly icon: typeof CATCARD_ICON = CATCARD_ICON;
  readonly network: BitcoinNetwork;
  /** sats-connect / WBIP request API. */
  readonly provider: CatCardSatsConnectProvider;

  private readonly signer: CatCardBitcoinSigner;
  private readonly storage: KeyValueStorage;
  private readonly storageKey: string;
  private readonly listeners: { [E in StandardEventsNames]?: Set<StandardEventsListeners[E]> } = {};
  private stored: BitcoinAccount[];
  private walletAccounts: ReadonlyWalletAccount[] = [];

  constructor(private readonly options: BitcoinWalletOptions) {
    this.network = options.network ?? 'mainnet';
    this.signer = new CatCardBitcoinSigner(options.bridge, options);
    this.storage = options.storage ?? defaultStorage();
    this.storageKey = options.storageKey ?? 'catcard:bitcoin';
    this.stored = (readJSON<BitcoinAccount[]>(this.storage, this.storageKey) ?? []).filter((a) => a.network === this.network);
    this.provider = new CatCardSatsConnectProvider(this);
    this.rebuildAccounts();
  }

  get chains(): readonly IdentifierString[] {
    return [`bitcoin:${this.network}`];
  }

  /** The payment (SegWit or legacy) and ordinals (Taproot) accounts, once connected. */
  get accounts(): readonly WalletAccount[] {
    return this.walletAccounts;
  }

  /** All imported accounts, including the ones not exposed through Wallet Standard. */
  get bitcoinAccounts(): readonly BitcoinAccount[] {
    return this.stored;
  }

  get connected(): boolean {
    return this.stored.length > 0;
  }

  /** The account used for a purpose: native SegWit (or the best available) for payments, Taproot for ordinals. */
  accountFor(purpose: BitcoinAddressPurpose): BitcoinAccount | undefined {
    if (purpose === 'ordinals') return this.stored.find((a) => a.addressType === 'p2tr');
    for (const type of PAYMENT_TYPES) {
      const account = this.stored.find((a) => a.addressType === type);
      if (account) return account;
    }
    return undefined;
  }

  get features(): StandardConnectFeature & StandardDisconnectFeature & StandardEventsFeature & Record<string, unknown> {
    return {
      [StandardConnect]: { version: '1.0.0', connect: async ({ silent } = {}) => ({ accounts: await this.connectAccounts(silent) }) },
      [StandardDisconnect]: { version: '1.0.0', disconnect: this.disconnect },
      [StandardEvents]: { version: '1.0.0', on: this.on },
      [BitcoinConnect]: {
        version: '1.0.0',
        connect: async ({ purposes }: { purposes: BitcoinAddressPurpose[] }) => ({
          accounts: (await this.connectAccounts()).filter((a) => purposes.some((p) => a.address === this.accountFor(p)?.address)),
        }),
      },
      [BitcoinDisconnect]: { version: '1.0.0', disconnect: this.disconnect },
      [BitcoinEvents]: { version: '1.0.0', on: this.on },
      [BitcoinSignTransaction]: { version: '1.0.0', signTransaction: this.signTransactionFeature },
      [BitcoinSignAndSendTransaction]: { version: '1.0.0', signAndSendTransaction: this.signAndSendTransactionFeature },
      [BitcoinSignMessage]: { version: '1.0.0', signMessage: this.signMessageFeature },
      [SatsConnectFeature]: { provider: this.provider },
    };
  }

  private rebuildAccounts(): void {
    const exposed = [this.accountFor('payment'), this.accountFor('ordinals')].filter((a): a is BitcoinAccount => !!a);
    this.walletAccounts = exposed.map((a) => {
      const publicKey = hexToBytes(a.publicKey);
      return new ReadonlyWalletAccount({
        address: a.address,
        // Taproot accounts expose the x-only key, as other Bitcoin wallets do.
        publicKey: a.addressType === 'p2tr' ? publicKey.subarray(1) : publicKey,
        chains: this.chains,
        features: [BitcoinSignTransaction, BitcoinSignAndSendTransaction, BitcoinSignMessage],
        label: `CatCard ${a.path}`,
      });
    });
  }

  private emitChange(): void {
    for (const listener of this.listeners.change ?? []) listener({ accounts: this.accounts });
  }

  private account(walletAccount: WalletAccount | string): BitcoinAccount {
    const address = typeof walletAccount === 'string' ? walletAccount : walletAccount.address;
    const account = this.stored.find((a) => a.address === address);
    if (!account) throw new CatCardError(`Unknown account ${address}: connect the CatCard first`);
    return account;
  }

  /** Scans the device's account export (UR, or JSON over BBQr) unless already connected. */
  async connectAccounts(silent = false): Promise<readonly WalletAccount[]> {
    if (this.connected || silent) return this.accounts;
    const accounts = await this.options.bridge.exchange({
      title: 'Connect CatCard',
      description: 'On your CatCard, open the Bitcoin account export, then scan the QR code it shows.',
      parse: (result) => {
        const derived = deriveBitcoinAccounts(readAccountExport(result), this.network);
        if (derived.length === 0) throw new CatCardError(`No Bitcoin ${this.network} account found in this QR code`);
        return derived;
      },
    });
    this.stored = accounts;
    writeJSON(this.storage, this.storageKey, accounts);
    this.rebuildAccounts();
    this.emitChange();
    this.provider.notifyAccountChange();
    return this.accounts;
  }

  disconnect = async (): Promise<void> => {
    this.stored = [];
    this.storage.removeItem(this.storageKey);
    this.rebuildAccounts();
    this.emitChange();
    this.provider.notifyDisconnect();
  };

  private on = <E extends StandardEventsNames>(event: E, listener: StandardEventsListeners[E]): (() => void) => {
    const set = (this.listeners[event] ??= new Set()) as Set<StandardEventsListeners[E]>;
    set.add(listener);
    return () => set.delete(listener);
  };

  // ---------------------------------------------------------------- signing API

  /** Signs PSBT inputs (by default, every input spending from a connected account). */
  signPsbt(psbt: Uint8Array, inputs: readonly InputToSign[] = findOwnInputs(psbt, this.stored)): Promise<Uint8Array> {
    return this.signer.signPsbt(psbt, inputs);
  }

  signMessage(message: Uint8Array, address: string): Promise<BitcoinMessageSignature> {
    return this.signer.signMessage(message, this.account(address));
  }

  /** Finalizes a signed PSBT and broadcasts it; returns the transaction ID. */
  async broadcastPsbt(signedPsbt: Uint8Array): Promise<string> {
    const { hex } = finalizePsbt(signedPsbt);
    if (this.options.broadcast) return this.options.broadcast(hex, this.network);
    const base = this.options.rpc?.[this.network] ?? DEFAULT_ESPLORA[this.network];
    if (!base) throw new CatCardError(`No API endpoint configured to broadcast on ${this.network}`);
    const response = await (this.options.fetch ?? globalThis.fetch)(`${base.replace(/\/$/, '')}/tx`, { method: 'POST', body: hex });
    const text = (await response.text()).trim();
    if (!response.ok) throw new CatCardError(`Broadcast failed: ${text}`);
    return text;
  }

  // ---------------------------------------------------------------- Wallet Standard features

  private toInputs(input: BitcoinSignTransactionInput): InputToSign[] {
    return input.inputsToSign.flatMap(({ account, signingIndexes, sigHash }) =>
      signingIndexes.map((index) => ({ index, account: this.account(account), sigHash })),
    );
  }

  private signTransactionFeature = async (...inputs: readonly BitcoinSignTransactionInput[]) => {
    const outputs: { signedPsbt: Uint8Array }[] = [];
    for (const input of inputs) outputs.push({ signedPsbt: await this.signPsbt(input.psbt, this.toInputs(input)) });
    return outputs;
  };

  private signAndSendTransactionFeature = async (...inputs: readonly BitcoinSignTransactionInput[]) => {
    const outputs: { txId: string }[] = [];
    for (const input of inputs) {
      const signed = await this.signPsbt(input.psbt, this.toInputs(input));
      outputs.push({ txId: await this.broadcastPsbt(signed) });
    }
    return outputs;
  };

  private signMessageFeature = async (...inputs: readonly { account: WalletAccount; message: Uint8Array }[]) => {
    const outputs: { signedMessage: Uint8Array; signature: Uint8Array }[] = [];
    for (const input of inputs) {
      const { signature } = await this.signMessage(input.message, input.account.address);
      outputs.push({ signedMessage: input.message, signature });
    }
    return outputs;
  };
}

/** Registers the wallet with Wallet Standard (a no-op outside browsers). */
export function registerCatCardBitcoinWallet(wallet: CatCardBitcoinWallet): void {
  if (typeof window !== 'undefined') registerWallet(wallet);
}

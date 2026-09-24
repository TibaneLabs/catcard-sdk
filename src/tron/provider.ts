import type { CatCardBridge } from '../bridge';
import { CatCardError } from '../errors';
import { ACCOUNT_UR_TYPES, decodeAccountExport } from '../registry/accounts';
import { ProviderEvents, ProviderRpcError, toProviderRpcError } from '../rpc-error';
import { defaultStorage, readJSON, writeJSON, type KeyValueStorage } from '../storage';
import { deriveTronAccounts, type TronAccount } from './accounts';
import { CatCardTronSigner, type TronSignerOptions, type TronTransaction } from './signer';

export interface TronNetwork {
  name: string;
  fullHost: string;
  headers?: Record<string, string>;
}

/** Networks known by chain ID (hex of the genesis block's last 4 bytes, as TronLink reports them). */
export const TRON_NETWORKS: Readonly<Record<string, TronNetwork>> = {
  '0x2b6653dc': { name: 'Mainnet', fullHost: 'https://api.trongrid.io' },
  '0x94a9059e': { name: 'Shasta', fullHost: 'https://api.shasta.trongrid.io' },
  '0xcd8690dc': { name: 'Nile', fullHost: 'https://nile.trongrid.io' },
};

export const TRON_MAINNET_CHAIN_ID = '0x2b6653dc';

/** The subset of a TronWeb instance the provider relies on. */
export interface TronWebLike {
  setAddress(address: string): void;
  defaultAddress: { base58: string | false; hex: string | false };
  trx: Record<string, any>;
}

export type TronWebFactory = (options: { fullHost: string; headers?: Record<string, string> }) => TronWebLike | Promise<TronWebLike>;

export interface TronProviderOptions extends TronSignerOptions {
  bridge: CatCardBridge;
  /** @default localStorage, or in-memory */
  storage?: KeyValueStorage;
  /** @default 'catcard:tron' */
  storageKey?: string;
  /** @default mainnet (`0x2b6653dc`) */
  defaultChainId?: string;
  /**
   * Full node per chain ID: a URL, or `{ fullHost, headers }` (e.g. a TronGrid API key in
   * `TRON-PRO-API-KEY`). Defaults to TronGrid's public endpoints, which are rate-limited.
   */
  rpc?: Readonly<Record<string, string | { fullHost: string; headers?: Record<string, string> }>>;
  /** Addresses derived from the exported account. @default 5 */
  addressCount?: number;
  /**
   * Creates the TronWeb instance handed to dapps. By default uses a global `TronWeb`
   * (script-tag builds) or imports the `tronweb` package.
   */
  tronWebFactory?: TronWebFactory;
}

interface StoredState {
  accounts: TronAccount[];
  selected?: string;
  chainId?: string;
}

async function defaultTronWebFactory(options: { fullHost: string; headers?: Record<string, string> }): Promise<TronWebLike> {
  const g = globalThis as { TronWeb?: any };
  let TronWeb = typeof g.TronWeb === 'function' ? g.TronWeb : g.TronWeb?.TronWeb;
  if (typeof TronWeb !== 'function') {
    try {
      ({ TronWeb } = await import('tronweb'));
    } catch {
      throw new CatCardError('The Tron provider needs TronWeb: install the `tronweb` package (or load it globally).');
    }
  }
  return new TronWeb(options) as TronWebLike;
}

/**
 * TIP-1193 provider backed by a CatCard (as announced through TIP-6963). Like TronLink, it
 * exposes a `tronWeb` instance for the connected account whose signing methods
 * (`trx.sign`, `trx.multiSign`, `trx.signMessageV2`) go through the CatCard.
 */
export class CatCardTronProvider extends ProviderEvents {
  readonly isCatCard = true;
  /** TronWeb instance for the connected account, once connected. */
  tronWeb?: TronWebLike;

  private readonly storage: KeyValueStorage;
  private readonly storageKey: string;
  private state: StoredState;
  private tronWebReady?: Promise<TronWebLike>;

  constructor(private readonly options: TronProviderOptions) {
    super();
    this.storage = options.storage ?? defaultStorage();
    this.storageKey = options.storageKey ?? 'catcard:tron';
    this.state = { accounts: [], ...readJSON<StoredState>(this.storage, this.storageKey) };
    if (!this.state.chainId || !this.network(this.state.chainId)) {
      this.state.chainId = options.defaultChainId ?? TRON_MAINNET_CHAIN_ID;
    }
    if (this.connected) void this.refreshTronWeb().catch(() => undefined);
  }

  get chainId(): string {
    return this.state.chainId!;
  }

  get accounts(): readonly TronAccount[] {
    return this.state.accounts;
  }

  get selectedAccount(): TronAccount | undefined {
    return this.state.accounts.find((a) => a.address === this.state.selected) ?? this.state.accounts[0];
  }

  get connected(): boolean {
    return this.state.accounts.length > 0;
  }

  private network(chainId: string): TronNetwork | undefined {
    const custom = this.options.rpc?.[chainId];
    const known = TRON_NETWORKS[chainId];
    if (typeof custom === 'string') return { name: known?.name ?? chainId, fullHost: custom };
    if (custom) return { name: known?.name ?? chainId, ...custom };
    return known;
  }

  private save(): void {
    writeJSON(this.storage, this.storageKey, this.state);
  }

  getSigner(): CatCardTronSigner {
    const account = this.selectedAccount;
    if (!account) throw new ProviderRpcError(4100, 'Not connected to CatCard');
    return new CatCardTronSigner(account, this.options.bridge, { origin: this.options.origin, qr: this.options.qr });
  }

  /** Waits for the dapp-facing TronWeb instance (created after connecting). */
  getTronWeb(): Promise<TronWebLike> {
    if (!this.connected) return Promise.reject(new ProviderRpcError(4100, 'Not connected to CatCard'));
    return this.tronWebReady ?? this.refreshTronWeb();
  }

  private refreshTronWeb(): Promise<TronWebLike> {
    const network = this.network(this.chainId)!;
    const factory = this.options.tronWebFactory ?? defaultTronWebFactory;
    const ready = Promise.resolve(factory({ fullHost: network.fullHost, headers: network.headers })).then((tronWeb) => {
      this.hook(tronWeb);
      if (this.tronWebReady === ready) this.tronWeb = tronWeb;
      return tronWeb;
    });
    this.tronWebReady = ready;
    return ready;
  }

  /** Routes TronWeb's signing methods to the CatCard. */
  private hook(tronWeb: TronWebLike): void {
    const account = this.selectedAccount;
    if (account) tronWeb.setAddress(account.address);
    const unsupported = (what: string) => Promise.reject(new ProviderRpcError(4200, `${what} is not supported by CatCard`));
    tronWeb.trx.sign = (transaction: TronTransaction | string) => {
      if (typeof transaction === 'string') return unsupported('Legacy message signing (use signMessageV2)');
      return this.getSigner().signTransaction(transaction);
    };
    tronWeb.trx.multiSign = (transaction: TronTransaction, _privateKey?: string, permissionId?: number) => {
      const current = (transaction.raw_data.contract?.[0] as { Permission_id?: number } | undefined)?.Permission_id ?? 0;
      if (permissionId !== undefined && permissionId !== current) {
        return Promise.reject(new CatCardError('Set Permission_id when building the transaction; CatCard cannot change it'));
      }
      return this.getSigner().signTransaction(transaction);
    };
    tronWeb.trx.signMessageV2 = (message: string | Uint8Array) => this.getSigner().signMessage(message);
    tronWeb.trx.signTypedData = tronWeb.trx._signTypedData = () => unsupported('TIP-712 typed data signing');
  }

  async connect(): Promise<string[]> {
    const accounts = await this.options.bridge.exchange({
      title: 'Connect CatCard',
      description: 'On your CatCard, open the account export for Tron, then scan the QR code it shows.',
      parse: (result) => {
        if (result.format !== 'ur' || !ACCOUNT_UR_TYPES.includes(result.ur.type)) {
          throw new CatCardError('This is not a CatCard account QR code');
        }
        const derived = deriveTronAccounts(decodeAccountExport(result.ur), this.options.addressCount);
        if (derived.length === 0) throw new CatCardError('No Tron account found in this QR code');
        return derived;
      },
    });
    const wasConnected = this.connected;
    this.state.accounts = accounts;
    this.state.selected = accounts[0]!.address;
    this.save();
    await this.refreshTronWeb();
    if (!wasConnected) this.emit('connect', { chainId: this.chainId });
    this.emit('accountsChanged', [this.state.selected]);
    return [this.state.selected];
  }

  disconnect(): void {
    if (!this.connected) return;
    this.state.accounts = [];
    this.state.selected = undefined;
    this.tronWeb = undefined;
    this.tronWebReady = undefined;
    this.save();
    this.emit('accountsChanged', []);
    this.emit('disconnect', new ProviderRpcError(4900, 'Disconnected'));
  }

  async selectAccount(address: string): Promise<void> {
    const account = this.state.accounts.find((a) => a.address === address);
    if (!account) throw new CatCardError(`Unknown account ${address}`);
    this.state.selected = account.address;
    this.save();
    await this.refreshTronWeb();
    this.emit('accountsChanged', [account.address]);
  }

  async switchChain(chainId: string): Promise<void> {
    if (!this.network(chainId)) throw new ProviderRpcError(4902, `Unrecognized chain ID ${chainId}`);
    if (chainId === this.chainId) return;
    this.state.chainId = chainId;
    this.save();
    if (this.connected) await this.refreshTronWeb();
    this.emit('chainChanged', { chainId });
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<any> {
    try {
      return await this.handle(method, Array.isArray(params) ? params : params === undefined ? [] : [params]);
    } catch (e) {
      throw toProviderRpcError(e);
    }
  }

  private async handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_requestAccounts':
        return this.connected ? [this.selectedAccount!.address] : this.connect();
      case 'tron_requestAccounts':
        // TronLink's legacy protocol: accounts are then read from `tronWeb.defaultAddress`.
        if (!this.connected) await this.connect();
        await this.getTronWeb();
        return { code: 200, message: 'The site is already in the whitelist' };
      case 'eth_accounts':
        return this.connected ? [this.selectedAccount!.address] : [];
      case 'eth_chainId':
        return this.chainId;
      case 'wallet_switchEthereumChain': {
        const { chainId } = (params[0] ?? {}) as { chainId?: string };
        if (typeof chainId !== 'string') throw new ProviderRpcError(-32602, 'Expected [{ chainId }]');
        await this.switchChain(chainId.toLowerCase());
        return null;
      }
      case 'wallet_revokePermissions':
        this.disconnect();
        return null;
      default:
        throw new ProviderRpcError(4200, `Unsupported method: ${method}`);
    }
  }
}

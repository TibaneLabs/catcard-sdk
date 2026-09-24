import {
  createPublicClient,
  defineChain,
  getAddress,
  hexToBigInt,
  hexToNumber,
  http,
  isAddress,
  isHex,
  numberToHex,
  type AccessList,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionSerializable,
  type Transport,
} from 'viem';
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon, sepolia } from 'viem/chains';
import type { CatCardBridge } from '../bridge';
import { CatCardError } from '../errors';
import { ProviderEvents, ProviderRpcError, toProviderRpcError } from '../rpc-error';
import { ACCOUNT_UR_TYPES, decodeAccountExport } from '../registry/accounts';
import { defaultStorage, readJSON, writeJSON, type KeyValueStorage } from '../storage';
import { deriveEvmAccounts, type EvmAccount } from './accounts';
import { CatCardEvmSigner, type EvmSignerOptions } from './signer';

/** Chains available out of the box. Others can be passed in `chains`, or added by dapps via `wallet_addEthereumChain`. */
export const DEFAULT_EVM_CHAINS: readonly Chain[] = [mainnet, sepolia, base, arbitrum, optimism, polygon, bsc, avalanche];

export interface EvmProviderOptions extends EvmSignerOptions {
  bridge: CatCardBridge;
  /** Where connected accounts and the selected chain are remembered. @default localStorage, or in-memory */
  storage?: KeyValueStorage;
  /** @default 'catcard:evm' */
  storageKey?: string;
  /** Chains the provider knows. @default DEFAULT_EVM_CHAINS */
  chains?: readonly Chain[];
  /** Chain selected before the dapp picks one. @default the first of `chains` */
  defaultChainId?: number;
  /**
   * RPC endpoint per chain ID: a URL or any viem transport. Chains without an entry use
   * their default public RPC, which is rate-limited: production integrations should set their own.
   */
  rpc?: Readonly<Record<number, string | Transport>>;
  /** Addresses derived from each exported account key. @default 5 */
  addressCount?: number;
}

interface StoredChain {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

interface StoredState {
  accounts: EvmAccount[];
  selected?: Address;
  chainId?: number;
  addedChains?: StoredChain[];
}

/** JSON-RPC transaction request, as sent by dapps. */
interface RpcTransactionRequest {
  from?: Address;
  to?: Address | null;
  value?: Hex;
  data?: Hex;
  input?: Hex;
  gas?: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  nonce?: Hex;
  type?: Hex;
  chainId?: Hex;
  accessList?: AccessList;
}

const invalidParams = (message: string) => new ProviderRpcError(-32602, message);

function chainFromStored(c: StoredChain): Chain {
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: { default: { http: c.rpcUrls } },
    blockExplorers: c.blockExplorerUrls?.[0] ? { default: { name: c.name, url: c.blockExplorerUrls[0] } } : undefined,
  });
}

/**
 * EIP-1193 provider backed by a CatCard. Signing requests are shown as QR codes through the
 * bridge; everything else is forwarded to the chain's RPC endpoint.
 */
export class CatCardEthereumProvider extends ProviderEvents {
  readonly isCatCard = true;
  private readonly bridge: CatCardBridge;
  private readonly storage: KeyValueStorage;
  private readonly storageKey: string;
  private readonly chains = new Map<number, Chain>();
  private readonly clients = new Map<number, PublicClient>();
  private state: StoredState;

  constructor(private readonly options: EvmProviderOptions) {
    super();
    this.bridge = options.bridge;
    this.storage = options.storage ?? defaultStorage();
    this.storageKey = options.storageKey ?? 'catcard:evm';
    for (const chain of options.chains ?? DEFAULT_EVM_CHAINS) this.chains.set(chain.id, chain);
    if (this.chains.size === 0) throw new CatCardError('At least one chain is required');

    const stored = readJSON<StoredState>(this.storage, this.storageKey);
    this.state = { accounts: [], ...stored };
    for (const c of this.state.addedChains ?? []) if (!this.chains.has(c.id)) this.chains.set(c.id, chainFromStored(c));
    if (this.state.chainId === undefined || !this.chains.has(this.state.chainId)) {
      const fallback = options.defaultChainId ?? this.chains.keys().next().value!;
      if (!this.chains.has(fallback)) throw new CatCardError(`Unknown default chain ${fallback}`);
      this.state.chainId = fallback;
    }
  }

  // ---------------------------------------------------------------- state

  get chainId(): number {
    return this.state.chainId!;
  }

  get chain(): Chain {
    return this.chains.get(this.chainId)!;
  }

  /** All addresses imported from the device. */
  get accounts(): readonly EvmAccount[] {
    return this.state.accounts;
  }

  /** The account exposed to dapps, if connected. */
  get selectedAccount(): EvmAccount | undefined {
    return this.state.accounts.find((a) => a.address === this.state.selected) ?? this.state.accounts[0];
  }

  get connected(): boolean {
    return this.state.accounts.length > 0;
  }

  private save(): void {
    writeJSON(this.storage, this.storageKey, this.state);
  }

  /** A public client for a chain, using the configured RPC endpoint. */
  getClient(chainId: number = this.chainId): PublicClient {
    let client = this.clients.get(chainId);
    if (!client) {
      const chain = this.chains.get(chainId);
      if (!chain) throw new ProviderRpcError(4901, `Chain ${chainId} is not configured`);
      const rpc = this.options.rpc?.[chainId];
      const transport = typeof rpc === 'function' ? rpc : http(rpc);
      client = createPublicClient({ chain, transport }) as PublicClient;
      this.clients.set(chainId, client);
    }
    return client;
  }

  /** A signer for the selected account (or a specific one), e.g. for viem integration. */
  getSigner(address?: Address): CatCardEvmSigner {
    const account = address
      ? this.state.accounts.find((a) => a.address === getAddress(address))
      : this.selectedAccount;
    if (!account) throw new ProviderRpcError(4100, 'Not connected to CatCard, or unknown account');
    return new CatCardEvmSigner(account, this.bridge, { origin: this.options.origin, qr: this.options.qr });
  }

  // ---------------------------------------------------------------- connection

  /** Scans the device's account export QR and selects its first address. */
  async connect(): Promise<Address[]> {
    const accounts = await this.bridge.exchange({
      title: 'Connect CatCard',
      description: 'On your CatCard, open the account export for EVM, then scan the QR code it shows.',
      parse: (result) => {
        if (result.format !== 'ur' || !ACCOUNT_UR_TYPES.includes(result.ur.type)) {
          throw new CatCardError('This is not a CatCard account QR code');
        }
        const derived = deriveEvmAccounts(decodeAccountExport(result.ur), this.options.addressCount);
        if (derived.length === 0) throw new CatCardError('No EVM account found in this QR code');
        return derived;
      },
    });
    const wasConnected = this.connected;
    this.state.accounts = accounts;
    this.state.selected = accounts[0]!.address;
    this.save();
    if (!wasConnected) this.emit('connect', { chainId: numberToHex(this.chainId) });
    this.emit('accountsChanged', [this.state.selected]);
    return [this.state.selected];
  }

  /** Forgets the imported accounts. */
  disconnect(): void {
    if (!this.connected) return;
    this.state.accounts = [];
    this.state.selected = undefined;
    this.save();
    this.emit('accountsChanged', []);
  }

  selectAccount(address: Address): void {
    const account = this.state.accounts.find((a) => a.address === getAddress(address));
    if (!account) throw new CatCardError(`Unknown account ${address}`);
    this.state.selected = account.address;
    this.save();
    this.emit('accountsChanged', [account.address]);
  }

  switchChain(chainId: number): void {
    if (!this.chains.has(chainId)) throw new ProviderRpcError(4902, `Unrecognized chain ID ${numberToHex(chainId)}`);
    if (chainId === this.chainId) return;
    this.state.chainId = chainId;
    this.save();
    this.emit('chainChanged', numberToHex(chainId));
  }

  // ---------------------------------------------------------------- EIP-1193

  async request({ method, params }: { method: string; params?: unknown }): Promise<any> {
    try {
      return await this.handle(method, Array.isArray(params) ? params : params === undefined ? [] : [params]);
    } catch (e) {
      throw toProviderRpcError(e);
    }
  }

  private requireAccount(address?: unknown): CatCardEvmSigner {
    if (!this.connected) throw new ProviderRpcError(4100, 'Not connected: call eth_requestAccounts first');
    if (address !== undefined && (typeof address !== 'string' || !isAddress(address))) {
      throw invalidParams('Invalid address');
    }
    const signer = this.getSigner(address as Address | undefined);
    if (address !== undefined && signer.address !== this.selectedAccount?.address) {
      throw new ProviderRpcError(4100, 'Requested account is not the connected account');
    }
    return signer;
  }

  private async handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_requestAccounts':
        return this.connected ? [this.selectedAccount!.address] : this.connect();
      case 'eth_accounts':
        return this.connected ? [this.selectedAccount!.address] : [];
      case 'eth_coinbase':
        return this.selectedAccount?.address ?? null;
      case 'eth_chainId':
        return numberToHex(this.chainId);
      case 'net_version':
        return String(this.chainId);

      case 'wallet_requestPermissions':
        if (!this.connected) await this.connect();
        return this.permissions();
      case 'wallet_getPermissions':
        return this.connected ? this.permissions() : [];
      case 'wallet_revokePermissions':
        this.disconnect();
        return null;

      case 'wallet_switchEthereumChain': {
        const { chainId } = (params[0] ?? {}) as { chainId?: Hex };
        if (!chainId || !isHex(chainId)) throw invalidParams('Expected [{ chainId }]');
        this.switchChain(hexToNumber(chainId));
        return null;
      }
      case 'wallet_addEthereumChain':
        return this.addChain(params[0]);

      case 'personal_sign': {
        const [message, address] = params as [unknown, unknown];
        if (typeof message !== 'string') throw invalidParams('Expected [message, address]');
        const signer = this.requireAccount(address);
        return signer.signMessage(isHex(message) ? { raw: message } : message);
      }
      case 'eth_signTypedData_v4':
      case 'eth_signTypedData_v3': {
        const [address, typedData] = params as [unknown, unknown];
        const signer = this.requireAccount(address);
        if (typeof typedData === 'string') return signer.signTypedData(typedData);
        if (typedData && typeof typedData === 'object') return signer.signTypedData(JSON.stringify(typedData));
        throw invalidParams('Expected [address, typedData]');
      }
      case 'eth_sign':
      case 'eth_signTypedData':
        throw new ProviderRpcError(4200, `${method} is not supported (unsafe or deprecated)`);

      case 'eth_signTransaction': {
        const request = this.txRequest(params);
        const signer = this.requireAccount(request.from);
        return signer.signTransaction(await this.prepareTransaction(request, signer.address));
      }
      case 'eth_sendTransaction': {
        const request = this.txRequest(params);
        const signer = this.requireAccount(request.from);
        const signed = await signer.signTransaction(await this.prepareTransaction(request, signer.address));
        return this.getClient().request({ method: 'eth_sendRawTransaction', params: [signed] });
      }

      default:
        if (method.startsWith('wallet_') || method.startsWith('eth_sign')) {
          throw new ProviderRpcError(4200, `Unsupported method: ${method}`);
        }
        return this.getClient().request({ method, params } as never);
    }
  }

  private permissions() {
    return [{ parentCapability: 'eth_accounts', caveats: [] }];
  }

  private addChain(param: unknown): null {
    const p = (param ?? {}) as {
      chainId?: Hex;
      chainName?: string;
      rpcUrls?: string[];
      nativeCurrency?: StoredChain['nativeCurrency'];
      blockExplorerUrls?: string[];
    };
    if (!p.chainId || !isHex(p.chainId)) throw invalidParams('Missing chainId');
    const id = hexToNumber(p.chainId);
    if (!this.chains.has(id)) {
      const rpcUrls = (p.rpcUrls ?? []).filter((u) => /^https:\/\//.test(u));
      if (!rpcUrls.length || !p.chainName || !p.nativeCurrency) throw invalidParams('chainName, rpcUrls (https) and nativeCurrency are required');
      const stored: StoredChain = {
        id,
        name: p.chainName,
        nativeCurrency: p.nativeCurrency,
        rpcUrls,
        blockExplorerUrls: p.blockExplorerUrls,
      };
      this.chains.set(id, chainFromStored(stored));
      this.state.addedChains = [...(this.state.addedChains ?? []), stored];
      this.save();
    }
    this.switchChain(id);
    return null;
  }

  private txRequest(params: unknown[]): RpcTransactionRequest {
    const request = params[0];
    if (!request || typeof request !== 'object') throw invalidParams('Expected a transaction object');
    return request as RpcTransactionRequest;
  }

  /** Fills in nonce, fees and gas from the RPC endpoint, like other wallets do. */
  private async prepareTransaction(req: RpcTransactionRequest, from: Address): Promise<TransactionSerializable> {
    const chainId = this.chainId;
    if (req.chainId !== undefined && hexToNumber(req.chainId) !== chainId) {
      throw invalidParams(`Transaction chainId ${req.chainId} does not match the active chain ${numberToHex(chainId)}`);
    }
    const client = this.getClient();
    const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never) as Promise<Hex>;
    const to = req.to ?? undefined;
    const data = req.data ?? req.input;
    const value = req.value !== undefined ? hexToBigInt(req.value) : undefined;
    const nonce = hexToNumber(req.nonce ?? (await rpc('eth_getTransactionCount', [from, 'pending'])));

    let fees: { gasPrice: bigint } | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    const wantsLegacy = req.type === '0x0' || req.type === '0x1' || req.gasPrice !== undefined;
    if (req.gasPrice !== undefined) {
      fees = { gasPrice: hexToBigInt(req.gasPrice) };
    } else {
      const block = wantsLegacy ? undefined : ((await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })) as { baseFeePerGas?: Hex } | null);
      if (!wantsLegacy && block?.baseFeePerGas) {
        const priority =
          req.maxPriorityFeePerGas !== undefined
            ? hexToBigInt(req.maxPriorityFeePerGas)
            : await rpc('eth_maxPriorityFeePerGas', []).then(hexToBigInt, () => 1_500_000_000n);
        const maxFee = req.maxFeePerGas !== undefined ? hexToBigInt(req.maxFeePerGas) : hexToBigInt(block.baseFeePerGas) * 2n + priority;
        fees = { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority > maxFee ? maxFee : priority };
      } else {
        fees = { gasPrice: hexToBigInt(await rpc('eth_gasPrice', [])) };
      }
    }

    const gas =
      req.gas !== undefined
        ? hexToBigInt(req.gas)
        : hexToBigInt(
            await rpc('eth_estimateGas', [
              { from, to, data, value: value === undefined ? undefined : numberToHex(value), accessList: req.accessList },
            ]),
          );

    const common = { chainId, to, data, value, nonce, gas };
    if ('gasPrice' in fees) {
      return req.accessList || req.type === '0x1'
        ? { ...common, ...fees, type: 'eip2930', accessList: req.accessList ?? [] }
        : { ...common, ...fees, type: 'legacy' };
    }
    return { ...common, ...fees, type: 'eip1559', accessList: req.accessList };
  }
}

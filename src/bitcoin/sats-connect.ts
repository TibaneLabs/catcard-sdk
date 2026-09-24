// sats-connect (v4, JSON-RPC) compatible provider, discoverable via WBIP004 (`window.btc_providers`).

import { base64 } from '@scure/base';
import { UserRejectedError } from '../bridge';
import { CatCardError } from '../errors';
import { CATCARD_ICON } from '../icon';
import { utf8Encode } from '../util/bytes';
import type { BitcoinAccount, BitcoinNetwork } from './accounts';
import type { InputToSign } from './psbt';
import type { BitcoinAddressPurpose, CatCardBitcoinWallet } from './wallet';

/** sats-connect RPC error codes. */
export const SatsConnectErrorCode = {
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
  USER_REJECTION: -32000,
  METHOD_NOT_SUPPORTED: -32001,
} as const;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const METHODS = ['getInfo', 'getAddresses', 'getAccounts', 'signPsbt', 'signMessage', 'wallet_connect', 'wallet_disconnect', 'wallet_getNetwork'];

const NETWORK_NAMES: Record<BitcoinNetwork, string> = {
  mainnet: 'Mainnet',
  testnet: 'Testnet',
  testnet4: 'Testnet4',
  signet: 'Signet',
  regtest: 'Regtest',
};

export interface SatsConnectAddress {
  address: string;
  publicKey: string;
  purpose: BitcoinAddressPurpose;
  addressType: 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2tr';
  walletType: 'keystone';
}

type Listener = (event: { type: string; [key: string]: unknown }) => void;

/**
 * The request API used by sats-connect and WBIP-compatible dapps (as Xverse, Leather, Magic
 * Eden expose). Registered in `window.btc_providers` as `catcard.bitcoin`.
 */
export class CatCardSatsConnectProvider {
  readonly isCatCard = true;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly wallet: CatCardBitcoinWallet) {}

  /** WBIP004 provider registration entry. */
  static providerInfo(id = 'catcard.bitcoin'): { id: string; name: string; icon: string; webUrl: string; methods: string[] } {
    return { id, name: 'CatCard', icon: CATCARD_ICON, webUrl: 'https://github.com/TibaneLabs/catcard-sdk', methods: [...METHODS] };
  }

  async request(method: string, params?: unknown): Promise<{ jsonrpc: '2.0'; id: string; result?: unknown; error?: { code: number; message: string } }> {
    const id = crypto.randomUUID();
    try {
      return { jsonrpc: '2.0', id, result: await this.handle(method, (params ?? {}) as Record<string, unknown>) };
    } catch (e) {
      let code: number = SatsConnectErrorCode.INTERNAL_ERROR;
      if (e instanceof RpcError) code = e.code;
      else if (e instanceof UserRejectedError) code = SatsConnectErrorCode.USER_REJECTION;
      else if (e instanceof CatCardError) code = SatsConnectErrorCode.INVALID_PARAMS;
      return { jsonrpc: '2.0', id, error: { code, message: (e as Error).message ?? String(e) } };
    }
  }

  /** `addListener('accountChange' | 'disconnect', cb)` or `addListener({ eventName, cb })`. Returns an unsubscribe function. */
  addListener(event: string | { eventName: string; cb: Listener }, cb?: Listener): () => void {
    const name = typeof event === 'string' ? event : event.eventName;
    const listener = typeof event === 'string' ? cb! : event.cb;
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** @internal */
  notifyAccountChange(): void {
    this.emit('accountChange', { type: 'accountChange', addresses: this.addresses(['payment', 'ordinals']) });
  }

  /** @internal */
  notifyDisconnect(): void {
    this.emit('disconnect', { type: 'disconnect' });
  }

  private emit(name: string, event: { type: string; [key: string]: unknown }): void {
    for (const listener of this.listeners.get(name) ?? []) {
      try {
        listener(event);
      } catch (e) {
        console.error(e);
      }
    }
  }

  private network() {
    return { bitcoin: { name: NETWORK_NAMES[this.wallet.network] }, stacks: { name: 'mainnet' }, spark: { name: 'mainnet' } };
  }

  private addresses(purposes: readonly string[]): SatsConnectAddress[] {
    const out: SatsConnectAddress[] = [];
    for (const purpose of purposes) {
      if (purpose !== 'payment' && purpose !== 'ordinals') continue;
      const account = this.wallet.accountFor(purpose);
      if (!account) continue;
      const publicKey = account.addressType === 'p2tr' ? account.publicKey.slice(2) : account.publicKey;
      const addressType = account.addressType === 'p2sh-p2wpkh' ? 'p2sh' : account.addressType;
      out.push({ address: account.address, publicKey, purpose, addressType, walletType: 'keystone' });
    }
    return out;
  }

  private purposes(params: Record<string, unknown>, key: string): string[] {
    const purposes = params[key] ?? ['payment', 'ordinals'];
    if (!Array.isArray(purposes)) throw new RpcError(SatsConnectErrorCode.INVALID_PARAMS, `${key} must be an array`);
    return purposes as string[];
  }

  private account(address: string): BitcoinAccount {
    const account = this.wallet.bitcoinAccounts.find((a) => a.address === address);
    if (!account) throw new RpcError(SatsConnectErrorCode.INVALID_PARAMS, `Unknown address ${address}`);
    return account;
  }

  private async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'getInfo':
        return { version: '1.0.0', platform: 'web', methods: [...METHODS], supports: [] };
      case 'getAddresses': {
        await this.wallet.connectAccounts();
        return { addresses: this.addresses(this.purposes(params, 'purposes')), network: this.network() };
      }
      case 'getAccounts':
        await this.wallet.connectAccounts();
        return this.addresses(this.purposes(params, 'purposes'));
      case 'wallet_connect':
        await this.wallet.connectAccounts();
        return { id: 'catcard', addresses: this.addresses(this.purposes(params, 'addresses')), walletType: 'keystone', network: this.network() };
      case 'wallet_disconnect':
        await this.wallet.disconnect();
        return null;
      case 'wallet_getNetwork':
        return this.network();

      case 'signPsbt': {
        if (typeof params.psbt !== 'string') throw new RpcError(SatsConnectErrorCode.INVALID_PARAMS, 'psbt (base64) is required');
        const psbt = base64.decode(params.psbt);
        let inputs: InputToSign[] | undefined;
        if (params.signInputs && typeof params.signInputs === 'object') {
          inputs = Object.entries(params.signInputs as Record<string, number[]>).flatMap(([address, indexes]) =>
            indexes.map((index) => ({ index, account: this.account(address) })),
          );
        }
        const signed = await this.wallet.signPsbt(psbt, inputs);
        const txid = params.broadcast ? await this.wallet.broadcastPsbt(signed) : undefined;
        return { psbt: base64.encode(signed), ...(txid ? { txid } : {}) };
      }
      case 'signMessage': {
        const { address, message, protocol } = params as { address?: string; message?: string; protocol?: string };
        if (typeof address !== 'string' || typeof message !== 'string') {
          throw new RpcError(SatsConnectErrorCode.INVALID_PARAMS, 'address and message are required');
        }
        if (protocol === 'BIP322') throw new RpcError(SatsConnectErrorCode.METHOD_NOT_SUPPORTED, 'BIP-322 message signing is not supported');
        const result = await this.wallet.signMessage(utf8Encode(message), address);
        return { signature: result.base64, messageHash: result.messageHash, address, protocol: 'ECDSA' };
      }
      default:
        throw new RpcError(SatsConnectErrorCode.METHOD_NOT_FOUND, `Unsupported method: ${method}`);
    }
  }

  // Legacy (sats-connect v3, JWT-based) methods.
  connect = (): Promise<never> => this.legacy();
  signMessage = (): Promise<never> => this.legacy();
  signTransaction = (): Promise<never> => this.legacy();
  sendBtcTransaction = (): Promise<never> => this.legacy();
  createInscription = (): Promise<never> => this.legacy();
  createRepeatInscriptions = (): Promise<never> => this.legacy();
  signMultipleTransactions = (): Promise<never> => this.legacy();

  private legacy(): Promise<never> {
    return Promise.reject(new CatCardError('CatCard supports the sats-connect request() API (v4) only'));
  }
}


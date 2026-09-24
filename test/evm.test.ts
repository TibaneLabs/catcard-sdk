import {
  custom,
  hashTypedData,
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  toHex,
  type Hex,
} from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserRejectedError } from '../src/bridge';
import { CatCardEthereumProvider, CatCardEvmSigner, deriveEvmAccounts, ProviderRpcError } from '../src/evm';
import { decodeAccountExport, decodeEthSignRequest, EthDataType } from '../src/registry';
import { memoryStorage } from '../src/storage';
import { SimulatedBridge, SimulatedCatCard, type VConvention } from './helpers/device';

const device = new SimulatedCatCard();
const expectedAddress = (i: number) =>
  privateKeyToAddress(toHex(device.master.derive(`m/44'/60'/0'/0/${i}`).privateKey!));

const typedData = {
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  types: {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
} as const;

describe('EVM accounts', () => {
  it('derives the standard BIP44 addresses from a crypto-hdkey export', () => {
    const accounts = deriveEvmAccounts(decodeAccountExport(device.evmAccountExport()), 3);
    expect(accounts.map((a) => a.address)).toEqual([0, 1, 2].map(expectedAddress));
    expect(accounts[2]).toMatchObject({ path: "m/44'/60'/0'/0/2", sourceFingerprint: device.fingerprint });
  });
});

describe('CatCardEvmSigner', () => {
  const account = deriveEvmAccounts(decodeAccountExport(device.evmAccountExport()), 1)[0]!;
  let bridge: SimulatedBridge;
  let signer: CatCardEvmSigner;

  beforeEach(() => {
    device.vConvention = 'eip155';
    device.signWithWrongKey = false;
    bridge = new SimulatedBridge(device);
    signer = new CatCardEvmSigner(account, bridge, { origin: 'test-dapp' });
  });

  const conventions: VConvention[] = ['parity', '27', 'eip155'];
  for (const convention of conventions) {
    it(`signs EIP-1559 and legacy transactions (device v convention: ${convention})`, async () => {
      device.vConvention = convention;
      const base = { chainId: 137, to: expectedAddress(1), value: 10n ** 18n, nonce: 7, gas: 21000n };
      const eip1559 = await signer.signTransaction({ ...base, maxFeePerGas: 3n * 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n });
      const legacy = await signer.signTransaction({ ...base, gasPrice: 3n * 10n ** 10n });
      for (const raw of [eip1559, legacy]) {
        expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(account.address);
        expect(parseTransaction(raw)).toMatchObject({ chainId: 137, nonce: 7, value: 10n ** 18n });
      }
      const [req1559, reqLegacy] = device.requests.slice(-2).map(decodeEthSignRequest);
      expect(req1559).toMatchObject({ dataType: EthDataType.TypedTransaction, chainId: 137, origin: 'test-dapp' });
      expect(reqLegacy!.dataType).toBe(EthDataType.Transaction);
      expect(reqLegacy!.derivationPath.toString()).toBe("m/44'/60'/0'/0/0");
    });
  }

  it('signs personal messages and typed data', async () => {
    for (const convention of conventions) {
      device.vConvention = convention;
      const sig = await signer.signMessage('hello CatCard');
      expect(await recoverMessageAddress({ message: 'hello CatCard', signature: sig })).toBe(account.address);
      expect(sig.slice(-2)).toMatch(/1b|1c/);
    }
    const sig = await signer.signTypedData(typedData);
    expect(await recoverTypedDataAddress({ ...typedData, signature: sig })).toBe(account.address);
    const fromJson = await signer.signTypedData(JSON.stringify(typedData));
    expect(await recoverTypedDataAddress({ ...typedData, signature: fromJson })).toBe(account.address);
    expect(hashTypedData(typedData)).toBeDefined();
  });

  it('rejects signatures from the wrong key', async () => {
    device.signWithWrongKey = true;
    await expect(signer.signMessage('x')).rejects.toThrow(/not made by the selected account/);
  });

  it('works as a viem account', async () => {
    const viemAccount = signer.toViemAccount();
    const sig = await viemAccount.signMessage({ message: 'viem' });
    expect(await recoverMessageAddress({ message: 'viem', signature: sig })).toBe(account.address);
  });
});

describe('CatCardEthereumProvider', () => {
  const rpcCalls: { method: string; params: unknown }[] = [];
  const rpc = custom({
    async request({ method, params }) {
      rpcCalls.push({ method, params });
      switch (method) {
        case 'eth_getTransactionCount':
          return '0x5';
        case 'eth_getBlockByNumber':
          return { baseFeePerGas: '0x3b9aca00' }; // 1 gwei
        case 'eth_maxPriorityFeePerGas':
          return '0x77359400'; // 2 gwei
        case 'eth_estimateGas':
          return '0x5208';
        case 'eth_sendRawTransaction':
          return '0x' + 'ab'.repeat(32);
        case 'eth_blockNumber':
          return '0x10';
        default:
          throw new Error(`unexpected RPC ${method}`);
      }
    },
  });

  let bridge: SimulatedBridge;
  let provider: CatCardEthereumProvider;

  beforeEach(() => {
    rpcCalls.length = 0;
    device.vConvention = 'eip155';
    device.signWithWrongKey = false;
    bridge = new SimulatedBridge(device);
    bridge.scanOnly = () => device.evmAccountExport();
    provider = new CatCardEthereumProvider({ bridge, storage: memoryStorage(), rpc: { 1: rpc, 8453: rpc } });
  });

  it('connects by scanning the account export, and emits events', async () => {
    const events: [string, unknown][] = [];
    provider.on('connect', (e) => events.push(['connect', e]));
    provider.on('accountsChanged', (e) => events.push(['accountsChanged', e]));
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([]);
    expect(await provider.request({ method: 'eth_requestAccounts' })).toEqual([expectedAddress(0)]);
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([expectedAddress(0)]);
    expect(events).toEqual([
      ['connect', { chainId: '0x1' }],
      ['accountsChanged', [expectedAddress(0)]],
    ]);
    // Already connected: no new scan.
    await provider.request({ method: 'eth_requestAccounts' });
    expect(bridge.exchanges).toHaveLength(1);
  });

  it('remembers accounts and chain in storage', async () => {
    const storage = memoryStorage();
    const p1 = new CatCardEthereumProvider({ bridge, storage, rpc: { 1: rpc } });
    await p1.request({ method: 'eth_requestAccounts' });
    await p1.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] });
    const p2 = new CatCardEthereumProvider({ bridge, storage });
    expect(await p2.request({ method: 'eth_accounts' })).toEqual([expectedAddress(0)]);
    expect(await p2.request({ method: 'eth_chainId' })).toBe('0x2105');
  });

  it('fills, signs and broadcasts eth_sendTransaction through the configured RPC', async () => {
    await provider.request({ method: 'eth_requestAccounts' });
    const hash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: expectedAddress(0), to: expectedAddress(1), value: '0xde0b6b3a7640000' }],
    });
    expect(hash).toBe('0x' + 'ab'.repeat(32));
    const raw = rpcCalls.find((c) => c.method === 'eth_sendRawTransaction')!.params as [Hex];
    const tx = parseTransaction(raw[0]);
    expect(tx).toMatchObject({
      type: 'eip1559',
      chainId: 1,
      nonce: 5,
      gas: 21000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      maxFeePerGas: 4_000_000_000n,
      value: 10n ** 18n,
    });
    expect(await recoverTransactionAddress({ serializedTransaction: raw[0] as never })).toBe(expectedAddress(0));
  });

  it('forwards read-only calls to the RPC endpoint', async () => {
    expect(await provider.request({ method: 'eth_blockNumber' })).toBe('0x10');
  });

  it('handles personal_sign and eth_signTypedData_v4', async () => {
    await provider.request({ method: 'eth_requestAccounts' });
    const address = expectedAddress(0);
    const sig = await provider.request({ method: 'personal_sign', params: ['0x68656c6c6f', address] });
    expect(await recoverMessageAddress({ message: 'hello', signature: sig })).toBe(address);
    const typed = await provider.request({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify(typedData)] });
    expect(await recoverTypedDataAddress({ ...typedData, signature: typed })).toBe(address);
  });

  it('returns EIP-1193 errors', async () => {
    await expect(provider.request({ method: 'personal_sign', params: ['0x00', expectedAddress(0)] })).rejects.toMatchObject({ code: 4100 });
    await expect(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x999999' }] })).rejects.toMatchObject({ code: 4902 });
    await expect(provider.request({ method: 'eth_sign', params: [] })).rejects.toBeInstanceOf(ProviderRpcError);

    await provider.request({ method: 'eth_requestAccounts' });
    bridge.exchange = async () => {
      throw new UserRejectedError();
    };
    await expect(provider.request({ method: 'personal_sign', params: ['0x00', expectedAddress(0)] })).rejects.toMatchObject({ code: 4001 });
  });

  it('adds chains via wallet_addEthereumChain', async () => {
    const changes: unknown[] = [];
    provider.on('chainChanged', (c) => changes.push(c));
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: '0x539', chainName: 'Local', rpcUrls: ['https://rpc.example'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }],
    });
    expect(changes).toEqual(['0x539']);
    expect(provider.chain.rpcUrls.default.http).toEqual(['https://rpc.example']);
  });
});

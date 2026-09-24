import { TronWeb, utils } from 'tronweb';
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeAccountExport, decodeTronSignRequest, TronDataType } from '../src/registry';
import { memoryStorage } from '../src/storage';
import { CatCardTronProvider, deriveTronAccounts, type TronTransaction, type TronWebLike } from '../src/tron';
import { SimulatedBridge, SimulatedCatCard, type VConvention } from './helpers/device';

const device = new SimulatedCatCard();
const privateKey = (i: number) => Buffer.from(device.master.derive(`m/44'/195'/0'/0/${i}`).privateKey!).toString('hex');
const expectedAddress = (i: number) => TronWeb.address.fromPrivateKey(privateKey(i)) as string;

function transfer(from: string, amount = 1_000_000): TronTransaction {
  const tx: any = {
    visible: false,
    raw_data: {
      contract: [
        {
          parameter: {
            value: { amount, owner_address: TronWeb.address.toHex(from), to_address: TronWeb.address.toHex(expectedAddress(3)) },
            type_url: 'type.googleapis.com/protocol.TransferContract',
          },
          type: 'TransferContract',
        },
      ],
      ref_block_bytes: 'abcd',
      ref_block_hash: '0123456789abcdef',
      expiration: 1_900_000_060_000,
      timestamp: 1_900_000_000_000,
    },
  };
  const pb = utils.transaction.txJsonToPb(tx);
  tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).toLowerCase();
  tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '');
  return tx;
}

describe('Tron accounts', () => {
  it('derives m/44\'/195\'/0\'/0/i addresses like TronWeb', () => {
    const accounts = deriveTronAccounts(decodeAccountExport(device.tronAccountExport()), 2);
    expect(accounts.map((a) => a.address)).toEqual([expectedAddress(0), expectedAddress(1)]);
    expect(accounts[0]!.hexAddress).toBe(TronWeb.address.toHex(expectedAddress(0)).toLowerCase());
  });
});

describe('CatCardTronProvider', () => {
  let bridge: SimulatedBridge;
  let provider: CatCardTronProvider;
  const factory = (options: { fullHost: string }) => new TronWeb({ fullHost: options.fullHost }) as unknown as TronWebLike;

  beforeEach(() => {
    device.vConvention = 'eip155';
    device.signWithWrongKey = false;
    bridge = new SimulatedBridge(device);
    bridge.scanOnly = () => device.tronAccountExport();
    provider = new CatCardTronProvider({ bridge, storage: memoryStorage(), tronWebFactory: factory, origin: 'test-dapp' });
  });

  it('connects TIP-1193 style and exposes a TronWeb for the account', async () => {
    const events: unknown[] = [];
    provider.on('connect', (e) => events.push(['connect', e]));
    provider.on('accountsChanged', (e) => events.push(['accountsChanged', e]));
    expect(await provider.request({ method: 'eth_requestAccounts' })).toEqual([expectedAddress(0)]);
    expect(provider.tronWeb!.defaultAddress.base58).toBe(expectedAddress(0));
    expect(events).toEqual([
      ['connect', { chainId: '0x2b6653dc' }],
      ['accountsChanged', [expectedAddress(0)]],
    ]);
    // Legacy TronLink protocol.
    expect(await provider.request({ method: 'tron_requestAccounts' })).toMatchObject({ code: 200 });
  });

  for (const convention of ['parity', '27'] as VConvention[]) {
    it(`signs transactions through tronWeb.trx.sign (device v: ${convention})`, async () => {
      device.vConvention = convention;
      await provider.request({ method: 'eth_requestAccounts' });
      const tx = transfer(expectedAddress(0));
      const signed = await provider.tronWeb!.trx.sign(tx);
      expect(signed.signature).toHaveLength(1);
      expect(signed.txID).toBe(tx.txID);
      expect(tx.signature).toBeUndefined();
      expect(TronWeb.address.fromHex(utils.crypto.ecRecover(signed.txID, signed.signature[0]!))).toBe(expectedAddress(0));
      const request = decodeTronSignRequest(device.requests[device.requests.length - 1]!);
      expect(request).toMatchObject({ dataType: TronDataType.Transaction, origin: 'test-dapp' });
      expect(request.derivationPath.toString()).toBe("m/44'/195'/0'/0/0");
    });
  }

  it('signs messages through tronWeb.trx.signMessageV2', async () => {
    await provider.request({ method: 'eth_requestAccounts' });
    const signature = await provider.tronWeb!.trx.signMessageV2('hello CatCard');
    expect(utils.message.verifyMessage('hello CatCard', signature)).toBe(expectedAddress(0));
  });

  it('rejects tampered transactions and wrong-key signatures', async () => {
    await provider.request({ method: 'eth_requestAccounts' });
    const tx = transfer(expectedAddress(0));
    await expect(provider.tronWeb!.trx.sign({ ...tx, txID: '00'.repeat(32) })).rejects.toThrow(/does not match/);
    device.signWithWrongKey = true;
    await expect(provider.tronWeb!.trx.sign(tx)).rejects.toThrow(/not made by the selected account/);
    await expect(provider.tronWeb!.trx._signTypedData({}, {}, {})).rejects.toMatchObject({ code: 4200 });
  });

  it('switches networks and rejects unknown ones', async () => {
    await provider.request({ method: 'eth_requestAccounts' });
    const changes: unknown[] = [];
    provider.on('chainChanged', (c) => changes.push(c));
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xcd8690dc' }] });
    expect(changes).toEqual([{ chainId: '0xcd8690dc' }]);
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0xcd8690dc');
    await expect(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })).rejects.toMatchObject({ code: 4902 });
  });
});

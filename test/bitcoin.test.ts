import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CatCardBitcoinWallet,
  deriveBitcoinAccounts,
  hashBitcoinMessage,
  parseBitcoinJsonExport,
  type BitcoinAccount,
} from '../src/bitcoin';
import { UserRejectedError } from '../src/bridge';
import { decodeAccountExport } from '../src/registry';
import { createBBQrSequence } from '../src/sequence';
import { memoryStorage } from '../src/storage';
import { utf8Encode } from '../src/util/bytes';
import { SimulatedBridge, SimulatedCatCard } from './helpers/device';

const device = new SimulatedCatCard();
const addressAt = (path: string, type: 'p2wpkh' | 'p2tr' | 'p2pkh' | 'p2sh-p2wpkh') => {
  const pub = device.master.derive(path).publicKey!;
  if (type === 'p2wpkh') return btc.p2wpkh(pub).address!;
  if (type === 'p2pkh') return btc.p2pkh(pub).address!;
  if (type === 'p2sh-p2wpkh') return btc.p2sh(btc.p2wpkh(pub)).address!;
  return btc.p2tr(pub.subarray(1)).address!;
};

/** A PSBT as a dapp builds it: previous outputs only, no key origins. */
function buildPsbt(accounts: BitcoinAccount[]): { psbt: Uint8Array; prevouts: { script: Uint8Array; amount: bigint }[] } {
  const tx = new btc.Transaction();
  const prevouts = accounts.map((a, i) => ({ script: btc.OutScript.encode(btc.Address(btc.NETWORK).decode(a.address)), amount: 100_000n + BigInt(i) }));
  prevouts.forEach((witnessUtxo, i) => tx.addInput({ txid: String(i + 1).repeat(64).slice(0, 64), index: i, witnessUtxo }));
  tx.addOutputAddress(addressAt("m/84'/0'/0'/0/5", 'p2wpkh'), 90_000n);
  return { psbt: tx.toPSBT(), prevouts };
}

/** Independently checks each input's signature against its sighash. */
function verifySignatures(psbt: Uint8Array, prevouts: { script: Uint8Array; amount: bigint }[]) {
  const tx = btc.Transaction.fromPSBT(psbt);
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const { script, amount } = prevouts[i]!;
    if (script[0] === 0x51) {
      const hash = tx.preimageWitnessV1(i, prevouts.map((p) => p.script), btc.SigHash.DEFAULT, prevouts.map((p) => p.amount));
      expect(schnorr.verify(input.tapKeySig!, hash, script.subarray(2))).toBe(true);
    } else {
      const [publicKey, sig] = input.partialSig![0]!;
      const hash = tx.preimageWitnessV0(i, btc.p2pkh(publicKey).script, btc.SigHash.ALL, amount);
      expect(secp256k1.verify(sig.subarray(0, -1), hash, publicKey)).toBe(true);
    }
  }
}

describe('Bitcoin accounts', () => {
  const expected = [
    ["m/44'/0'/0'/0/0", 'p2pkh'],
    ["m/49'/0'/0'/0/0", 'p2sh-p2wpkh'],
    ["m/84'/0'/0'/0/0", 'p2wpkh'],
    ["m/86'/0'/0'/0/0", 'p2tr'],
  ] as const;

  it('derives BIP44/49/84/86 addresses from a Keystone crypto-account export', () => {
    const accounts = deriveBitcoinAccounts(decodeAccountExport(device.bitcoinAccountExport()));
    expect(accounts.map((a) => [a.path, a.addressType, a.address])).toEqual(expected.map(([p, t]) => [p, t, addressAt(p, t)]));
    expect(accounts[0]!.sourceFingerprint).toBe(device.fingerprint);
  });

  it('reads Coldcard-style JSON exports (BBQr, Bitcoin-only firmware) identically', () => {
    const fromJson = deriveBitcoinAccounts(parseBitcoinJsonExport(device.bitcoinJsonExport()));
    expect(fromJson).toEqual(deriveBitcoinAccounts(decodeAccountExport(device.bitcoinAccountExport())));
  });

  it('derives testnet accounts from coin type 1', () => {
    const accounts = deriveBitcoinAccounts(decodeAccountExport(device.bitcoinAccountExport(1)), 'testnet');
    expect(accounts.find((a) => a.addressType === 'p2wpkh')!.address).toMatch(/^tb1q/);
    expect(deriveBitcoinAccounts(decodeAccountExport(device.bitcoinAccountExport(1)), 'mainnet')).toEqual([]);
  });
});

describe('CatCardBitcoinWallet', () => {
  let bridge: SimulatedBridge;
  let wallet: CatCardBitcoinWallet;
  const broadcasts: { url: string; body: string }[] = [];

  const makeWallet = (options: Partial<ConstructorParameters<typeof CatCardBitcoinWallet>[0]> = {}) =>
    new CatCardBitcoinWallet({
      bridge,
      storage: memoryStorage(),
      origin: 'test-dapp',
      rpc: { mainnet: 'https://esplora.test/api' },
      fetch: (async (url: string, init: RequestInit) => {
        broadcasts.push({ url, body: init.body as string });
        return new Response('ab'.repeat(32));
      }) as typeof fetch,
      ...options,
    });

  beforeEach(() => {
    broadcasts.length = 0;
    device.signWithWrongKey = false;
    device.finalizeBitcoin = false;
    bridge = new SimulatedBridge(device);
    bridge.scanOnly = () => device.bitcoinAccountExport();
    wallet = makeWallet();
  });

  const connect = async () => (await (wallet.features['bitcoin:connect'] as any).connect({ purposes: ['payment', 'ordinals'] })).accounts;

  it('connects with payment (native SegWit) and ordinals (Taproot) accounts', async () => {
    const accounts = await connect();
    expect(accounts.map((a: any) => a.address)).toEqual([addressAt("m/84'/0'/0'/0/0", 'p2wpkh'), addressAt("m/86'/0'/0'/0/0", 'p2tr')]);
    expect(accounts[1].publicKey).toHaveLength(32);
    expect(wallet.chains).toEqual(['bitcoin:mainnet']);
  });

  it('connects from a JSON export shown over BBQr', async () => {
    bridge.scanOnly = () => createBBQrSequence(utf8Encode(JSON.stringify(device.bitcoinJsonExport())), 'J');
    expect((await connect()).map((a: any) => a.address)).toHaveLength(2);
  });

  it('signs SegWit and Taproot inputs over BBQr, adding key origins for the device', async () => {
    const [payment, ordinals] = await connect();
    const { psbt, prevouts } = buildPsbt([wallet.accountFor('payment')!, wallet.accountFor('ordinals')!]);
    const [out] = await (wallet.features['bitcoin:signTransaction'] as any).signTransaction({
      psbt,
      inputsToSign: [
        { account: payment, signingIndexes: [0] },
        { account: ordinals, signingIndexes: [1] },
      ],
    });
    verifySignatures(out.signedPsbt, prevouts);

    const sent = btc.Transaction.fromPSBT(device.psbtRequests[device.psbtRequests.length - 1]!);
    expect(sent.getInput(0).bip32Derivation![0]![1]).toEqual({ fingerprint: device.fingerprint, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] });
    expect(sent.getInput(1).tapInternalKey).toBeDefined();
  });

  it('uses BC-UR crypto-psbt when asked', async () => {
    wallet = makeWallet({ format: 'ur' });
    await connect();
    const { psbt, prevouts } = buildPsbt([wallet.accountFor('payment')!]);
    verifySignatures(await wallet.signPsbt(psbt), prevouts);
    expect(device.requests[device.requests.length - 1]!.type).toBe('crypto-psbt');
  });

  it('accepts a finalized transaction from the device, and broadcasts via Esplora', async () => {
    device.finalizeBitcoin = true;
    const [payment] = await connect();
    const { psbt } = buildPsbt([wallet.accountFor('payment')!]);
    const [out] = await (wallet.features['bitcoin:signAndSendTransaction'] as any).signAndSendTransaction({
      psbt,
      chain: 'bitcoin:mainnet',
      inputsToSign: [{ account: payment, signingIndexes: [0] }],
    });
    expect(out.txId).toBe('ab'.repeat(32));
    expect(broadcasts[0]!.url).toBe('https://esplora.test/api/tx');
    expect(btc.Transaction.fromRaw(Buffer.from(broadcasts[0]!.body, 'hex')).isFinal).toBe(true);
  });

  it('rejects when the device did not sign', async () => {
    await connect();
    device.signWithWrongKey = true;
    const { psbt } = buildPsbt([wallet.accountFor('payment')!]);
    await expect(wallet.signPsbt(psbt)).rejects.toThrow(/did not sign input 0/);
  });

  it('signs messages (BIP-137) with SegWit accounts only', async () => {
    const [payment, ordinals] = await connect();
    const message = utf8Encode('hello CatCard');
    const [out] = await (wallet.features['bitcoin:signMessage'] as any).signMessage({ account: payment, message });
    expect(out.signature[0]).toBeGreaterThanOrEqual(39);
    const recovered = secp256k1.Signature.fromCompact(out.signature.subarray(1)).addRecoveryBit(out.signature[0] - 39).recoverPublicKey(hashBitcoinMessage(message));
    expect(Buffer.from(recovered.toRawBytes(true))).toEqual(Buffer.from(payment.publicKey));
    await expect((wallet.features['bitcoin:signMessage'] as any).signMessage({ account: ordinals, message })).rejects.toThrow(/BIP-322/);

    const btcOnly = makeWallet({ firmware: 'bitcoin-only' });
    await (btcOnly.features['bitcoin:connect'] as any).connect({ purposes: ['payment'] });
    await expect(btcOnly.signMessage(message, payment.address)).rejects.toThrow(/multi-chain/);
  });

  describe('sats-connect provider', () => {
    it('implements getInfo, getAddresses, signPsbt (with broadcast) and signMessage', async () => {
      const provider = wallet.provider;
      expect((await provider.request('getInfo', null)).result).toMatchObject({ version: '1.0.0', methods: expect.arrayContaining(['signPsbt']) });

      const { result } = (await provider.request('getAddresses', { purposes: ['payment', 'ordinals'] })) as any;
      expect(result.addresses).toEqual([
        expect.objectContaining({ purpose: 'payment', addressType: 'p2wpkh', walletType: 'keystone' }),
        expect.objectContaining({ purpose: 'ordinals', addressType: 'p2tr' }),
      ]);
      expect(result.addresses[1].publicKey).toHaveLength(64);
      expect(result.network.bitcoin.name).toBe('Mainnet');

      const { psbt, prevouts } = buildPsbt([wallet.accountFor('payment')!, wallet.accountFor('ordinals')!]);
      const signed = (await provider.request('signPsbt', {
        psbt: base64.encode(psbt),
        signInputs: { [result.addresses[0].address]: [0], [result.addresses[1].address]: [1] },
        broadcast: true,
      })) as any;
      verifySignatures(base64.decode(signed.result.psbt), prevouts);
      expect(signed.result.txid).toBe('ab'.repeat(32));

      const msg = (await provider.request('signMessage', { address: result.addresses[0].address, message: 'hi' })) as any;
      expect(msg.result).toMatchObject({ protocol: 'ECDSA', address: result.addresses[0].address });
      expect(base64.decode(msg.result.signature)).toHaveLength(65);
    });

    it('returns JSON-RPC errors', async () => {
      const provider = wallet.provider;
      expect((await provider.request('stx_getAddresses', {})).error).toMatchObject({ code: -32601 });
      bridge.exchange = async () => {
        throw new UserRejectedError();
      };
      expect((await provider.request('getAddresses', { purposes: ['payment'] })).error).toMatchObject({ code: -32000 });
    });
  });
});

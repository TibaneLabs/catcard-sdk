import { ed25519 } from '@noble/curves/ed25519';
import {
  address,
  AccountRole,
  appendTransactionMessageInstruction,
  blockhash as kitBlockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { base58 } from '@scure/base';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SolanaSignAndSendTransaction, SolanaSignMessage, SolanaSignTransaction } from '@solana/wallet-standard-features';
import { StandardConnect, StandardEvents } from '@wallet-standard/features';
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeAccountExport, decodeSolSignRequest, SolSignType } from '../src/registry';
import { CatCardSolanaWallet, deriveSolanaAccounts, parseSolanaTransaction } from '../src/solana';
import { memoryStorage } from '../src/storage';
import { SimulatedBridge, SimulatedCatCard } from './helpers/device';

const device = new SimulatedCatCard();
const blockhash = base58.encode(new Uint8Array(32).fill(9));
const owner = () => new PublicKey(device.solanaPublicKey(0));

function legacyTransfer(feePayer: PublicKey): Uint8Array {
  const tx = new Transaction({ feePayer, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({ fromPubkey: owner(), toPubkey: Keypair.generate().publicKey, lamports: 1000 }),
  );
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

function v0Transfer(feePayer: PublicKey): Uint8Array {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: owner(), toPubkey: Keypair.generate().publicKey, lamports: 1000 })],
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}

// Built with @solana/kit: @solana/web3.js does not support v1 (SIMD-0385) transactions.
function v1Transfer(feePayer: PublicKey): Uint8Array {
  const ix = SystemProgram.transfer({ fromPubkey: owner(), toPubkey: Keypair.generate().publicKey, lamports: 1000 });
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(address(feePayer.toBase58()), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: kitBlockhash(blockhash), lastValidBlockHeight: 0n }, m),
    // Two config fields, one of them 8 bytes wide, so the parser has to skip their values.
    (m) => setTransactionMessageConfig({ computeUnitLimit: 1000, priorityFeeLamports: 5000n }, m),
    (m) =>
      appendTransactionMessageInstruction(
        {
          programAddress: address(ix.programId.toBase58()),
          accounts: ix.keys.map((k) => ({
            address: address(k.pubkey.toBase58()),
            role: k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
          })),
          data: new Uint8Array(ix.data),
        },
        m,
      ),
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

/** Decodes a v1 transaction with @solana/kit: its message bytes and its signatures, in signer order. */
function decodeV1(raw: Uint8Array): { message: Uint8Array; signers: string[]; signatures: (Uint8Array | null)[] } {
  const tx = getTransactionDecoder().decode(raw);
  return {
    message: new Uint8Array(tx.messageBytes),
    signers: Object.keys(tx.signatures),
    signatures: Object.values(tx.signatures).map((s) => (s ? new Uint8Array(s) : null)),
  };
}

describe('Solana accounts', () => {
  it('reads Keystone-style crypto-multi-accounts exports', () => {
    const accounts = deriveSolanaAccounts(decodeAccountExport(device.solanaAccountExport(2)));
    expect(accounts.map((a) => a.address)).toEqual([0, 1].map((i) => base58.encode(device.solanaPublicKey(i))));
    expect(accounts[1]).toMatchObject({ path: "m/44'/501'/1'/0'", sourceFingerprint: device.fingerprint });
  });
});

describe('parseSolanaTransaction', () => {
  it('matches @solana/web3.js for legacy and v0 transactions', () => {
    const payer = Keypair.generate().publicKey;
    for (const raw of [legacyTransfer(payer), v0Transfer(payer)]) {
      const parsed = parseSolanaTransaction(raw);
      const ref = VersionedTransaction.deserialize(raw);
      expect(parsed.version).toBe(ref.version);
      expect(parsed.message).toEqual(ref.message.serialize());
      expect(parsed.signers.map((s) => base58.encode(s))).toEqual(
        ref.message.staticAccountKeys.slice(0, ref.message.header.numRequiredSignatures).map((k) => k.toBase58()),
      );
    }
  });

  it('matches @solana/kit for v1 transactions', () => {
    const payer = Keypair.generate().publicKey;
    const raw = v1Transfer(payer);
    const parsed = parseSolanaTransaction(raw);
    const ref = decodeV1(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.message).toEqual(ref.message);
    expect(parsed.signers.map((s) => base58.encode(s))).toEqual(ref.signers);
    expect(parsed.signers.map((s) => base58.encode(s))).toEqual([payer.toBase58(), owner().toBase58()]);
    expect(parsed.signatureOffsets).toEqual([raw.length - 128, raw.length - 64]);
  });

  it('rejects truncated or padded v1 transactions', () => {
    const raw = v1Transfer(owner());
    expect(() => parseSolanaTransaction(raw.subarray(0, raw.length - 1))).toThrow(/Truncated/);
    expect(() => parseSolanaTransaction(raw.subarray(0, 30))).toThrow(/Truncated/);
    const padded = new Uint8Array(raw.length + 1);
    padded.set(raw);
    expect(() => parseSolanaTransaction(padded)).toThrow(/Trailing data/);
  });
});

describe('CatCardSolanaWallet', () => {
  let bridge: SimulatedBridge;
  let wallet: CatCardSolanaWallet;
  const sent: unknown[] = [];

  beforeEach(() => {
    sent.length = 0;
    device.signWithWrongKey = false;
    bridge = new SimulatedBridge(device);
    bridge.scanOnly = () => device.solanaAccountExport(2);
    wallet = new CatCardSolanaWallet({
      bridge,
      storage: memoryStorage(),
      origin: 'test-dapp',
      rpc: { 'solana:devnet': 'https://rpc.test' },
      fetch: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        sent.push({ url, body });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: base58.encode(new Uint8Array(64).fill(1)) }));
      }) as typeof fetch,
    });
  });

  const connect = async () => (await wallet.features[StandardConnect].connect()).accounts;

  it('connects via account export and emits change events', async () => {
    const changes: unknown[] = [];
    wallet.features[StandardEvents].on('change', (e) => changes.push(e));
    expect((await wallet.features[StandardConnect].connect({ silent: true })).accounts).toEqual([]);
    const accounts = await connect();
    expect(accounts.map((a) => a.address)).toEqual([owner().toBase58(), base58.encode(device.solanaPublicKey(1))]);
    expect(accounts[0]!.features).toContain(SolanaSignTransaction);
    expect(changes).toHaveLength(1);
  });

  it('signs legacy and v0 transactions as the fee payer or a co-signer', async () => {
    const [account] = await connect();
    const other = Keypair.generate();
    for (const build of [legacyTransfer, v0Transfer]) {
      // Sole signer (fee payer). The input must not be modified in place.
      const unsigned = build(owner());
      const before = new Uint8Array(unsigned);
      const [signed] = await wallet.features[SolanaSignTransaction].signTransaction({
        account: account!,
        transaction: unsigned,
      });
      expect(new Uint8Array(unsigned)).toEqual(before);
      const tx = VersionedTransaction.deserialize(signed!.signedTransaction);
      expect(ed25519.verify(tx.signatures[0]!, tx.message.serialize(), owner().toBytes())).toBe(true);

      // Co-signer: our signature goes into the second slot, the fee payer's is untouched.
      const [cosigned] = await wallet.features[SolanaSignTransaction].signTransaction({
        account: account!,
        transaction: build(other.publicKey),
      });
      const tx2 = VersionedTransaction.deserialize(cosigned!.signedTransaction);
      expect(tx2.signatures[0]).toEqual(new Uint8Array(64));
      expect(ed25519.verify(tx2.signatures[1]!, tx2.message.serialize(), owner().toBytes())).toBe(true);
    }
    const request = decodeSolSignRequest(device.requests[device.requests.length - 1]!);
    expect(request).toMatchObject({ signType: SolSignType.Transaction, origin: 'test-dapp' });
    expect(request.derivationPath.toString()).toBe("m/44'/501'/0'/0'");
  });

  it('signs v1 transactions as the fee payer or a co-signer', async () => {
    const [account] = await connect();
    const { supportedTransactionVersions } = wallet.features[SolanaSignTransaction];
    expect(supportedTransactionVersions).toContain(1);

    const unsigned = v1Transfer(owner());
    const before = new Uint8Array(unsigned);
    const [signed] = await wallet.features[SolanaSignTransaction].signTransaction({ account: account!, transaction: unsigned });
    expect(new Uint8Array(unsigned)).toEqual(before);
    const tx = decodeV1(signed!.signedTransaction);
    expect(ed25519.verify(tx.signatures[0]!, tx.message, owner().toBytes())).toBe(true);
    expect(decodeSolSignRequest(device.requests[device.requests.length - 1]!).signData).toEqual(tx.message);

    const [cosigned] = await wallet.features[SolanaSignTransaction].signTransaction({
      account: account!,
      transaction: v1Transfer(Keypair.generate().publicKey),
    });
    const tx2 = decodeV1(cosigned!.signedTransaction);
    expect(tx2.signatures[0]).toBeNull();
    expect(ed25519.verify(tx2.signatures[1]!, tx2.message, owner().toBytes())).toBe(true);
  });

  it('signs and sends v1 transactions, returning the fee payer signature', async () => {
    const [account] = await connect();
    const [out] = await wallet.features[SolanaSignAndSendTransaction].signAndSendTransaction({
      account: account!,
      chain: 'solana:devnet',
      transaction: v1Transfer(owner()),
    });
    const call = sent[0] as { body: { params: [string] } };
    const tx = decodeV1(Buffer.from(call.body.params[0], 'base64'));
    expect(out!.signature).toEqual(tx.signatures[0]);
  });

  it('signs and sends through the configured RPC', async () => {
    const [account] = await connect();
    const [out] = await wallet.features[SolanaSignAndSendTransaction].signAndSendTransaction({
      account: account!,
      chain: 'solana:devnet',
      transaction: legacyTransfer(owner()),
      options: { skipPreflight: true },
    });
    const call = sent[0] as { url: string; body: { method: string; params: [string, { skipPreflight: boolean }] } };
    expect(call.url).toBe('https://rpc.test');
    expect(call.body.method).toBe('sendTransaction');
    expect(call.body.params[1].skipPreflight).toBe(true);
    const tx = VersionedTransaction.deserialize(Buffer.from(call.body.params[0], 'base64'));
    expect(out!.signature).toEqual(new Uint8Array(tx.signatures[0]!));
  });

  it('signs messages', async () => {
    const [account] = await connect();
    const message = new TextEncoder().encode('Sign in to test-dapp');
    const [out] = await wallet.features[SolanaSignMessage].signMessage({ account: account!, message });
    expect(ed25519.verify(out!.signature, message, owner().toBytes())).toBe(true);
    expect(decodeSolSignRequest(device.requests[device.requests.length - 1]!).signType).toBe(SolSignType.Message);
  });

  it('rejects signatures from the wrong key, and non-signer accounts', async () => {
    const [account, second] = await connect();
    device.signWithWrongKey = true;
    await expect(
      wallet.features[SolanaSignMessage].signMessage({ account: account!, message: new Uint8Array([1]) }),
    ).rejects.toThrow(/not made by the selected account/);
    device.signWithWrongKey = false;
    await expect(
      wallet.features[SolanaSignTransaction].signTransaction({ account: second!, transaction: legacyTransfer(owner()) }),
    ).rejects.toThrow(/not a signer/);
  });
});

// A simulated CatCard: answers sign requests coming in as QR frames, like the real device would.
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hashMessage, hashTypedData, keccak256, toHex, type Hex } from 'viem';
import { HDKey } from 'viem/accounts';
import type { CatCardBridge, ExchangeRequest } from '../../src/bridge';
import { CborTag, cborEncode, type CborValue } from '../../src/cbor';
import { QRReceiver } from '../../src/receiver';
import {
  decodeEthSignRequest,
  decodeSolSignRequest,
  decodeTronSignRequest,
  decodeBtcSignRequest,
  encodeBtcSignature,
  encodeTronSignature,
  TronDataType,
  EthDataType,
  encodeEthSignature,
  encodeMultiAccounts,
  encodeSolSignature,
  KeyPath,
  type CryptoHDKey,
} from '../../src/registry';
import { createURSequence, type QRSequence } from '../../src/sequence';
import { encodeCryptoHDKey } from '../../src/registry/hdkey';
import { UR } from '../../src/ur';
import { utf8Decode } from '../../src/util/bytes';
import { hmac } from '@noble/hashes/hmac';
import * as btc from '@scure/btc-signer';
import { hashBitcoinMessage } from '../../src/bitcoin/signer';
import { createBBQrSequence } from '../../src/sequence';
import type { ScanResult } from '../../src/receiver';
import { sha256 } from '@noble/hashes/sha256';
import { hashTronMessage } from '../../src/tron/signer';
import { sha512 } from '@noble/hashes/sha512';

export type VConvention = 'parity' | '27' | 'eip155';

/** SLIP-10 ed25519 derivation (hardened only), as used for Solana. */
function slip10(seed: Uint8Array, path: KeyPath): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  for (const index of path.toIndexes()) {
    const data = new Uint8Array(37);
    data.set(I.subarray(0, 32), 1);
    new DataView(data.buffer).setUint32(33, index);
    I = hmac(sha512, I.subarray(32), data);
  }
  return I.subarray(0, 32);
}

/** Big-endian bytes without leading zeros (at least one byte), as `v` is encoded after r || s. */
function minimalBytes(n: number): number[] {
  const out: number[] = [];
  do {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  return out;
}

export class SimulatedCatCard {
  readonly master: HDKey;
  vConvention: VConvention = 'eip155';
  /** Tamper hook: sign with a different key than requested. */
  signWithWrongKey = false;
  readonly requests: UR[] = [];

  constructor(readonly seed: Uint8Array = new Uint8Array(32).fill(7)) {
    this.master = HDKey.fromMasterSeed(seed);
  }

  get fingerprint(): number {
    return this.master.fingerprint;
  }

  /** `crypto-hdkey` export of the standard EVM account `m/44'/60'/0'`. */
  evmAccountExport(): UR {
    const path = KeyPath.parse("m/44'/60'/0'", this.fingerprint);
    const key = this.master.derive(path.toString());
    const hdkey: CryptoHDKey = {
      key: key.publicKey!,
      chainCode: key.chainCode!,
      origin: path,
      children: KeyPath.parse('0/*'),
      useInfo: { type: 60 },
    };
    return new UR('crypto-hdkey', cborEncode(encodeCryptoHDKey(hdkey)));
  }

  /** `crypto-hdkey` export of the Tron account `m/44'/195'/0'`. */
  tronAccountExport(): UR {
    const path = KeyPath.parse("m/44'/195'/0'", this.fingerprint);
    const key = this.master.derive(path.toString());
    const hdkey: CryptoHDKey = { key: key.publicKey!, chainCode: key.chainCode!, origin: path, children: KeyPath.parse('0/*') };
    return new UR('crypto-hdkey', cborEncode(encodeCryptoHDKey(hdkey)));
  }

  solanaPublicKey(account: number): Uint8Array {
    return ed25519.getPublicKey(slip10(this.seed, KeyPath.parse(`m/44'/501'/${account}'/0'`)));
  }

  /** `crypto-multi-accounts` export of Solana accounts 0..count-1, Keystone style. */
  solanaAccountExport(count = 2): UR {
    const keys: CryptoHDKey[] = [];
    for (let i = 0; i < count; i++) {
      keys.push({ key: this.solanaPublicKey(i), origin: KeyPath.parse(`m/44'/501'/${i}'/0'`, this.fingerprint) });
    }
    return UR.fromValue(encodeMultiAccounts({ masterFingerprint: this.fingerprint, keys, device: 'CatCard' }), 'crypto-multi-accounts');
  }

  /** Reads request frames until complete, as the device camera would. */
  scan(sequence: QRSequence): ScanResult {
    const receiver = new QRReceiver();
    for (let i = 0; !receiver.complete; i++) {
      if (i > 10_000) throw new Error('device could not read request');
      receiver.receive(sequence.nextFrame());
    }
    const result = receiver.result()!;
    if (result.format === 'ur') this.requests.push(result.ur);
    return result;
  }

  respond(request: ScanResult): QRSequence {
    if (request.format === 'bbqr' && request.fileType === 'P') return this.signPsbt(request.data, 'bbqr');
    if (request.format !== 'ur') throw new Error('device cannot handle this QR');
    const ur = request.ur;
    if (ur.type === 'crypto-psbt' || ur.type === 'psbt') return this.signPsbt(ur.toBytes(), 'ur');
    if (ur.type === 'eth-sign-request') return createURSequence(this.signEth(ur));
    if (ur.type === 'sol-sign-request') return createURSequence(this.signSol(ur));
    if (ur.type === 'tron-sign-request') return createURSequence(this.signTron(ur));
    if (ur.type === 'btc-sign-request') return createURSequence(this.signBtcMessage(ur));
    throw new Error(`device cannot handle ${ur.type}`);
  }

  // ---- Bitcoin

  /** Return a finalized transaction (BBQr T) instead of a signed PSBT. */
  finalizeBitcoin = false;
  readonly psbtRequests: Uint8Array[] = [];

  private bitcoinKeys(coinType = 0) {
    return [44, 49, 84, 86].map((purpose) => {
      const path = KeyPath.parse(`m/${purpose}'/${coinType}'/0'`, this.fingerprint);
      return { purpose, path, key: this.master.derive(path.toString()) };
    });
  }

  /** `crypto-account` export (Keystone style) of BIP44/49/84/86 accounts, with script expressions. */
  bitcoinAccountExport(coinType = 0): UR {
    const scripts: Record<number, number[]> = { 44: [403], 49: [400, 404], 84: [404], 86: [409] };
    const outputs = this.bitcoinKeys(coinType).map(({ purpose, path, key }) => {
      const hdkey = encodeCryptoHDKey({ key: key.publicKey!, chainCode: key.chainCode!, origin: path, children: KeyPath.parse('0/*') });
      let output: CborTag = new CborTag(303, hdkey);
      for (const tag of [...scripts[purpose]!].reverse()) output = new CborTag(tag, output);
      return output;
    });
    return UR.fromValue(new Map<number, CborValue>([[1, this.fingerprint], [2, outputs]]), 'crypto-account');
  }

  /** Coldcard-style generic JSON export, as the Bitcoin-only firmware shows over BBQr. */
  bitcoinJsonExport(coinType = 0): Record<string, unknown> {
    const json: Record<string, unknown> = { chain: coinType ? 'XTN' : 'BTC', xfp: this.fingerprint.toString(16).padStart(8, '0').toUpperCase(), account: 0 };
    for (const { purpose, path, key } of this.bitcoinKeys(coinType)) {
      json[`bip${purpose}`] = { deriv: path.toString(), xpub: key.publicExtendedKey };
    }
    return json;
  }

  private signPsbt(psbt: Uint8Array, format: 'bbqr' | 'ur'): QRSequence {
    this.psbtRequests.push(psbt);
    const tx = btc.Transaction.fromPSBT(psbt, { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true });
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      const der = input.bip32Derivation?.[0]?.[1] ?? input.tapBip32Derivation?.[0]?.[1].der;
      if (!der || der.fingerprint !== this.fingerprint) continue;
      let key = this.master;
      for (const index of der.path) key = key.deriveChild(index);
      if (this.signWithWrongKey) continue; // Simulate a device that does not sign.
      tx.signIdx(key.privateKey!, i);
    }
    if (this.finalizeBitcoin) {
      tx.finalize();
      return createBBQrSequence(tx.extract(), 'T');
    }
    const signed = tx.toPSBT();
    return format === 'bbqr' ? createBBQrSequence(signed, 'P') : createURSequence(UR.fromBytes(signed, 'crypto-psbt'));
  }

  private signBtcMessage(ur: UR): UR {
    const req = decodeBtcSignRequest(ur);
    const key = this.master.derive(req.derivationPaths[0]!.toString());
    const sig = secp256k1.sign(hashBitcoinMessage(req.signData), key.privateKey!);
    const signature = new Uint8Array([31 + sig.recovery, ...sig.toCompactRawBytes()]);
    return encodeBtcSignature({ requestId: req.requestId, signature, publicKey: key.publicKey! });
  }

  private signEth(ur: UR): UR {
    const req = decodeEthSignRequest(ur);
    if (req.derivationPath.sourceFingerprint !== this.fingerprint) throw new Error('not my key');
    const path = this.signWithWrongKey ? "m/44'/60'/0'/0/9" : req.derivationPath.toString();
    const privateKey = this.master.derive(path).privateKey!;
    let hash: Hex;
    switch (req.dataType) {
      case EthDataType.Transaction:
      case EthDataType.TypedTransaction:
        hash = keccak256(req.signData);
        break;
      case EthDataType.PersonalMessage:
        hash = hashMessage({ raw: req.signData });
        break;
      case EthDataType.TypedData:
        hash = hashTypedData(JSON.parse(utf8Decode(req.signData)));
        break;
      default:
        throw new Error('unknown data type');
    }
    const sig = secp256k1.sign(hash.slice(2), privateKey);
    const legacyTx = req.dataType === EthDataType.Transaction;
    let v: number;
    if (this.vConvention === 'parity') v = sig.recovery;
    else if (this.vConvention === '27' || !legacyTx || !req.chainId) v = 27 + sig.recovery;
    else v = req.chainId * 2 + 35 + sig.recovery;
    const signature = new Uint8Array([...sig.toCompactRawBytes(), ...minimalBytes(v)]);
    return encodeEthSignature({ requestId: req.requestId, signature, origin: 'CatCard' });
  }

  private signTron(ur: UR): UR {
    const req = decodeTronSignRequest(ur);
    if (req.derivationPath.sourceFingerprint !== this.fingerprint) throw new Error('not my key');
    const path = this.signWithWrongKey ? "m/44'/195'/0'/0/9" : req.derivationPath.toString();
    const hash = req.dataType === TronDataType.Transaction ? sha256(req.signData) : hashTronMessage(req.signData);
    const sig = secp256k1.sign(hash, this.master.derive(path).privateKey!);
    const v = this.vConvention === 'parity' ? sig.recovery : 27 + sig.recovery;
    return encodeTronSignature({ requestId: req.requestId, signature: new Uint8Array([...sig.toCompactRawBytes(), v]) });
  }

  private signSol(ur: UR): UR {
    const req = decodeSolSignRequest(ur);
    if (req.derivationPath.sourceFingerprint !== this.fingerprint) throw new Error('not my key');
    const path = this.signWithWrongKey ? KeyPath.parse("m/44'/501'/9'/0'") : req.derivationPath;
    const signature = ed25519.sign(req.signData, slip10(this.seed, path));
    return encodeSolSignature({ requestId: req.requestId, signature });
  }
}

/**
 * A bridge that plays the user: shows request QRs to the simulated device and scans back
 * its answer (or the given account export for scan-only exchanges).
 */
export class SimulatedBridge implements CatCardBridge {
  exchanges: ExchangeRequest<unknown>[] = [];
  /** What the device shows for scan-only exchanges. */
  scanOnly?: () => UR | QRSequence;

  constructor(readonly device: SimulatedCatCard) {}

  async exchange<T>(request: ExchangeRequest<T>): Promise<T> {
    this.exchanges.push(request as ExchangeRequest<unknown>);
    let frames: QRSequence;
    if (request.request) frames = this.device.respond(this.device.scan(request.request));
    else {
      const shown = this.scanOnly!();
      frames = shown instanceof UR ? createURSequence(shown) : shown;
    }
    const receiver = new QRReceiver();
    while (!receiver.complete) receiver.receive(frames.nextFrame());
    return request.parse(receiver.result()!);
  }
}

export { toHex };

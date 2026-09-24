import { sha256 } from '@noble/hashes/sha256';
import { base64 } from '@scure/base';
import type { BBQrSplitOptions } from '../bbqr';
import type { CatCardBridge } from '../bridge';
import { resolveFormat, type FirmwareVariant, type QRFormat } from '../chains';
import { CatCardError, QRDecodeError } from '../errors';
import { interpretScan } from '../payloads';
import { BtcDataType, decodeBtcSignature, encodeBtcSignRequest } from '../registry/btc';
import { KeyPath } from '../registry/keypath';
import { checkRequestId, randomUUIDBytes } from '../registry/uuid';
import { createBBQrSequence, createURSequence, type URSequenceOptions } from '../sequence';
import { UR } from '../ur';
import { bytesToHex, concatBytes, hexToBytes, utf8Encode } from '../util/bytes';
import { recoverSignature } from '../util/secp';
import type { BitcoinAccount } from './accounts';
import { mergeSignedPsbt, parsePsbtTransaction, preparePsbtForSigning, type InputToSign } from './psbt';

export interface BitcoinSignerOptions {
  /** @default 'multi' */
  firmware?: FirmwareVariant;
  /** QR format for PSBTs. @default 'bbqr' (read by every firmware variant) */
  format?: QRFormat;
  /** UR type for PSBTs, when using BC-UR. @default 'crypto-psbt' */
  urType?: 'crypto-psbt' | 'psbt';
  bbqr?: BBQrSplitOptions;
  qr?: URSequenceOptions;
  /** Name of the requesting app, shown on the device. */
  origin?: string;
}

export interface BitcoinMessageSignature {
  /** 65-byte BIP-137 signature: header || r || s. */
  signature: Uint8Array;
  /** Base64 of `signature`, as `bitcoin-cli verifymessage` and most wallets expect. */
  base64: string;
  /** Hex of the signed message hash. */
  messageHash: string;
}

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, n >> 8]);
  const out = new Uint8Array(5);
  out[0] = 0xfe;
  new DataView(out.buffer).setUint32(1, n, true);
  return out;
}

/** "Bitcoin Signed Message" hash (BIP-137 / Bitcoin Core `signmessage`). */
export function hashBitcoinMessage(message: Uint8Array): Uint8Array {
  const magic = utf8Encode('Bitcoin Signed Message:\n');
  return sha256(sha256(concatBytes([compactSize(magic.length), magic, compactSize(message.length), message])));
}

const BIP137_HEADER_BASE: Record<string, number> = { p2pkh: 31, 'p2sh-p2wpkh': 35, p2wpkh: 39 };

/** Signs PSBTs and messages with a CatCard, over QR codes. */
export class CatCardBitcoinSigner {
  constructor(
    private readonly bridge: CatCardBridge,
    private readonly options: BitcoinSignerOptions = {},
  ) {}

  /**
   * Signs the given inputs of a PSBT on the device and returns the PSBT with their
   * signatures (not finalized, unless the device finalized it).
   */
  async signPsbt(psbt: Uint8Array, inputs: readonly InputToSign[]): Promise<Uint8Array> {
    if (inputs.length === 0) throw new CatCardError('No input to sign');
    const network = inputs[0]!.account.network;
    const prepared = preparePsbtForSigning(psbt, inputs);
    const format = resolveFormat({
      chain: network === 'mainnet' ? 'bitcoin' : 'bitcoin-testnet',
      firmware: this.options.firmware,
      format: this.options.format,
    });
    const request =
      format === 'bbqr'
        ? createBBQrSequence(prepared, 'P', this.options.bbqr)
        : createURSequence(UR.fromBytes(prepared, this.options.urType ?? 'crypto-psbt'), this.options.qr);
    const tx = parsePsbtTransaction(prepared);
    return this.bridge.exchange({
      title: 'Sign Bitcoin transaction',
      description: 'Scan this QR code with your CatCard, review and sign on the device, then scan the result it shows.',
      details: [
        { label: 'Network', value: network },
        { label: 'Inputs to sign', value: `${inputs.length} of ${tx.inputsLength}` },
        { label: 'Outputs', value: String(tx.outputsLength) },
      ],
      request,
      parse: (result) => {
        const payload = interpretScan(result);
        if (payload.kind === 'psbt') return mergeSignedPsbt(prepared, { psbt: payload.psbt }, inputs);
        if (payload.kind === 'transaction') return mergeSignedPsbt(prepared, { transaction: payload.transaction }, inputs);
        throw new QRDecodeError('This is not a signed transaction from CatCard');
      },
    });
  }

  /**
   * Signs a message with the "Bitcoin Signed Message" scheme (BIP-137), for legacy and
   * SegWit accounts. Needs the multi-chain firmware (BC-UR `btc-sign-request`).
   */
  async signMessage(message: Uint8Array, account: BitcoinAccount): Promise<BitcoinMessageSignature> {
    if (this.options.firmware === 'bitcoin-only') {
      throw new CatCardError('Message signing over QR requires the multi-chain CatCard firmware');
    }
    const headerBase = BIP137_HEADER_BASE[account.addressType];
    if (headerBase === undefined) throw new CatCardError('Taproot addresses need BIP-322 message signing, which is not supported');
    const publicKey = hexToBytes(account.publicKey);
    const hash = hashBitcoinMessage(message);
    const requestId = randomUUIDBytes();
    const ur = encodeBtcSignRequest({
      requestId,
      signData: message,
      dataType: BtcDataType.Message,
      derivationPaths: [KeyPath.parse(account.path, account.sourceFingerprint)],
      addresses: [account.address],
      origin: this.options.origin,
    });
    return this.bridge.exchange({
      title: 'Sign message',
      description: 'Scan this QR code with your CatCard, confirm on the device, then scan the signature it shows.',
      details: [{ label: 'Address', value: account.address }],
      request: createURSequence(ur, this.options.qr),
      parse: (result) => {
        if (result.format !== 'ur') throw new QRDecodeError('This is not a CatCard signature QR code');
        const response = decodeBtcSignature(result.ur);
        checkRequestId(requestId, response.requestId);
        // Either BIP-137 (header || r || s) or r || s [|| v].
        const sig = response.signature;
        const rs = sig.length === 65 && sig[0]! >= 27 && sig[0]! <= 42 ? sig.subarray(1) : sig.subarray(0, 64);
        const { r, s, recovery } = recoverSignature(hash, rs, publicKey, 'The signature was not made by this address. Check the account on your CatCard.');
        const signature = new Uint8Array(65);
        signature[0] = headerBase + recovery;
        signature.set(hexToBytes(r.toString(16).padStart(64, '0')), 1);
        signature.set(hexToBytes(s.toString(16).padStart(64, '0')), 33);
        return { signature, base64: base64.encode(signature), messageHash: bytesToHex(hash) };
      },
    });
  }
}

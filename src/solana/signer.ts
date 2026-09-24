import { ed25519 } from '@noble/curves/ed25519';
import type { CatCardBridge, ExchangeDetail } from '../bridge';
import { QRDecodeError } from '../errors';
import { KeyPath } from '../registry/keypath';
import { decodeSolSignature, encodeSolSignRequest, SolSignType } from '../registry/sol';
import { checkRequestId, randomUUIDBytes } from '../registry/uuid';
import { createURSequence, type URSequenceOptions } from '../sequence';
import { solanaPublicKey, type SolanaAccount } from './accounts';
import { addSolanaSignature, parseSolanaTransaction } from './transaction';

export interface SolanaSignerOptions {
  /** Name of the requesting app, shown on the device. */
  origin?: string;
  qr?: URSequenceOptions;
}

/** Signs Solana transactions and messages with a CatCard, over QR codes. */
export class CatCardSolanaSigner {
  private readonly publicKey: Uint8Array;

  constructor(
    readonly account: SolanaAccount,
    private readonly bridge: CatCardBridge,
    private readonly options: SolanaSignerOptions = {},
  ) {
    this.publicKey = solanaPublicKey(account);
  }

  private request(signData: Uint8Array, signType: SolSignType, title: string, details: ExchangeDetail[] = []): Promise<Uint8Array> {
    const requestId = randomUUIDBytes();
    const ur = encodeSolSignRequest({
      requestId,
      signData,
      derivationPath: KeyPath.parse(this.account.path, this.account.sourceFingerprint),
      address: this.publicKey,
      origin: this.options.origin,
      signType,
    });
    return this.bridge.exchange({
      title,
      description: 'Scan this QR code with your CatCard, confirm on the device, then scan the signature it shows.',
      details: [{ label: 'Account', value: this.account.address }, ...details],
      request: createURSequence(ur, this.options.qr),
      parse: (result) => {
        if (result.format !== 'ur') throw new QRDecodeError('This is not a CatCard signature QR code');
        const { requestId: gotId, signature } = decodeSolSignature(result.ur);
        checkRequestId(requestId, gotId);
        if (!ed25519.verify(signature, signData, this.publicKey)) {
          throw new QRDecodeError('The signature was not made by the selected account. Check the account on your CatCard.');
        }
        return signature;
      },
    });
  }

  /** Signs a serialized (wire format) transaction, returning it with this account's signature filled in. */
  async signTransaction(transaction: Uint8Array): Promise<Uint8Array> {
    const parsed = parseSolanaTransaction(transaction);
    const signature = await this.request(parsed.message, SolSignType.Transaction, 'Sign transaction', [
      { label: 'Version', value: String(parsed.version) },
      { label: 'Signers', value: String(parsed.signers.length) },
    ]);
    return addSolanaSignature(transaction, this.publicKey, signature);
  }

  /** Signs arbitrary message bytes, returning the 64-byte ed25519 signature. */
  signMessage(message: Uint8Array): Promise<Uint8Array> {
    return this.request(message, SolSignType.Message, 'Sign message');
  }
}

import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import type { CatCardBridge, ExchangeDetail } from '../bridge';
import { CatCardError, QRDecodeError } from '../errors';
import { KeyPath } from '../registry/keypath';
import { decodeTronSignature, encodeTronSignRequest, TronDataType } from '../registry/tron';
import { checkRequestId, randomUUIDBytes } from '../registry/uuid';
import { createURSequence, type URSequenceOptions } from '../sequence';
import { bytesToHex, concatBytes, hexToBytes, utf8Encode } from '../util/bytes';
import { recoverSignature } from '../util/secp';
import type { TronAccount } from './accounts';

/** A transaction as built by TronWeb (`tronWeb.transactionBuilder.*`). */
export interface TronTransaction {
  txID: string;
  raw_data: { contract?: { type?: string; parameter?: { value?: Record<string, unknown> } }[]; [key: string]: unknown };
  raw_data_hex: string;
  signature?: string[];
  [key: string]: unknown;
}

export interface TronSignerOptions {
  /** Name of the requesting app, shown on the device. */
  origin?: string;
  qr?: URSequenceOptions;
}

/** TIP-191 message hash, as used by TronWeb's `signMessageV2`. */
export function hashTronMessage(message: Uint8Array): Uint8Array {
  return keccak_256(concatBytes([utf8Encode(`\x19TRON Signed Message:\n${message.length}`), message]));
}

function transactionDetails(tx: TronTransaction): ExchangeDetail[] {
  const contract = tx.raw_data.contract?.[0];
  const details: ExchangeDetail[] = [{ label: 'Type', value: contract?.type ?? 'unknown' }];
  const value = contract?.parameter?.value;
  if (typeof value?.to_address === 'string') details.push({ label: 'To', value: value.to_address });
  if (typeof value?.amount === 'number') details.push({ label: 'Amount', value: `${value.amount / 1e6} TRX` });
  details.push({ label: 'Transaction ID', value: tx.txID });
  return details;
}

/** Signs Tron transactions and messages with a CatCard, over QR codes. */
export class CatCardTronSigner {
  private readonly publicKey: Uint8Array;

  constructor(
    readonly account: TronAccount,
    private readonly bridge: CatCardBridge,
    private readonly options: TronSignerOptions = {},
  ) {
    this.publicKey = hexToBytes(account.publicKey);
  }

  /** Returns `r || s || v` with v = 27/28, as TronWeb produces. */
  private request(dataType: TronDataType, signData: Uint8Array, hash: Uint8Array, title: string, details: ExchangeDetail[] = []): Promise<Uint8Array> {
    const requestId = randomUUIDBytes();
    const ur = encodeTronSignRequest({
      requestId,
      signData,
      dataType,
      derivationPath: KeyPath.parse(this.account.path, this.account.sourceFingerprint),
      address: hexToBytes(this.account.hexAddress),
      origin: this.options.origin,
    });
    return this.bridge.exchange({
      title,
      description: 'Scan this QR code with your CatCard, confirm on the device, then scan the signature it shows.',
      details: [{ label: 'Account', value: this.account.address }, ...details],
      request: createURSequence(ur, this.options.qr),
      parse: (result) => {
        if (result.format !== 'ur') throw new QRDecodeError('This is not a CatCard signature QR code');
        const signature = decodeTronSignature(result.ur);
        checkRequestId(requestId, signature.requestId);
        const { r, s, recovery } = recoverSignature(
          hash,
          signature.signature,
          this.publicKey,
          'The signature was not made by the selected account. Check the account on your CatCard.',
        );
        const out = new Uint8Array(65);
        out.set(hexToBytes(r.toString(16).padStart(64, '0')), 0);
        out.set(hexToBytes(s.toString(16).padStart(64, '0')), 32);
        out[64] = 27 + recovery;
        return out;
      },
    });
  }

  /**
   * Signs a TronWeb transaction, returning a copy with the signature appended (as
   * `tronWeb.trx.sign` / `multiSign` do). The transaction ID is checked against its raw data.
   */
  async signTransaction<T extends TronTransaction>(transaction: T): Promise<T & { signature: string[] }> {
    if (typeof transaction?.raw_data_hex !== 'string' || typeof transaction.txID !== 'string') {
      throw new CatCardError('Expected a TronWeb transaction (txID, raw_data, raw_data_hex)');
    }
    const raw = hexToBytes(transaction.raw_data_hex);
    const txID = sha256(raw);
    if (bytesToHex(txID) !== transaction.txID.toLowerCase()) {
      throw new CatCardError('Transaction ID does not match its raw data');
    }
    const signature = await this.request(TronDataType.Transaction, raw, txID, 'Sign transaction', transactionDetails(transaction));
    return { ...transaction, signature: [...(transaction.signature ?? []), bytesToHex(signature)] };
  }

  /** TIP-191 message signature (`signMessageV2`): `0x`-prefixed hex, v = 27/28. Strings are signed as UTF-8. */
  async signMessage(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? utf8Encode(message) : message;
    const signature = await this.request(TronDataType.PersonalMessage, bytes, hashTronMessage(bytes), 'Sign message');
    return `0x${bytesToHex(signature)}`;
  }
}

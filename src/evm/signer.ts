import { secp256k1 } from '@noble/curves/secp256k1';
import {
  formatEther,
  getAddress,
  hashMessage,
  hashTypedData,
  keccak256,
  numberToHex,
  serializeSignature,
  serializeTransaction,
  stringify,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
  type SerializeTransactionFn,
  type SignableMessage,
  type TransactionSerializable,
  type TypedDataDefinition,
} from 'viem';
import { publicKeyToAddress, toAccount } from 'viem/accounts';
import type { CatCardBridge, ExchangeDetail } from '../bridge';
import { CatCardError, QRDecodeError } from '../errors';
import { decodeEthSignature, EthDataType, encodeEthSignRequest } from '../registry/eth';
import { KeyPath } from '../registry/keypath';
import { checkRequestId, randomUUIDBytes } from '../registry/uuid';
import { createURSequence, type URSequenceOptions } from '../sequence';
import { hexToBytes, utf8Encode } from '../util/bytes';
import type { EvmAccount } from './accounts';

export interface EvmSignerOptions {
  /** Name of the requesting app, shown on the device. */
  origin?: string;
  /** QR sequence options for requests sent to the device. */
  qr?: URSequenceOptions;
}

export interface RecoverableSignature {
  r: Hex;
  s: Hex;
  yParity: 0 | 1;
}

const toBytes = (hex: Hex): Uint8Array => hexToBytes(hex.slice(2));

/**
 * Turns the device's `r || s || v` into a signature over `hash` by `expected`, whatever
 * `v` convention the device used (0/1, 27/28 or EIP-155), by recovering the signer.
 * High-s signatures are normalized, as required by Ethereum (EIP-2).
 */
export function recoverEthSignature(hash: Hex, signature: Uint8Array, expected: Address): RecoverableSignature {
  if (signature.length < 64) throw new QRDecodeError('Signature too short');
  let sig;
  try {
    sig = secp256k1.Signature.fromCompact(signature.subarray(0, 64));
  } catch {
    throw new QRDecodeError('Malformed signature');
  }
  const digest = toBytes(hash);
  for (const parity of [0, 1] as const) {
    let address: Address;
    try {
      const publicKey = sig.addRecoveryBit(parity).recoverPublicKey(digest).toRawBytes(false);
      address = getAddress(publicKeyToAddress(toHex(publicKey)));
    } catch {
      continue;
    }
    if (address !== getAddress(expected)) continue;
    const high = sig.hasHighS();
    const s = high ? secp256k1.CURVE.n - sig.s : sig.s;
    return {
      r: numberToHex(sig.r, { size: 32 }),
      s: numberToHex(s, { size: 32 }),
      yParity: (high ? 1 - parity : parity) as 0 | 1,
    };
  }
  throw new QRDecodeError('The signature was not made by the selected account. Check the account on your CatCard.');
}

function transactionDetails(tx: TransactionSerializable): ExchangeDetail[] {
  const details: ExchangeDetail[] = [];
  if (tx.chainId !== undefined) details.push({ label: 'Chain ID', value: String(tx.chainId) });
  details.push({ label: 'To', value: tx.to ?? '(contract creation)' });
  details.push({ label: 'Value', value: formatEther(tx.value ?? 0n) });
  if (tx.data && tx.data !== '0x') details.push({ label: 'Data', value: `${(tx.data.length - 2) / 2} bytes` });
  if (tx.nonce !== undefined) details.push({ label: 'Nonce', value: String(tx.nonce) });
  return details;
}

/** Signs EVM transactions and messages with a CatCard, over QR codes. */
export class CatCardEvmSigner {
  constructor(
    readonly account: EvmAccount,
    private readonly bridge: CatCardBridge,
    private readonly options: EvmSignerOptions = {},
  ) {}

  get address(): Address {
    return this.account.address;
  }

  private request(params: {
    dataType: EthDataType;
    signData: Uint8Array;
    chainId?: number;
    hash: Hex;
    title: string;
    details?: ExchangeDetail[];
  }): Promise<RecoverableSignature> {
    const requestId = randomUUIDBytes();
    const ur = encodeEthSignRequest({
      requestId,
      signData: params.signData,
      dataType: params.dataType,
      chainId: params.chainId,
      derivationPath: KeyPath.parse(this.account.path, this.account.sourceFingerprint),
      address: toBytes(this.account.address),
      origin: this.options.origin,
    });
    return this.bridge.exchange({
      title: params.title,
      description: 'Scan this QR code with your CatCard, confirm on the device, then scan the signature it shows.',
      details: [{ label: 'Account', value: this.account.address }, ...(params.details ?? [])],
      request: createURSequence(ur, this.options.qr),
      parse: (result) => {
        if (result.format !== 'ur') throw new QRDecodeError('This is not a CatCard signature QR code');
        const signature = decodeEthSignature(result.ur);
        checkRequestId(requestId, signature.requestId);
        return recoverEthSignature(params.hash, signature.signature, this.account.address);
      },
    });
  }

  /** Signs a transaction and returns it serialized, ready for `eth_sendRawTransaction`. */
  async signTransaction(
    tx: TransactionSerializable,
    serializer: SerializeTransactionFn<TransactionSerializable> = serializeTransaction,
  ): Promise<Hex> {
    if (tx.chainId === undefined) throw new CatCardError('Transactions must specify a chainId');
    if (tx.type === 'eip4844' || 'blobs' in tx) throw new CatCardError('Blob transactions are not supported');
    const unsigned = serializer(tx) as Hex;
    const signData = toBytes(unsigned);
    // Typed transactions start with their type byte (< 0x80); legacy ones are an RLP list (>= 0xc0).
    const dataType = signData[0]! >= 0xc0 ? EthDataType.Transaction : EthDataType.TypedTransaction;
    const { r, s, yParity } = await this.request({
      dataType,
      signData,
      chainId: tx.chainId,
      hash: keccak256(unsigned),
      title: 'Sign transaction',
      details: transactionDetails(tx),
    });
    return serializer(tx, { r, s, yParity, v: 27n + BigInt(yParity) }) as Hex;
  }

  /** EIP-191 `personal_sign`. Returns a 65-byte signature with v = 27/28. */
  async signMessage(message: SignableMessage): Promise<Hex> {
    let raw: Uint8Array;
    if (typeof message === 'string') raw = utf8Encode(message);
    else if (typeof message.raw === 'string') raw = toBytes(message.raw);
    else raw = message.raw;
    const signature = await this.request({
      dataType: EthDataType.PersonalMessage,
      signData: raw,
      hash: hashMessage(message),
      title: 'Sign message',
    });
    return serializeSignature(signature);
  }

  /** EIP-712 typed data, as an object or its JSON (as passed to `eth_signTypedData_v4`). */
  async signTypedData(typedData: TypedDataDefinition | string): Promise<Hex> {
    const json = typeof typedData === 'string' ? typedData : stringify(typedData);
    const parsed = (typeof typedData === 'string' ? JSON.parse(typedData) : typedData) as TypedDataDefinition;
    const chainId = parsed.domain?.chainId;
    const signature = await this.request({
      dataType: EthDataType.TypedData,
      signData: utf8Encode(json),
      chainId: chainId === undefined ? undefined : Number(chainId),
      hash: hashTypedData(parsed),
      title: 'Sign typed data',
      details: parsed.primaryType ? [{ label: 'Type', value: String(parsed.primaryType) }] : [],
    });
    return serializeSignature(signature);
  }

  /** A viem account backed by this signer, for use with `createWalletClient({ account })`. */
  toViemAccount(): LocalAccount {
    return toAccount({
      address: this.account.address,
      signMessage: ({ message }) => this.signMessage(message),
      signTransaction: (tx, options) =>
        this.signTransaction(tx, options?.serializer as SerializeTransactionFn<TransactionSerializable> | undefined),
      signTypedData: (typedData) => this.signTypedData(typedData as TypedDataDefinition),
    });
  }
}

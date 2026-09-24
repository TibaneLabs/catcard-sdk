import * as btc from '@scure/btc-signer';
import { CatCardError, QRDecodeError } from '../errors';
import { KeyPath } from '../registry/keypath';
import { bytesToHex, equalBytes, hexToBytes } from '../util/bytes';
import { bitcoinPayment, type BitcoinAccount } from './accounts';

const TX_OPTS: NonNullable<Parameters<typeof btc.Transaction.fromPSBT>[1]> = { allowUnknownInputs: true, allowUnknownOutputs: true, allowUnknown: true, disableScriptCheck: true };

export type BitcoinSigHashFlag = 'ALL' | 'NONE' | 'SINGLE' | 'ALL|ANYONECANPAY' | 'NONE|ANYONECANPAY' | 'SINGLE|ANYONECANPAY';

const SIGHASH: Record<BitcoinSigHashFlag, number> = {
  ALL: btc.SigHash.ALL,
  NONE: btc.SigHash.NONE,
  SINGLE: btc.SigHash.SINGLE,
  'ALL|ANYONECANPAY': btc.SigHash.ALL_ANYONECANPAY,
  'NONE|ANYONECANPAY': btc.SigHash.NONE_ANYONECANPAY,
  'SINGLE|ANYONECANPAY': btc.SigHash.SINGLE_ANYONECANPAY,
};

export interface InputToSign {
  index: number;
  account: BitcoinAccount;
  sigHash?: BitcoinSigHashFlag;
}

export function parsePsbtTransaction(psbt: Uint8Array): btc.Transaction {
  try {
    return btc.Transaction.fromPSBT(psbt, TX_OPTS);
  } catch (e) {
    throw new CatCardError(`Invalid PSBT: ${(e as Error).message}`);
  }
}

function prevOutScript(tx: btc.Transaction, index: number): Uint8Array | undefined {
  const input = tx.getInput(index);
  if (input.witnessUtxo) return input.witnessUtxo.script;
  if (input.nonWitnessUtxo && input.index !== undefined) return input.nonWitnessUtxo.outputs[input.index]?.script;
  return undefined;
}

/** Inputs spending from any of `accounts`' addresses. */
export function findOwnInputs(psbt: Uint8Array, accounts: readonly BitcoinAccount[]): InputToSign[] {
  const tx = parsePsbtTransaction(psbt);
  const scripts = accounts.map((account) => ({ account, script: bitcoinPayment(hexToBytes(account.publicKey), account.addressType, account.network).script }));
  const out: InputToSign[] = [];
  for (let index = 0; index < tx.inputsLength; index++) {
    const script = prevOutScript(tx, index);
    const match = script && scripts.find((s) => equalBytes(s.script, script));
    if (match) out.push({ index, account: match.account });
  }
  return out;
}

/**
 * Adds what a hardware wallet needs to sign the given inputs: key origins (BIP32 derivation),
 * redeem scripts for nested SegWit, the internal key for Taproot, and sighash types.
 * Dapps usually build PSBTs with only the previous outputs.
 */
export function preparePsbtForSigning(psbt: Uint8Array, inputs: readonly InputToSign[]): Uint8Array {
  const tx = parsePsbtTransaction(psbt);
  for (const { index, account, sigHash } of inputs) {
    if (index < 0 || index >= tx.inputsLength) throw new CatCardError(`PSBT has no input ${index}`);
    const publicKey = hexToBytes(account.publicKey);
    const payment = bitcoinPayment(publicKey, account.addressType, account.network);
    const script = prevOutScript(tx, index);
    if (!script) throw new CatCardError(`PSBT input ${index} is missing its previous output (witnessUtxo)`);
    if (!equalBytes(script, payment.script)) throw new CatCardError(`PSBT input ${index} does not belong to ${account.address}`);

    const path = KeyPath.parse(account.path).toIndexes();
    const fingerprint = account.sourceFingerprint ?? 0;
    const update: Parameters<btc.Transaction['updateInput']>[1] = {};
    if (account.addressType === 'p2tr') {
      const xOnly = publicKey.subarray(1);
      update.tapInternalKey = xOnly;
      update.tapBip32Derivation = [[xOnly, { hashes: [], der: { fingerprint, path } }]];
    } else {
      update.bip32Derivation = [[publicKey, { fingerprint, path }]];
      if (payment.redeemScript) update.redeemScript = payment.redeemScript;
    }
    if (sigHash && sigHash !== 'ALL') update.sighashType = SIGHASH[sigHash];
    tx.updateInput(index, update, true);
  }
  return tx.toPSBT();
}

function isSignedBy(tx: btc.Transaction, index: number, account: BitcoinAccount): boolean {
  const input = tx.getInput(index);
  if (input.finalScriptWitness?.length || input.finalScriptSig?.length) return true;
  if (account.addressType === 'p2tr') return !!input.tapKeySig;
  const publicKey = hexToBytes(account.publicKey);
  return !!input.partialSig?.some(([pk]) => equalBytes(pk, publicKey));
}

/**
 * Merges what the device returned (a signed PSBT, or a finalized transaction) into the
 * original PSBT, checking it is the same transaction and that every requested input is signed.
 */
export function mergeSignedPsbt(original: Uint8Array, response: { psbt: Uint8Array } | { transaction: Uint8Array }, inputs: readonly InputToSign[]): Uint8Array {
  const tx = parsePsbtTransaction(original);
  if ('psbt' in response) {
    try {
      tx.combine(parsePsbtTransaction(response.psbt));
    } catch (e) {
      throw new QRDecodeError(`The signed PSBT does not match this transaction (${(e as Error).message})`);
    }
  } else {
    let signed: btc.Transaction;
    try {
      signed = btc.Transaction.fromRaw(response.transaction, TX_OPTS);
    } catch {
      throw new QRDecodeError('Invalid signed transaction');
    }
    if (!equalBytes(signed.unsignedTx, tx.unsignedTx)) throw new QRDecodeError('The signed transaction does not match this PSBT');
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = signed.getInput(i);
      tx.updateInput(i, { finalScriptSig: input.finalScriptSig, finalScriptWitness: input.finalScriptWitness }, true);
    }
  }
  for (const { index, account } of inputs) {
    if (!isSignedBy(tx, index, account)) throw new QRDecodeError(`The CatCard did not sign input ${index}`);
  }
  return tx.toPSBT();
}

/** Finalizes a fully signed PSBT, returning the raw transaction and its ID. */
export function finalizePsbt(psbt: Uint8Array): { transaction: Uint8Array; hex: string; txid: string } {
  const tx = parsePsbtTransaction(psbt);
  try {
    // Inputs may already be final (e.g. when the device returned a finalized transaction).
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (!input.finalScriptWitness?.length && !input.finalScriptSig?.length) tx.finalizeIdx(i);
    }
  } catch (e) {
    throw new CatCardError(`Cannot finalize the transaction: ${(e as Error).message}`);
  }
  const transaction = tx.extract();
  return { transaction, hex: bytesToHex(transaction), txid: tx.id };
}

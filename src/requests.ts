// App -> device: encode data for the CatCard to scan.

import type { BBQrSplitOptions } from './bbqr';
import { resolveFormat, type FormatSelection } from './chains';
import { parsePsbt } from './psbt';
import { createBBQrSequence, createURSequence, type QRSequence, type URSequenceOptions } from './sequence';
import { UR } from './ur';

export interface EncodeOptions extends FormatSelection {
  /** Options used when the resolved format is BBQr. */
  bbqr?: BBQrSplitOptions;
  /** Options used when the resolved format is BC-UR. */
  ur?: URSequenceOptions;
}

export interface EncodePsbtOptions extends EncodeOptions {
  /**
   * UR type used for PSBTs. `crypto-psbt` is the most widely supported;
   * `psbt` is the newer name from the BC-UR registry.
   * @default 'crypto-psbt'
   */
  urType?: 'crypto-psbt' | 'psbt';
}

/**
 * Encodes an unsigned PSBT for signing on the device.
 *
 * Bitcoin defaults to BBQr (the only format understood by the Bitcoin-only
 * firmware); other UTXO chains default to BC-UR.
 *
 * @param psbt Raw bytes, base64 or hex.
 */
export function encodePsbt(psbt: Uint8Array | string, options: EncodePsbtOptions = {}): QRSequence {
  const data = parsePsbt(psbt);
  if (resolveFormat(options) === 'bbqr') return createBBQrSequence(data, 'P', options.bbqr);
  return createURSequence(UR.fromBytes(data, options.urType ?? 'crypto-psbt'), options.ur);
}

/**
 * Encodes an arbitrary UR (e.g. a chain-specific sign request) for the device.
 * Requires the multi-chain firmware.
 */
export function encodeUR(ur: UR, options: URSequenceOptions = {}): QRSequence {
  return createURSequence(ur, options);
}

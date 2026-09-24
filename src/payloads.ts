// Device -> app: interpret what was scanned from the CatCard screen.

import { cborDecode, type CborValue } from './cbor';
import { isPsbt } from './psbt';
import type { ScanResult } from './receiver';
import type { UR } from './ur';
import { utf8Decode } from './util/bytes';

export type DevicePayload =
  /** A PSBT, typically signed by the device and ready to finalize/broadcast. */
  | { kind: 'psbt'; psbt: Uint8Array }
  /** A finalized, serialized transaction ready to broadcast. */
  | { kind: 'transaction'; transaction: Uint8Array }
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'cbor'; value: CborValue }
  | { kind: 'binary'; data: Uint8Array }
  /** A UR of a type this SDK does not interpret itself (account exports, chain-specific signatures...). */
  | { kind: 'ur'; ur: UR };

const PSBT_UR_TYPES = new Set(['crypto-psbt', 'psbt']);

/** Classifies a completed scan into a typed payload. */
export function interpretScan(result: ScanResult): DevicePayload {
  switch (result.format) {
    case 'text':
      return { kind: 'text', text: result.text };
    case 'ur': {
      const { ur } = result;
      if (PSBT_UR_TYPES.has(ur.type)) return { kind: 'psbt', psbt: ur.toBytes() };
      if (ur.type === 'bytes') return { kind: 'binary', data: ur.toBytes() };
      return { kind: 'ur', ur };
    }
    case 'bbqr': {
      const { data, fileType } = result;
      switch (fileType) {
        case 'P':
          return { kind: 'psbt', psbt: data };
        case 'T':
          return { kind: 'transaction', transaction: data };
        case 'J':
          return { kind: 'json', value: JSON.parse(utf8Decode(data)) };
        case 'U':
          return { kind: 'text', text: utf8Decode(data) };
        case 'C':
          return { kind: 'cbor', value: cborDecode(data) };
        default:
          return isPsbt(data) ? { kind: 'psbt', psbt: data } : { kind: 'binary', data };
      }
    }
  }
}

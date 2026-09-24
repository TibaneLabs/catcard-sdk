import { BBQR_HEADER_LENGTH, decodeBBQrBodies, isBBQrPart, parseBBQrHeader, type BBQrEncoding, type BBQrPartHeader } from './bbqr';
import type { QRFormat } from './chains';
import { QRDecodeError } from './errors';
import { isURPart, URDecoder, type UR, type URDecoderOptions } from './ur';

export type ScanResult =
  | { format: 'bbqr'; fileType: string; encoding: BBQrEncoding; data: Uint8Array }
  | { format: 'ur'; ur: UR }
  /** A plain, non-BBQr/UR QR code (e.g. an address). */
  | { format: 'text'; text: string };

export interface ScanProgress {
  /** Format of the sequence being received, once known. */
  format?: QRFormat | 'text';
  /** False when the frame was ignored (duplicate, or unrelated to the sequence in progress). */
  accepted: boolean;
  complete: boolean;
  /** Estimated completion in [0, 1]. */
  progress: number;
  /** Distinct frames (BBQr) or recovered fragments (UR) so far. */
  received: number;
  /** Frames or fragments needed, once known. */
  expected: number;
}

export type QRReceiverOptions = URDecoderOptions;

/**
 * Collects scanned QR frames (BBQr, BC-UR, or plain text) until a complete payload
 * is available. Frames can arrive in any order and repeat.
 *
 * @example
 * const receiver = new QRReceiver();
 * scanner.onDecode = (text) => {
 *   const status = receiver.receive(text);
 *   showProgress(status.progress);
 *   if (status.complete) handle(interpretScan(receiver.result()!));
 * };
 */
export class QRReceiver {
  private format?: QRFormat | 'text';
  private bbqr?: { header: BBQrPartHeader; bodies: Map<number, string> };
  private ur?: URDecoder;
  private scanResult?: ScanResult;

  constructor(private readonly options: QRReceiverOptions = {}) {}

  get complete(): boolean {
    return this.scanResult !== undefined;
  }

  result(): ScanResult | undefined {
    return this.scanResult;
  }

  reset(): void {
    this.format = undefined;
    this.bbqr = undefined;
    this.ur = undefined;
    this.scanResult = undefined;
  }

  /**
   * Feeds one scanned QR payload.
   *
   * Frames of a different format than the sequence in progress are ignored (`accepted: false`).
   * Throws {@link QRDecodeError} for corrupt frames or frames from a different sequence of the
   * same format; call {@link reset} to start over.
   */
  receive(text: string): ScanProgress {
    if (this.scanResult) return this.status(false);
    const format = isBBQrPart(text) ? 'bbqr' : isURPart(text) ? 'ur' : 'text';
    if (this.format && format !== this.format) return this.status(false);
    this.format = format;
    let accepted: boolean;
    if (format === 'bbqr') accepted = this.receiveBBQr(text);
    else if (format === 'ur') accepted = this.receiveUR(text);
    else {
      this.scanResult = { format: 'text', text };
      accepted = true;
    }
    return this.status(accepted);
  }

  private receiveBBQr(text: string): boolean {
    const header = parseBBQrHeader(text);
    const body = text.slice(BBQR_HEADER_LENGTH);
    if (!this.bbqr) this.bbqr = { header, bodies: new Map() };
    const current = this.bbqr.header;
    if (header.encoding !== current.encoding || header.fileType !== current.fileType || header.total !== current.total) {
      throw new QRDecodeError('BBQr frame belongs to a different sequence');
    }
    const existing = this.bbqr.bodies.get(header.index);
    if (existing !== undefined) {
      if (existing !== body) throw new QRDecodeError(`BBQr part ${header.index} received twice with different content`);
      return false;
    }
    this.bbqr.bodies.set(header.index, body);
    if (this.bbqr.bodies.size === current.total) {
      const ordered = Array.from({ length: current.total }, (_, i) => this.bbqr!.bodies.get(i)!);
      this.scanResult = {
        format: 'bbqr',
        fileType: current.fileType,
        encoding: current.encoding,
        data: decodeBBQrBodies(ordered, current.encoding),
      };
    }
    return true;
  }

  private receiveUR(text: string): boolean {
    this.ur ??= new URDecoder(this.options);
    const accepted = this.ur.receivePart(text);
    const ur = this.ur.result();
    if (ur) this.scanResult = { format: 'ur', ur };
    return accepted;
  }

  private status(accepted: boolean): ScanProgress {
    const complete = this.complete;
    if (this.format === 'bbqr' && this.bbqr) {
      const received = this.bbqr.bodies.size;
      const expected = this.bbqr.header.total;
      return { format: 'bbqr', accepted, complete, progress: complete ? 1 : received / expected, received, expected };
    }
    if (this.format === 'ur' && this.ur) {
      return {
        format: 'ur',
        accepted,
        complete,
        progress: this.ur.estimatedPercentComplete(),
        received: this.ur.receivedFragmentCount,
        expected: this.ur.expectedPartCount,
      };
    }
    return { format: this.format, accepted, complete, progress: complete ? 1 : 0, received: complete ? 1 : 0, expected: complete ? 1 : 0 };
  }
}

import { CatCardError } from './errors';
import type { ScanResult } from './receiver';
import type { QRSequence } from './sequence';

/** The user dismissed the CatCard dialog. Maps to EIP-1193 error 4001 / wallet-standard rejections. */
export class UserRejectedError extends CatCardError {
  readonly code = 4001;
  constructor(message = 'User rejected the request') {
    super(message);
  }
}

export interface ExchangeDetail {
  label: string;
  value: string;
}

/** One QR round trip with the device: optionally show a request, then scan the device's answer. */
export interface ExchangeRequest<T> {
  /** Dialog title, e.g. "Sign transaction". */
  title: string;
  /** Instructions shown to the user. */
  description?: string;
  /** Human-readable summary of what is being signed. */
  details?: readonly ExchangeDetail[];
  /** QR sequence for the device to scan first. Omitted for scan-only exchanges (e.g. connecting). */
  request?: QRSequence;
  /**
   * Validates and converts the scanned response. Throwing rejects the scan: the UI should
   * show the error message and let the user scan again.
   */
  parse(result: ScanResult): T;
  signal?: AbortSignal;
}

/**
 * How the SDK reaches the user. `catcard-sdk/ui` provides a ready-made modal; apps and
 * extensions can implement their own (e.g. in an extension popup).
 *
 * Implementations must reject with {@link UserRejectedError} when the user cancels.
 */
export interface CatCardBridge {
  exchange<T>(request: ExchangeRequest<T>): Promise<T>;
}

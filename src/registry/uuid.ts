import { QRDecodeError } from '../errors';
import { equalBytes } from '../util/bytes';

/** Random RFC 4122 v4 UUID bytes, used as sign request IDs. */
export function randomUUIDBytes(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

export function formatUUID(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Throws unless a response carries the expected request ID (a missing ID is tolerated). */
export function checkRequestId(expected: Uint8Array, got: Uint8Array | undefined): void {
  if (got && !equalBytes(expected, got)) throw new QRDecodeError('This signature belongs to a different request');
}

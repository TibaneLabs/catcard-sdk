/** Length of the `B$` + encoding + file type + total + index header. */
export const BBQR_HEADER_LENGTH = 8;

/** Maximum number of parts: two base36 digits. */
export const BBQR_MAX_PARTS = 1295;

export const BBQR_ENCODINGS = {
  H: 'Hex',
  '2': 'Base32',
  Z: 'Zlib compressed (raw deflate, 1 KiB window) + Base32',
} as const;

export type BBQrEncoding = keyof typeof BBQR_ENCODINGS;

/** File types defined by the BBQr spec. Any single uppercase letter is accepted on the wire. */
export const BBQR_FILE_TYPES = {
  P: 'PSBT',
  T: 'Transaction',
  J: 'JSON',
  C: 'CBOR',
  U: 'Unicode text',
  X: 'Executable',
  B: 'Binary',
} as const;

export type BBQrFileType = keyof typeof BBQR_FILE_TYPES | (string & {});

/** Number of encoded characters per part must be a multiple of this, so parts decode independently. */
export const BBQR_SPLIT_MOD: Record<BBQrEncoding, number> = { H: 2, '2': 8, Z: 8 };

export type QRVersion = number;

/** Alphanumeric-mode capacity at error correction level L, per QR version 1..40. */
export const QR_ALPHANUMERIC_CAPACITY_L: readonly number[] = [
  25, 47, 77, 114, 154, 195, 224, 279, 335, 395, 468, 535, 619, 667, 758, 854, 938, 1046, 1153, 1249,
  1352, 1460, 1588, 1704, 1853, 1990, 2132, 2223, 2369, 2520, 2677, 2840, 3009, 3183, 3351, 3537, 3729,
  3927, 4087, 4296,
];

import { CatCardError } from './errors';
import { hexToBytes } from './util/bytes';

const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff]; // "psbt" 0xff

export function isPsbt(data: Uint8Array): boolean {
  return data.length > PSBT_MAGIC.length && PSBT_MAGIC.every((b, i) => data[i] === b);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Accepts a PSBT as raw bytes, base64 or hex, and returns the raw bytes. */
export function parsePsbt(psbt: Uint8Array | string): Uint8Array {
  let bytes: Uint8Array | undefined;
  if (typeof psbt !== 'string') bytes = psbt;
  else {
    const text = psbt.trim();
    if (/^70736274ff([0-9a-f]{2})+$/i.test(text)) bytes = hexToBytes(text);
    else if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) bytes = base64ToBytes(text);
  }
  if (!bytes || !isPsbt(bytes)) throw new CatCardError('Not a valid PSBT');
  return bytes;
}

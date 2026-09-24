// RFC 4648 base32, without padding (as used by BBQr).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new TypeError(`Invalid base32 character: ${JSON.stringify(char)}`);
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >>> bits) & 0xff;
    }
  }
  return out;
}

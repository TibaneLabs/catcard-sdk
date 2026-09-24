import { CborTag, type CborValue } from '../cbor';
import { CatCardError, QRDecodeError } from '../errors';
import { expectMap, intKeyMap, optUint, untag } from './cbor-helpers';
import { TAGS } from './tags';

export interface PathComponent {
  /** Child index, or `null` for a wildcard (`*`). */
  index: number | null;
  hardened: boolean;
}

const HARDENED = 0x80000000;

/** A BIP32 derivation path with optional source (master) fingerprint: `crypto-keypath`. */
export class KeyPath {
  constructor(
    readonly components: readonly PathComponent[],
    readonly sourceFingerprint?: number,
    readonly depth?: number,
  ) {}

  /** Parses `m/44'/60'/0'/0/0` (also accepts `h` for hardened, and `*` wildcards). */
  static parse(path: string, sourceFingerprint?: number): KeyPath {
    const parts = path.trim().replace(/^m\/?/i, '').split('/').filter(Boolean);
    const components = parts.map((part): PathComponent => {
      const m = /^(\d+|\*)(['hH]?)$/.exec(part);
      if (!m) throw new CatCardError(`Invalid derivation path component: ${part}`);
      const index = m[1] === '*' ? null : Number(m[1]);
      if (index !== null && index >= HARDENED) throw new CatCardError(`Derivation index out of range: ${part}`);
      return { index, hardened: m[2] !== '' };
    });
    return new KeyPath(components, sourceFingerprint);
  }

  /** `m/44'/60'/0'` style string (without the `m/` prefix when `prefix` is false). */
  toString(prefix = true): string {
    const body = this.components.map((c) => `${c.index ?? '*'}${c.hardened ? "'" : ''}`).join('/');
    return prefix ? (body ? `m/${body}` : 'm') : body;
  }

  /** Child indexes with the hardened bit applied. Throws on wildcards. */
  toIndexes(): number[] {
    return this.components.map((c) => {
      if (c.index === null) throw new CatCardError('Cannot convert a wildcard path to indexes');
      return c.hardened ? c.index + HARDENED : c.index;
    });
  }

  concat(child: KeyPath): KeyPath {
    return new KeyPath([...this.components, ...child.components], this.sourceFingerprint);
  }

  toCbor(): CborValue {
    return intKeyMap({
      1: this.components.flatMap((c) => [c.index ?? [], c.hardened]),
      2: this.sourceFingerprint || undefined,
      3: this.depth,
    });
  }

  toTagged(): CborTag {
    return new CborTag(TAGS.cryptoKeypath, this.toCbor());
  }

  static fromCbor(value: CborValue): KeyPath {
    const map = expectMap(untag(value, TAGS.cryptoKeypath), 'crypto-keypath');
    const raw = map.get(1);
    if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new QRDecodeError('crypto-keypath: invalid components');
    const components: PathComponent[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const index = raw[i];
      const hardened = raw[i + 1];
      if (typeof hardened !== 'boolean') throw new QRDecodeError('crypto-keypath: invalid hardened flag');
      if (Array.isArray(index)) components.push({ index: null, hardened });
      else if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < HARDENED) {
        components.push({ index, hardened });
      } else throw new QRDecodeError('crypto-keypath: invalid index');
    }
    return new KeyPath(components, optUint(map, 2, 'crypto-keypath'), optUint(map, 3, 'crypto-keypath'));
  }
}

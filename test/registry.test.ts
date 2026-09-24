import {
  CryptoAccount,
  CryptoHDKey as KCryptoHDKey,
  CryptoKeypath,
  CryptoMultiAccounts,
  CryptoOutput,
  PathComponent,
  ScriptExpressions,
} from '@keystonehq/bc-ur-registry';
import { EthSignRequest as KEthSignRequest, ETHSignature } from '@keystonehq/bc-ur-registry-eth';
import { SolSignature as KSolSignature, SolSignRequest as KSolSignRequest } from '@keystonehq/bc-ur-registry-sol';
import { describe, expect, it } from 'vitest';
import {
  decodeAccountExport,
  decodeEthSignature,
  decodeSolSignature,
  EthDataType,
  encodeEthSignRequest,
  encodeSolSignRequest,
  formatUUID,
  keyCoinType,
  KeyPath,
  randomUUIDBytes,
  SolSignType,
} from '../src/registry';
import { UR } from '../src/ur';
import { hexToBytes } from '../src/util/bytes';

const xfp = 0x12345678;
const xfpBuf = Buffer.from('12345678', 'hex');
const pubkey = hexToBytes('03' + '11'.repeat(32));
const chainCode = hexToBytes('22'.repeat(32));

const kPath = (path: string, fp?: Buffer) =>
  new CryptoKeypath(
    path.replace(/^m\//, '').split('/').map((p) => new PathComponent({ index: parseInt(p), hardened: p.endsWith("'") })),
    fp,
  );

describe('KeyPath', () => {
  it('parses and formats paths', () => {
    expect(KeyPath.parse("m/44'/60'/0'/0/1").toString()).toBe("m/44'/60'/0'/0/1");
    expect(KeyPath.parse("44h/501h/0h").toIndexes()).toEqual([0x8000002c, 0x800001f5, 0x80000000]);
    expect(KeyPath.parse('0/*').toString(false)).toBe('0/*');
    expect(() => KeyPath.parse("m/44'/x")).toThrow();
  });
});

describe('account exports (Keystone interop)', () => {
  it('decodes crypto-hdkey', () => {
    const key = new KCryptoHDKey({
      isMaster: false,
      key: Buffer.from(pubkey),
      chainCode: Buffer.from(chainCode),
      origin: kPath("m/44'/60'/0'", xfpBuf),
      children: new CryptoKeypath([new PathComponent({ index: 0, hardened: false }), new PathComponent({ hardened: false })]),
      name: 'CatCard',
      note: 'account.standard',
    });
    const exp = decodeAccountExport(new UR('crypto-hdkey', key.toCBOR()));
    expect(exp.masterFingerprint).toBe(xfp);
    const [k] = exp.keys;
    expect(k!.key).toEqual(pubkey);
    expect(k!.chainCode).toEqual(chainCode);
    expect(k!.origin!.toString()).toBe("m/44'/60'/0'");
    expect(k!.children!.toString(false)).toBe('0/*');
    expect(k!.note).toBe('account.standard');
    expect(keyCoinType(k!)).toBe(60);
  });

  it('decodes crypto-account with script expressions', () => {
    const key = new KCryptoHDKey({ isMaster: false, key: Buffer.from(pubkey), origin: kPath("m/44'/60'/1'/0/0", xfpBuf) });
    const account = new CryptoAccount(xfpBuf, [
      new CryptoOutput([], key),
      new CryptoOutput([ScriptExpressions.PUBLIC_KEY_HASH], key),
    ]);
    const exp = decodeAccountExport(new UR('crypto-account', account.toCBOR()));
    expect(exp.masterFingerprint).toBe(xfp);
    expect(exp.keys).toHaveLength(2);
    expect(exp.keys[1]!.origin!.toString()).toBe("m/44'/60'/1'/0/0");
  });

  it('decodes crypto-multi-accounts', () => {
    const solKey = new KCryptoHDKey({ isMaster: false, key: Buffer.from('33'.repeat(32), 'hex'), origin: kPath("m/44'/501'/0'/0'", xfpBuf) });
    const multi = new CryptoMultiAccounts(xfpBuf, [solKey], 'CatCard', 'device-1');
    const exp = decodeAccountExport(new UR('crypto-multi-accounts', multi.toCBOR()));
    expect(exp).toMatchObject({ masterFingerprint: xfp, device: 'CatCard', deviceId: 'device-1' });
    expect(keyCoinType(exp.keys[0]!)).toBe(501);
  });
});

describe('eth-sign-request / eth-signature (Keystone interop)', () => {
  it('produces requests Keystone parses', () => {
    const requestId = randomUUIDBytes();
    const ur = encodeEthSignRequest({
      requestId,
      signData: hexToBytes('02f0'),
      dataType: EthDataType.TypedTransaction,
      chainId: 137,
      derivationPath: KeyPath.parse("m/44'/60'/0'/0/3", xfp),
      address: hexToBytes('ab'.repeat(20)),
      origin: 'catcard-sdk',
    });
    const parsed = KEthSignRequest.fromCBOR(Buffer.from(ur.cbor));
    expect(formatUUID(parsed.getRequestId()!)).toBe(formatUUID(requestId));
    expect(parsed.getSignData().toString('hex')).toBe('02f0');
    expect(parsed.getDataType()).toBe(4);
    expect(parsed.getChainId()).toBe(137);
    expect(parsed.getDerivationPath()).toBe("44'/60'/0'/0/3");
    expect(parsed.getSourceFingerprint()!.toString('hex')).toBe('12345678');
    expect(parsed.getSignRequestAddress()!.toString('hex')).toBe('ab'.repeat(20));
    expect(parsed.getOrigin()).toBe('catcard-sdk');

    // Byte-identical to Keystone's own encoding.
    const kReq = KEthSignRequest.constructETHRequest(
      Buffer.from('02f0', 'hex'), 4, "m/44'/60'/0'/0/3", '12345678', formatUUID(requestId), 137, '0x' + 'ab'.repeat(20), 'catcard-sdk',
    );
    expect(Buffer.from(ur.cbor).toString('hex')).toBe(kReq.toCBOR().toString('hex'));
  });

  it('decodes Keystone signatures', () => {
    const requestId = randomUUIDBytes();
    const sig = Buffer.from('aa'.repeat(64) + '25', 'hex');
    const kSig = new ETHSignature(sig, Buffer.from(requestId), 'CatCard');
    const decoded = decodeEthSignature(new UR('eth-signature', kSig.toCBOR()));
    expect(decoded.requestId).toEqual(requestId);
    expect(decoded.signature).toEqual(new Uint8Array(sig));
    expect(decoded.origin).toBe('CatCard');
  });
});

describe('sol-sign-request / sol-signature (Keystone interop)', () => {
  it('produces requests byte-identical to Keystone', () => {
    const requestId = randomUUIDBytes();
    const address = hexToBytes('44'.repeat(32));
    const ur = encodeSolSignRequest({
      requestId,
      signData: hexToBytes('0102030405'),
      derivationPath: KeyPath.parse("m/44'/501'/0'/0'", xfp),
      address,
      origin: 'catcard-sdk',
      signType: SolSignType.Message,
    });
    const kReq = KSolSignRequest.constructSOLRequest(
      Buffer.from('0102030405', 'hex'), "m/44'/501'/0'/0'", '12345678', 2, formatUUID(requestId), '44'.repeat(32), 'catcard-sdk',
    );
    expect(Buffer.from(ur.cbor).toString('hex')).toBe(kReq.toCBOR().toString('hex'));
  });

  it('decodes Keystone signatures', () => {
    const requestId = randomUUIDBytes();
    const sig = Buffer.from('bb'.repeat(64), 'hex');
    const decoded = decodeSolSignature(new UR('sol-signature', new KSolSignature(sig, Buffer.from(requestId)).toCBOR()));
    expect(decoded).toEqual({ requestId, signature: new Uint8Array(sig) });
  });
});

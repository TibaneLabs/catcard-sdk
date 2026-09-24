import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bbqrSplit,
  bytesToHex,
  CatCardError,
  createBBQrSequence,
  DEFAULT_FRAME_INTERVAL_MS,
  encodePsbt,
  encodeUR,
  interpretScan,
  QRAnimator,
  QRReceiver,
  resolveFormat,
  UR,
  Xoshiro256,
  type QRSequence,
} from '../src';
import { utf8Encode } from '../src/util/bytes';

const fakePsbt = (size: number): Uint8Array => {
  const psbt = new Xoshiro256(utf8Encode('psbt')).nextData(size);
  psbt.set([0x70, 0x73, 0x62, 0x74, 0xff]);
  return psbt;
};

/** Plays a sequence into a receiver, dropping every `dropEvery`-th frame, like a flaky camera. */
function scan(sequence: QRSequence, receiver: QRReceiver, dropEvery = 0): number {
  let shown = 0;
  while (!receiver.complete) {
    const frame = sequence.nextFrame();
    shown++;
    if (dropEvery && shown % dropEvery === 0) continue;
    receiver.receive(frame);
    if (shown > 1000) throw new Error('scan did not complete');
  }
  return shown;
}

describe('format selection', () => {
  it('defaults to BBQr for Bitcoin and UR for other chains', () => {
    expect(resolveFormat({})).toBe('bbqr');
    expect(resolveFormat({ chain: 'bitcoin-testnet' })).toBe('bbqr');
    expect(resolveFormat({ chain: 'litecoin' })).toBe('ur');
    expect(resolveFormat({ chain: 'evm' })).toBe('ur');
    expect(resolveFormat({ chain: 'bitcoin', format: 'ur' })).toBe('ur');
  });

  it('enforces Bitcoin-only firmware limits', () => {
    expect(resolveFormat({ firmware: 'bitcoin-only' })).toBe('bbqr');
    expect(() => resolveFormat({ firmware: 'bitcoin-only', format: 'ur' })).toThrow(CatCardError);
    expect(() => resolveFormat({ firmware: 'bitcoin-only', chain: 'solana' })).toThrow(CatCardError);
  });
});

describe('PSBT signing round trip', () => {
  const psbt = fakePsbt(4000);

  it('bitcoin: BBQr, accepts base64/hex input, survives dropped frames', () => {
    const b64 = btoa(String.fromCharCode(...psbt));
    for (const input of [psbt, b64, bytesToHex(psbt)]) {
      const sequence = encodePsbt(input, { bbqr: { maxVersion: 10 } });
      expect(sequence.format).toBe('bbqr');
      expect(sequence.animated).toBe(true);
      const receiver = new QRReceiver();
      scan(sequence, receiver, 3);
      expect(interpretScan(receiver.result()!)).toEqual({ kind: 'psbt', psbt });
    }
  });

  it('litecoin: BC-UR crypto-psbt, survives dropped frames', () => {
    const sequence = encodePsbt(psbt, { chain: 'litecoin' });
    expect(sequence.format).toBe('ur');
    expect(sequence.nextFrame()).toMatch(/^UR:CRYPTO-PSBT\/1-\d+\//);
    sequence.reset();
    const receiver = new QRReceiver();
    scan(sequence, receiver, 4);
    expect(interpretScan(receiver.result()!)).toEqual({ kind: 'psbt', psbt });
  });

  it('rejects non-PSBT input', () => {
    expect(() => encodePsbt(new Uint8Array([1, 2, 3]))).toThrow(CatCardError);
    expect(() => encodePsbt('not a psbt')).toThrow(CatCardError);
  });
});

describe('QRReceiver', () => {
  it('reports progress and ignores duplicates and foreign frames', () => {
    const { parts } = bbqrSplit(fakePsbt(3000), 'T', { encoding: 'H', maxVersion: 10 });
    const receiver = new QRReceiver();
    expect(receiver.receive(parts[0]!)).toMatchObject({ format: 'bbqr', accepted: true, received: 1, expected: parts.length });
    expect(receiver.receive(parts[0]!).accepted).toBe(false);
    expect(receiver.receive('UR:BYTES/HDCXLKAHSSQZWFVSLOFZOXWKRE').accepted).toBe(false);
    for (const part of parts.slice(1)) receiver.receive(part);
    expect(receiver.complete).toBe(true);
    expect(interpretScan(receiver.result()!).kind).toBe('transaction');
  });

  it('returns plain QR codes as text', () => {
    const receiver = new QRReceiver();
    expect(receiver.receive('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq').complete).toBe(true);
    expect(interpretScan(receiver.result()!)).toEqual({ kind: 'text', text: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' });
  });

  it('decodes JSON exports and leaves unknown URs to the caller', () => {
    const json = { xpub: 'xpub...', path: "m/84'/0'/0'" };
    const receiver = new QRReceiver();
    scan(createBBQrSequence(utf8Encode(JSON.stringify(json)), 'J'), receiver);
    expect(interpretScan(receiver.result()!)).toEqual({ kind: 'json', value: json });

    const ur = UR.fromValue(new Map([[1, 'hello']]), 'eth-signature');
    const urReceiver = new QRReceiver();
    scan(encodeUR(ur), urReceiver);
    expect(interpretScan(urReceiver.result()!)).toEqual({ kind: 'ur', ur });
  });
});

describe('QRAnimator', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it(`advances every ${DEFAULT_FRAME_INTERVAL_MS}ms by default and stops cleanly`, () => {
    const sequence = encodePsbt(fakePsbt(3000), { bbqr: { encoding: 'H', maxVersion: 10 } });
    const frames: string[] = [];
    const animator = new QRAnimator(sequence, { onFrame: (f) => frames.push(f) });
    animator.start();
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_FRAME_INTERVAL_MS - 1);
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(frames).toHaveLength(2);
    vi.advanceTimersByTime(DEFAULT_FRAME_INTERVAL_MS * 3);
    expect(frames).toHaveLength(5);
    animator.stop();
    vi.advanceTimersByTime(DEFAULT_FRAME_INTERVAL_MS * 10);
    expect(frames).toHaveLength(5);
    expect(animator.running).toBe(false);
  });

  it('shows single-frame sequences once without a timer', () => {
    const frames: string[] = [];
    new QRAnimator(encodePsbt(fakePsbt(100)), { onFrame: (f) => frames.push(f) }).start();
    vi.advanceTimersByTime(10_000);
    expect(frames).toHaveLength(1);
  });

  it('can be stopped from within onFrame', () => {
    const frames: string[] = [];
    const animator: QRAnimator = new QRAnimator(encodePsbt(fakePsbt(3000), { bbqr: { maxVersion: 5 } }), {
      onFrame: (f) => {
        frames.push(f);
        if (frames.length === 2) animator.stop();
      },
    });
    animator.start();
    vi.advanceTimersByTime(10_000);
    expect(frames).toHaveLength(2);
  });
});

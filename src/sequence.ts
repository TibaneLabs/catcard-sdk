import { bbqrSplit, type BBQrEncoding, type BBQrFileType, type BBQrSplitOptions } from './bbqr';
import type { QRFormat } from './chains';
import { UREncoder, type UR, type UREncoderOptions } from './ur';

/**
 * A (possibly animated) series of QR payloads for the device to scan.
 *
 * All frames only use characters from the QR alphanumeric set, so renderers that
 * auto-detect the mode produce the densest possible codes.
 */
export interface QRSequence {
  readonly format: QRFormat;
  /** Frames needed for a lossless scan. UR sequences continue past this with fountain-coded frames. */
  readonly frameCount: number;
  /** Whether more than one frame is needed (i.e. it must be shown as an animation). */
  readonly animated: boolean;
  /** Returns the next frame to display. Never ends: BBQr loops, UR keeps generating new frames. */
  nextFrame(): string;
  /** Restarts from the first frame. */
  reset(): void;
}

export interface BBQrSequence extends QRSequence {
  readonly format: 'bbqr';
  readonly fileType: string;
  readonly encoding: BBQrEncoding;
  /** QR version each frame was sized for (error correction level L). */
  readonly version: number;
  readonly parts: readonly string[];
}

export function createBBQrSequence(data: Uint8Array, fileType: BBQrFileType, options?: BBQrSplitOptions): BBQrSequence {
  const { parts, encoding, version } = bbqrSplit(data, fileType, options);
  let index = 0;
  return {
    format: 'bbqr',
    fileType,
    encoding,
    version,
    parts,
    frameCount: parts.length,
    animated: parts.length > 1,
    nextFrame() {
      const frame = parts[index]!;
      index = (index + 1) % parts.length;
      return frame;
    },
    reset() {
      index = 0;
    },
  };
}

export interface URSequenceOptions extends UREncoderOptions {
  /**
   * Emit uppercase frames so QR codes use the denser alphanumeric mode, as the UR spec recommends.
   * @default true
   */
  uppercase?: boolean;
}

export interface URSequence extends QRSequence {
  readonly format: 'ur';
  readonly ur: UR;
}

export function createURSequence(ur: UR, options: URSequenceOptions = {}): URSequence {
  const { uppercase = true, ...encoderOptions } = options;
  let encoder = new UREncoder(ur, encoderOptions);
  return {
    format: 'ur',
    ur,
    frameCount: encoder.fragmentCount,
    animated: !encoder.isSinglePart(),
    nextFrame() {
      const part = encoder.nextPart();
      return uppercase ? part.toUpperCase() : part;
    },
    reset() {
      encoder = new UREncoder(ur, encoderOptions);
    },
  };
}

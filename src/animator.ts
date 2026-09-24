import { DEFAULT_FRAME_INTERVAL_MS } from './constants';
import type { QRSequence } from './sequence';

export interface QRAnimatorOptions {
  /** Called with each frame to render. */
  onFrame: (frame: string, index: number) => void;
  /** Delay between frames. @default 600 */
  intervalMs?: number;
}

/**
 * Drives the display of a {@link QRSequence}. Rendering is left to the caller, so it
 * works with any QR library, framework, or environment (DOM, canvas, terminal...).
 *
 * @example
 * const animator = new QRAnimator(encodePsbt(psbt), {
 *   onFrame: (frame) => QRCode.toCanvas(canvas, frame, { errorCorrectionLevel: 'L' }),
 * });
 * animator.start();
 */
export class QRAnimator {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private index = 0;

  constructor(
    private readonly sequence: QRSequence,
    private readonly options: QRAnimatorOptions,
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
    if (!(this.intervalMs > 0)) throw new RangeError('intervalMs must be positive');
  }

  get running(): boolean {
    return this.active;
  }

  /** Shows the first frame immediately, then keeps advancing if the sequence is animated. */
  start(): void {
    if (this.running) return;
    this.sequence.reset();
    this.index = 0;
    this.active = true;
    this.tick();
  }

  stop(): void {
    this.active = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    this.timer = undefined;
    this.options.onFrame(this.sequence.nextFrame(), this.index++);
    // onFrame may have called stop().
    if (this.active && this.sequence.animated) this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }
}

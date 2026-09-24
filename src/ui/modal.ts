import { encode } from 'uqr';
import { QRAnimator } from '../animator';
import { UserRejectedError, type CatCardBridge, type ExchangeRequest } from '../bridge';
import { DEFAULT_FRAME_INTERVAL_MS } from '../constants';
import { QRDecodeError } from '../errors';
import { CATCARD_ICON } from '../icon';
import { QRReceiver } from '../receiver';
import { MODAL_CSS } from './styles';

export interface ModalBridgeOptions {
  /** Where the modal is attached. @default document.body */
  container?: HTMLElement;
  /** Delay between animated QR frames. @default 600 */
  frameIntervalMs?: number;
  /** Delay between camera decode attempts. @default 120 */
  scanIntervalMs?: number;
}

type Decoder = (video: HTMLVideoElement) => Promise<string[]>;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

async function createDecoder(): Promise<Decoder> {
  const Native = (globalThis as { BarcodeDetector?: any }).BarcodeDetector;
  if (Native) {
    try {
      const formats: string[] = await Native.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector: BarcodeDetectorLike = new Native({ formats: ['qr_code'] });
        return async (video) => (await detector.detect(video)).map((b) => b.rawValue);
      }
    } catch {
      // Fall back to jsQR.
    }
  }
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return async (video) => {
    if (!video.videoWidth) return [];
    const scale = Math.min(1, 800 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
    return code?.data ? [code.data] : [];
  };
}

function drawQR(canvas: HTMLCanvasElement, text: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { data, size } = encode(text, { ecc: 'L', border: 3 });
  canvas.width = size;
  canvas.height = size;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y]![x]) ctx.fillRect(x, y, 1, 1);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/**
 * The default CatCard UI: a modal dialog that shows request QR codes (animated at
 * 600 ms/frame) and scans the device's answer with the camera. Requests are queued, so
 * only one dialog is shown at a time.
 */
export class ModalBridge implements CatCardBridge {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ModalBridgeOptions = {}) {}

  exchange<T>(request: ExchangeRequest<T>): Promise<T> {
    const run = this.queue.then(() => this.show(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private show<T>(request: ExchangeRequest<T>): Promise<T> {
    if (typeof document === 'undefined') {
      return Promise.reject(new Error('ModalBridge requires a browser environment; provide your own CatCardBridge.'));
    }
    return new Promise<T>((resolve, reject) => {
      const cleanups: (() => void)[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        for (const cleanup of cleanups.reverse()) cleanup();
        fn();
      };
      const cancel = () => finish(() => reject(new UserRejectedError()));

      if (request.signal?.aborted) return reject(request.signal.reason);
      const onAbort = () => finish(() => reject(request.signal!.reason));
      request.signal?.addEventListener('abort', onAbort);
      cleanups.push(() => request.signal?.removeEventListener('abort', onAbort));

      // ---- Layout
      const host = el('div');
      host.setAttribute('data-catcard-modal', '');
      const root = host.attachShadow({ mode: 'open' });
      const title = el('h2', { id: 'catcard-title', textContent: request.title });
      const close = el('button', { className: 'close', type: 'button', textContent: '×', title: 'Cancel' });
      close.setAttribute('aria-label', 'Cancel');
      const description = el('p', { textContent: request.description ?? '' });
      description.hidden = !request.description;
      const details = el('dl');
      for (const d of request.details ?? []) details.append(el('dt', { textContent: d.label }), el('dd', { textContent: d.value }));
      details.hidden = !request.details?.length;

      const showStage = el('div', { className: 'stage' });
      const qrCanvas = el('canvas', { className: 'qr' });
      qrCanvas.setAttribute('role', 'img');
      qrCanvas.setAttribute('aria-label', 'QR code for your CatCard');
      const frameStatus = el('div', { className: 'status' });
      showStage.append(qrCanvas, frameStatus);

      const scanStage = el('div', { className: 'stage' });
      const video = el('video', { muted: true, autoplay: true, playsInline: true });
      const progressBar = el('div');
      const scanStatus = el('div', { className: 'status', textContent: 'Starting camera…' });
      const scanError = el('div', { className: 'error' });
      scanError.setAttribute('role', 'alert');
      const paste = el('textarea', { placeholder: 'One QR code content per line' });
      const pasteButton = el('button', { className: 'secondary', type: 'button', textContent: 'Use pasted text' });
      scanStage.append(
        el('div', { className: 'video-wrap' }, video, el('div', { className: 'frame-guide' })),
        el('div', { className: 'progress' }, progressBar),
        scanStatus,
        scanError,
        el('details', {}, el('summary', { textContent: 'No camera? Paste the scanned text' }), paste, el('div', { className: 'actions' }, pasteButton)),
      );

      const back = el('button', { className: 'secondary', type: 'button', textContent: 'Back' });
      const next = el('button', { className: 'primary', type: 'button', textContent: 'Next: scan CatCard' });
      const cancelButton = el('button', { className: 'secondary', type: 'button', textContent: 'Cancel' });
      const actions = el('div', { className: 'actions' }, back, cancelButton, next);

      const dialog = el(
        'div',
        { className: 'dialog' },
        el('header', {}, el('img', { src: CATCARD_ICON, alt: '' }), title, close),
        description,
        details,
        showStage,
        scanStage,
        actions,
      );
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'catcard-title');
      const backdrop = el('div', { className: 'backdrop' }, dialog);
      root.append(el('style', { textContent: MODAL_CSS }), backdrop);
      (this.options.container ?? document.body).append(host);
      cleanups.push(() => host.remove());

      close.onclick = cancel;
      cancelButton.onclick = cancel;
      backdrop.addEventListener('mousedown', (e) => e.target === backdrop && cancel());
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancel();
      document.addEventListener('keydown', onKey, true);
      cleanups.push(() => document.removeEventListener('keydown', onKey, true));

      // ---- Showing the request
      let animator: QRAnimator | undefined;
      if (request.request) {
        const sequence = request.request;
        animator = new QRAnimator(sequence, {
          intervalMs: this.options.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS,
          onFrame: (frame, index) => {
            drawQR(qrCanvas, frame);
            frameStatus.textContent = sequence.animated
              ? `Animated QR — part ${(index % sequence.frameCount) + 1} of ${sequence.frameCount}`
              : '';
          },
        });
        cleanups.push(() => animator!.stop());
      }

      // ---- Scanning the answer
      const receiver = new QRReceiver();
      let stream: MediaStream | undefined;
      let scanTimer: ReturnType<typeof setTimeout> | undefined;
      const stopCamera = () => {
        clearTimeout(scanTimer);
        scanTimer = undefined;
        stream?.getTracks().forEach((t) => t.stop());
        stream = undefined;
        video.srcObject = null;
      };
      cleanups.push(stopCamera);

      const handleText = (text: string) => {
        let status;
        try {
          status = receiver.receive(text);
        } catch (e) {
          if (!(e instanceof QRDecodeError)) throw e;
          // A frame from another QR sequence (e.g. a previous one): start over with it.
          receiver.reset();
          status = receiver.receive(text);
        }
        progressBar.style.width = `${Math.round(status.progress * 100)}%`;
        if (status.expected > 1) scanStatus.textContent = `Receiving… ${status.received}/${status.expected}`;
        if (!status.complete) return;
        try {
          const value = request.parse(receiver.result()!);
          finish(() => resolve(value));
        } catch (e) {
          scanError.textContent = (e as Error).message;
          receiver.reset();
          progressBar.style.width = '0';
        }
      };

      const startCamera = async () => {
        scanError.textContent = '';
        scanStatus.textContent = 'Starting camera…';
        if (!navigator.mediaDevices?.getUserMedia) {
          scanStatus.textContent = '';
          scanError.textContent = 'Camera access is not available here (a secure https:// page is required).';
          return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        } catch (e) {
          scanStatus.textContent = '';
          scanError.textContent =
            (e as DOMException).name === 'NotAllowedError' ? 'Camera permission was denied.' : 'Could not start the camera.';
          return;
        }
        if (settled || scanStage.hidden) return stopCamera();
        video.srcObject = stream;
        video.classList.toggle('mirrored', stream.getVideoTracks()[0]?.getSettings().facingMode !== 'environment');
        await video.play().catch(() => undefined);
        scanStatus.textContent = 'Hold the CatCard screen in front of the camera';
        const decode = await createDecoder();
        const tick = async () => {
          if (settled || !stream) return;
          try {
            for (const text of await decode(video)) handleText(text);
          } catch (e) {
            scanError.textContent = (e as Error).message;
          }
          if (!settled && stream) scanTimer = setTimeout(tick, this.options.scanIntervalMs ?? 120);
        };
        void tick();
      };

      pasteButton.onclick = () => {
        scanError.textContent = '';
        for (const line of paste.value.split(/\s+/).filter(Boolean)) {
          if (settled) return;
          try {
            handleText(line);
          } catch (e) {
            scanError.textContent = (e as Error).message;
          }
        }
        if (!settled && !scanError.textContent) scanError.textContent = 'Incomplete: more QR codes are needed.';
      };

      // ---- Steps
      const showRequest = () => {
        stopCamera();
        showStage.hidden = false;
        scanStage.hidden = true;
        back.hidden = true;
        next.hidden = false;
        animator!.start();
        next.focus();
      };
      const showScanner = () => {
        animator?.stop();
        showStage.hidden = true;
        scanStage.hidden = false;
        back.hidden = !animator;
        next.hidden = true;
        void startCamera();
      };
      next.onclick = showScanner;
      back.onclick = showRequest;
      if (animator) showRequest();
      else showScanner();
    });
  }
}

/** Creates the default modal bridge. */
export function createModalBridge(options?: ModalBridgeOptions): ModalBridge {
  return new ModalBridge(options);
}

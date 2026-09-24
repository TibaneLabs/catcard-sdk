# catcard-sdk

JavaScript SDK for talking to CatCard hardware wallets over air-gapped QR codes, from websites, browser extensions and Node.js.

- **BBQr** and **BC-UR** (fountain-coded) encoding and decoding, wire-compatible with the reference implementations
- Works on `Uint8Array` only: no `Buffer`, no Node.js polyfills; runs in browsers, MV3 extension service workers and Node.js ≥ 18
- ESM, CommonJS and a `<script>`-tag bundle (`window.CatCard`); a single runtime dependency (`pako`)
- Renderer-agnostic: bring your own QR drawing / camera scanning library

## Install

```sh
npm install catcard-sdk
```

## The flow

A wallet or extension talks to CatCard in three steps:

1. **Scan the device's addresses.** The CatCard shows its account/address export as a QR (animated if needed), and the app scans it.
2. **Send a transaction to sign.** The app builds the transaction and shows it as an animated QR for the CatCard to scan.
3. **Scan the result.** After signing on the device, the CatCard shows either the signed transaction or just the signature, and the app scans it.

Steps 1 and 3 use `QRReceiver` + `interpretScan`, step 2 uses `encodePsbt` / `encodeUR` + `QRAnimator`.

### Showing a QR to the device

```ts
import { encodePsbt, QRAnimator } from 'catcard-sdk';
import QRCode from 'qrcode';

const sequence = encodePsbt(psbtBase64); // Bitcoin → BBQr by default

const animator = new QRAnimator(sequence, {
  // Frames only use QR alphanumeric characters; level L gives the most capacity.
  onFrame: (frame) => QRCode.toCanvas(canvas, frame, { errorCorrectionLevel: 'L' }),
});
animator.start(); // 600 ms per frame by default (the CatCard camera is slow)
// ...
animator.stop();
```

### Scanning a QR from the device

```ts
import { QRReceiver, interpretScan } from 'catcard-sdk';

const receiver = new QRReceiver();

scanner.onDecode = (text) => {
  const status = receiver.receive(text); // any order, duplicates are fine
  progressBar.value = status.progress;
  if (!status.complete) return;

  const payload = interpretScan(receiver.result()!);
  switch (payload.kind) {
    case 'psbt': /* signed PSBT */ break;
    case 'transaction': /* finalized transaction, ready to broadcast */ break;
    case 'json': /* e.g. an account export */ break;
    case 'ur': /* chain-specific UR (payload.ur.type, payload.ur.decodeCbor()) */ break;
  }
};
```

## QR formats

| Target | Default | Notes |
| --- | --- | --- |
| Bitcoin (and testnet) | BBQr | The only format the Bitcoin-only firmware reads |
| Other UTXO chains (BCH, LTC, DOGE, MONA…) | BC-UR | |
| EVM, Solana, Tron | BC-UR | |

Override with `format`, and declare the firmware variant so incompatible choices fail early:

```ts
encodePsbt(psbt, { chain: 'litecoin' });               // BC-UR crypto-psbt
encodePsbt(psbt, { format: 'ur' });                     // Bitcoin over BC-UR
encodePsbt(psbt, { firmware: 'bitcoin-only', format: 'ur' }); // throws
encodePsbt(psbt, { bbqr: { maxVersion: 15 } });         // smaller, easier-to-scan frames
```

Lower-level building blocks are exported too: `bbqrSplit` / `bbqrJoin`, `UREncoder` / `URDecoder`, `UR`, `cborEncode` / `cborDecode`, `createBBQrSequence` / `createURSequence`.

## Development

```sh
npm test          # vitest
npm run typecheck
npm run build     # dist/: ESM, CJS, .d.ts, and catcard.iife.js
npm run check     # all of the above + publint
```

Interop tests run the codecs against the `bbqr` and `@ngraveio/bc-ur` reference libraries (dev dependencies only).

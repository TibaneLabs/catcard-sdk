# catcard-sdk

JavaScript SDK for CatCard hardware wallets. It makes an air-gapped CatCard work like a regular browser wallet for EVM and Solana dapps, and exposes the underlying QR protocols (BBQr, BC-UR) for everything else.

- **Drop-in wallet for dapps**: an EIP-1193 provider announced via EIP-6963 (MetaMask-style, found by wagmi, RainbowKit, Web3Modal…) and a Wallet Standard wallet for Solana (found by `@solana/wallet-adapter`, like Phantom)
- **Built-in UI**: a modal that shows animated request QR codes (600 ms/frame for the CatCard camera) and scans the device's answer with the webcam
- **Keystone-compatible messages**: `eth-sign-request` / `eth-signature`, `sol-sign-request` / `sol-signature`, and `crypto-hdkey` / `crypto-account` / `crypto-multi-accounts` account exports
- **Signatures verified and applied by the SDK**: the device returns only a signature; the SDK checks it was made by the expected account, then produces the signed transaction
- **BBQr and BC-UR codecs**, wire-compatible with the reference implementations; `Uint8Array` only, no Node.js polyfills

## Quick start: make CatCard available to a dapp

```sh
npm install catcard-sdk
```

```ts
import { injectCatCard } from 'catcard-sdk/inject';

injectCatCard({
  ethereum: {
    rpc: {
      1: 'https://mainnet.example/rpc',   // your RPC endpoints (URL or viem transport)
      8453: 'https://base.example/rpc',
    },
  },
  solana: {
    rpc: { 'solana:mainnet': 'https://solana.example/rpc' },
  },
});
```

That's it: "CatCard" now appears in the dapp's wallet picker alongside extension wallets. Dapps (or SDKs) that look wallets up by name can use `window.catcard.ethereum` / `window.catcard.solana`, the way `window.phantom.*` works; the same object is returned by `getCatCard()`. `window.ethereum` is never overwritten. Or, with default settings, simply `import 'catcard-sdk/auto'`, or add a script tag:

```html
<script src="https://cdn.jsdelivr.net/npm/catcard-sdk/dist/catcard-inject.iife.js"></script>
```

### The user flow

1. **Connect**: the dapp requests accounts, the modal opens the webcam and the user shows their CatCard's account export QR. Accounts are remembered (in `localStorage` by default).
2. **Sign**: when the dapp asks for a signature, the modal shows the request as an animated QR code. The user scans it with the CatCard and confirms on the device.
3. **Scan back**: the CatCard shows the signature as a QR code; the modal scans it, and the SDK verifies it and returns the signed transaction or message to the dapp.

### RPC endpoints

Wallets are expected to give dapps access to the chain. The EVM provider forwards all read-only calls (`eth_call`, `eth_getBalance`, …) to the active chain's RPC endpoint, and uses it to fill in nonce, gas and fees and to broadcast `eth_sendTransaction`. The Solana wallet uses its endpoint for `signAndSendTransaction`.

Chains without a configured endpoint fall back to their public RPC, which is rate-limited: **production integrations should set their own**.

| Option | Default |
| --- | --- |
| `ethereum.rpc` | `{ [chainId]: url \| viem Transport }` → each chain's public RPC from viem |
| `ethereum.chains` | Ethereum, Sepolia, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche (dapps can add more via `wallet_addEthereumChain`) |
| `ethereum.defaultChainId` | the first chain |
| `solana.rpc` | `{ 'solana:mainnet' \| 'solana:devnet' \| 'solana:testnet': url }` → public cluster endpoints |

### Supported methods

**EVM (EIP-1193)**: `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `eth_sendTransaction`, `eth_signTransaction`, `personal_sign`, `eth_signTypedData_v4` (and `_v3`), `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `wallet_requestPermissions` / `getPermissions` / `revokePermissions`; everything else is forwarded to the RPC endpoint. `eth_sign` is refused as unsafe. Errors use EIP-1193 codes (4001 when the user cancels).

**Solana (Wallet Standard)**: `standard:connect`, `standard:disconnect`, `standard:events`, `solana:signTransaction`, `solana:signAndSendTransaction`, `solana:signMessage`; legacy and v0 transactions.

## Using the building blocks

### Your own UI (e.g. in a browser extension)

The modal is only the default. Anything implementing `CatCardBridge` can drive the QR round trip, for example an extension popup:

```ts
import type { CatCardBridge } from 'catcard-sdk';

const bridge: CatCardBridge = {
  async exchange({ title, description, details, request, parse }) {
    // 1. if `request` is set, display it (see QRAnimator below) for the device to scan
    // 2. scan the device's answer with a QRReceiver
    // 3. return parse(receiver.result()); if parse throws, show the error and scan again
    // Reject with UserRejectedError if the user cancels.
  },
};

injectCatCard({ bridge });
```

### Signers without injection

```ts
import { CatCardEthereumProvider } from 'catcard-sdk/evm';
import { createWalletClient, custom } from 'viem';

const provider = new CatCardEthereumProvider({ bridge, rpc: { 1: 'https://…' } });
await provider.connect();

// As a viem account…
const client = createWalletClient({ account: provider.getSigner().toViemAccount(), transport: custom(provider) });
// …or through the provider directly
await provider.request({ method: 'personal_sign', params: ['0x68656c6c6f', provider.selectedAccount!.address] });
```

`CatCardSolanaSigner` (in `catcard-sdk/solana`) does the same for Solana: `signTransaction(wireBytes)` returns the transaction with the account's signature in its slot.

### Raw QR transport

For Bitcoin (PSBT over BBQr) or custom flows, the transport layer is exported from the package root:

```ts
import { encodePsbt, QRAnimator, QRReceiver, interpretScan } from 'catcard-sdk';

const animator = new QRAnimator(encodePsbt(psbtBase64), { onFrame: (frame) => drawQR(frame) }); // BBQr by default for Bitcoin
animator.start();

const receiver = new QRReceiver();
scanner.onDecode = (text) => {
  if (receiver.receive(text).complete) handle(interpretScan(receiver.result()!)); // signed PSBT, transaction…
};
```

| Target | Default QR format |
| --- | --- |
| Bitcoin (and testnet) | BBQr, the only format the Bitcoin-only firmware reads |
| Other UTXO chains, EVM, Solana, Tron | BC-UR |

## Entry points

| Import | Contents | Dependencies |
| --- | --- | --- |
| `catcard-sdk` | QR codecs (BBQr, BC-UR, CBOR), registry types, `QRAnimator`, `QRReceiver`, PSBT helpers | `pako` |
| `catcard-sdk/evm` | EIP-1193 provider, signer, viem account, EIP-6963 | `viem`, `@noble/curves` |
| `catcard-sdk/solana` | Wallet Standard wallet, signer, transaction helpers | `@noble/curves`, `@scure/base`, `@wallet-standard/*` |
| `catcard-sdk/ui` | Default modal bridge | `uqr`, `jsqr` (loaded only without native `BarcodeDetector`) |
| `catcard-sdk/inject`, `catcard-sdk/auto` | One-call setup of all of the above | |

ESM and CommonJS builds are provided; Node.js ≥ 20. `dist/catcard.iife.js` (core, `window.CatCard`) and `dist/catcard-inject.iife.js` (auto-inject) are self-contained script-tag bundles.

## Development

```sh
npm test          # vitest (includes a simulated CatCard that signs real requests)
npm run typecheck
npm run build
npm run check     # all of the above + publint
npm run icon      # regenerate src/icon.ts from assets/catcard-icon.svg
```

Interop tests check the codecs against the reference `bbqr`, `@ngraveio/bc-ur` and `@keystonehq/bc-ur-registry*` libraries, and Solana transactions against `@solana/web3.js` (all dev dependencies only).

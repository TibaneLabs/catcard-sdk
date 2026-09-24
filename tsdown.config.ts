import { defineConfig } from 'tsdown';

const entry = {
  index: 'src/index.ts',
  evm: 'src/evm/index.ts',
  solana: 'src/solana/index.ts',
  tron: 'src/tron/index.ts',
  bitcoin: 'src/bitcoin/index.ts',
  ui: 'src/ui/index.ts',
  inject: 'src/inject.ts',
  auto: 'src/auto.ts',
};

export default defineConfig([
  // ESM + CJS for bundlers, browser extensions and Node.js. Dependencies stay external.
  {
    entry,
    format: ['esm', 'cjs'],
    platform: 'neutral',
    target: 'es2020',
    dts: true,
    sourcemap: true,
    clean: true,
  },
  // Self-contained bundles for <script> tags.
  {
    entry: { catcard: 'src/index.ts' },
    format: 'iife',
    globalName: 'CatCard',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: true,
    deps: { alwaysBundle: [/./], onlyBundle: false },
  },
  {
    // Injects CatCard on load: <script src=".../catcard-inject.iife.js"></script>
    entry: { 'catcard-inject': 'src/auto.ts' },
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: true,
    // TronWeb is too large to bundle: the Tron provider uses a global `TronWeb` when present.
    deps: { alwaysBundle: [/^(?!tronweb)/], neverBundle: ['tronweb'], onlyBundle: false },
    outputOptions: { codeSplitting: false },
  },
]);

import { defineConfig } from 'tsdown';

export default defineConfig([
  // ESM + CJS for bundlers, browser extensions and Node.js.
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    platform: 'neutral',
    target: 'es2020',
    dts: true,
    sourcemap: true,
    clean: true,
    deps: { neverBundle: ['pako'] },
  },
  // Self-contained bundle for <script> tags, exposed as `window.CatCard`.
  {
    entry: { catcard: 'src/index.ts' },
    format: 'iife',
    globalName: 'CatCard',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: true,
    deps: { alwaysBundle: ['pako'], onlyBundle: ['pako'] },
  },
]);

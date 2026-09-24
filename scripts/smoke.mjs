// Loads every published entry point (ESM and CommonJS) from dist/, e.g. on the oldest
// supported Node.js version, which the build and test tooling no longer runs on.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const entries = ['', '/evm', '/solana', '/tron', '/bitcoin', '/ui', '/inject'];

for (const entry of entries) {
  const name = `catcard-sdk${entry}`;
  const esm = await import(name);
  const cjs = require(name);
  if (!Object.keys(esm).length || !Object.keys(cjs).length) throw new Error(`${name}: no exports`);
}

const { encodePsbt, QRReceiver } = await import('catcard-sdk');
const sequence = encodePsbt(new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 1, 2, 3]));
const receiver = new QRReceiver();
while (!receiver.complete) receiver.receive(sequence.nextFrame());

console.log(`Node.js ${process.version}: all ${entries.length} entry points load (ESM + CJS)`);

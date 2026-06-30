import { Buffer } from 'node:buffer'

// In the jsdom environment, Vitest's populateGlobal() copies the jsdom realm's
// Uint8Array into the test global but does NOT restore Node.js's own Uint8Array.
// This means `Buffer.from(…) instanceof Uint8Array` returns false inside jsdom
// tests, because Buffer is a subclass of Node.js Uint8Array, not jsdom's.
//
// @noble/curves (used by @bitcoinerlab/secp256k1) performs `instanceof Uint8Array`
// checks when validating secp256k1 points. When a Node.js Buffer is passed, the
// check fails and the point is rejected. bitcoinjs-lib's initEccLib() calls these
// validators at module-load time; it throws "ecc library invalid" whenever bip322-js
// or src/lib/bitcoin.ts are imported transitively — even in tests that never call
// any crypto code.
//
// Fix: before any crypto modules are resolved, restore the global Uint8Array to
// Node.js's own. We recover it from the Buffer prototype chain because Buffer is
// always Node.js's Buffer (Vitest explicitly re-installs it in the jsdom global)
// and `Object.getPrototypeOf(Buffer.prototype).constructor` is definitionally
// Node.js's Uint8Array.
if (typeof window !== 'undefined') {
  const nodeUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as typeof Uint8Array
  ;(globalThis as any).Uint8Array = nodeUint8Array
}

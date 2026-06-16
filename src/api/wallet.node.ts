import type { LocalWalletSource, LocalWalletType } from '../provider/local'

export { saveWallet as connectLocalWallet } from '../provider/local'
// Server (Node/Bun) wallet surface: the shared core plus the local (WIF) wallet
// connection. No modal connect — headless environments connect via a private key.
export * from './wallet'

export type { LocalWalletSource, LocalWalletType }

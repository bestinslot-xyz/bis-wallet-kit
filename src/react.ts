// React adapter entry: thin hooks over the framework-agnostic network store and
// session. `react` is an optional peer dependency and is externalized at build.
export { useNetwork } from './adapters/react/use-network'
export { useWallet } from './adapters/react/use-wallet'
export type { BISNetwork, BISSession, BISWallet, BISWalletProvider } from './types/common'

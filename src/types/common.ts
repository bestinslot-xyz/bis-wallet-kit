/* UI */
export type ModalState = 'connect' | 'confirm_connection' | 'error'
export type ModalTheme = 'light' | 'dark' | 'system'

/* Other */
export type BISNetwork = 'mainnet' | 'testnet' | 'signet'

export interface ConnectCallbacks {
  onSelect: (session: BISSession) => void
  onError: (error: Error) => void
}

/* Wallet */
export type BISWalletProvider = 'okx' | 'unisat' | 'xverse' | 'leather' | 'me' | 'local'
export type BISWalletPurpose = 'ordinals' | 'payment' | 'all'

export interface BISSession {
  provider: BISWalletProvider
  wallets: BISWallet[]
  signature: string | null
}

export interface BISWallet {
  address: string
  pubkey: string | null
  purpose: BISWalletPurpose
}

/**
 * An optional extra payment output attached to a transaction (e.g. a service
 * fee). When supplied, the transaction includes an output sending
 * `paymentAmount` sats to `paymentAddress`, funded by the connected wallet —
 * this is a destination the funds go *to*, not an alternate funding source.
 *
 * @property paymentAddress - The destination address that receives the payment output.
 * @property paymentAmount - The amount sent to `paymentAddress`, in sats.
 */
export interface PaymentOpts {
  paymentAddress: string
  paymentAmount: number
}

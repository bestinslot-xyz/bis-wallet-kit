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
 * Represents a payment option with a payment address and amount.
 *
 * @property paymentAddress - The address to which the payment should be sent.
 * @property paymentAmount - The amount to be paid, represented as a number.
 */
export interface PaymentOpts {
  paymentAddress: string
  paymentAmount: number
}

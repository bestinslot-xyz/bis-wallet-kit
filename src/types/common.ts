/* UI */
export type ModalState = 'connect' | 'confirm_connection' | 'error'
export type ModalTheme = 'light' | 'dark' | 'system'

/**
 * The legal pages the connect modal's footer links to: "By connecting your wallet, you agree to
 * `owner`'s Terms of Service and Privacy Policy". URLs are http(s) or a path on the page's origin.
 */
export interface ModalLegalLinks {
  terms: string
  privacy: string
  owner: string
}

/* Other */
export type BISNetwork = 'mainnet' | 'testnet' | 'signet'

export interface ConnectCallbacks {
  onSelect: (session: BISSession) => void
  onError: (error: Error) => void
}

/* Wallet */
export type BISWalletProvider = 'okx' | 'unisat' | 'xverse' | 'metamask' | 'local'
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
 * fee). When `paymentAmount` is greater than 0, the transaction includes an
 * output sending that many sats to `paymentAddress`, funded by the connected
 * wallet — this is a destination the funds go *to*, not an alternate funding
 * source. A non-positive amount adds no output.
 *
 * @property paymentAddress - The destination address that receives the payment output.
 * @property paymentAmount - The amount sent to `paymentAddress`, in sats. Must be greater than 0 to add the output.
 */
export interface PaymentOpts {
  paymentAddress: string
  paymentAmount: number
}

/**
 * An output the commit transaction must spend.
 *
 * @property outpoint - The output as `txid:vout`.
 * @property value - The output's value in sats.
 */
export interface CommitInput {
  outpoint: string
  value: number
}

/**
 * Options for the commit transaction of a smart contract call. With neither set, coin selection
 * funds the commit from the payer's cardinal UTXOs.
 *
 * Spending the inputs of an earlier call package that is unconfirmed, or that mempools dropped,
 * replaces that package with the new one: pass the earlier commit's own inputs as `inputs`, and
 * while the earlier package is still in mempools, a `minCommitFee` of at least the total fee of
 * every transaction the new commit evicts (BIP125 rule 3) plus the relay fee for its own size
 * (rule 4).
 *
 * With `inputs`, the call runs in replacement mode: coin selection for the commit and the send
 * skips provider outputs reported unconfirmed (`block_height: null`), since they may belong to the
 * earlier package, and the commit is tested for mempool acceptance alone, since a
 * multi-transaction test refuses any conflict with the mempool. The reveal and send go untested.
 *
 * @property inputs - Outputs the commit spends, ahead of any extra funding coin selection adds.
 *   Each must be an output of the payer (payment) address with the given value, which the kit
 *   checks against the output's transaction. Each must also carry no inscription: the kit rejects
 *   one its chain provider lists with inscriptions, and the caller guarantees it for any other.
 *   While the earlier package is unconfirmed, its inputs are spent in the mempool, so the provider
 *   no longer lists them and the kit cannot see their inscriptions: pass only the earlier commit's
 *   own inputs, never an output of the earlier package.
 * @property minCommitFee - The least absolute fee the commit pays, in sats. When the fee rate
 *   gives a lower fee, the commit's change (or, without change, its commit output) gives up the
 *   difference. A value at or below the fee-rate fee changes nothing.
 */
export interface CommitOpts {
  inputs?: CommitInput[]
  minCommitFee?: number
}

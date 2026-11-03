import { createBitcoinWalletProvider } from './bitcoin-wallet'
import { findBitcoinStandardWallet, standardWalletBackend } from './wallet-standard'

/**
 * MetaMask's Bitcoin account, through the Bitcoin Wallet Standard. MetaMask gives one payment
 * address and no public key, so it connects as a single-address wallet and its key is read from a
 * message signature; its chains are mainnet, testnet, testnet4 and regtest, not signet.
 */
export const METAMASK = createBitcoinWalletProvider('MetaMask', () => {
  const wallet = findBitcoinStandardWallet(/metamask/i)
  return wallet ? standardWalletBackend(wallet) : null
})

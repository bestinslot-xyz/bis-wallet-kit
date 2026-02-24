import * as ecc from '@bitcoinerlab/secp256k1'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getNetwork } from '../core/store-network'

// Initialize ECC once
bitcoinjs.initEccLib(ecc)

/**
 * Get the Bitcoin network parameters based on the current network.
 * This is used for address generation and transaction creation.
 *
 * @returns {bitcoinjs.Network} The Bitcoin network parameters for the current network.
 */
export function getBitcoinNetwork(): bitcoinjs.Network {
  const network = getNetwork()

  if (network === 'mainnet')
    return bitcoinjs.networks.bitcoin

  return bitcoinjs.networks.testnet
}

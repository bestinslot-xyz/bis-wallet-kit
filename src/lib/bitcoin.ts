import { getNetwork } from '@@/main'
import * as ecc from '@bitcoinerlab/secp256k1'
import * as bitcoinjs from 'bitcoinjs-lib'

// Initialize ECC once
bitcoinjs.initEccLib(ecc)

export { bitcoinjs }

export function getBitcoinNetwork() {
  const network = getNetwork()

  if (network === 'mainnet')
    return bitcoinjs.networks.bitcoin

  return bitcoinjs.networks.testnet
}

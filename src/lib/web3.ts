import Web3 from 'web3'

let web3: Web3 | null = null

/**
 *
 */
export function getWeb3(): Web3 {
  if (!web3 && typeof window !== 'undefined') {
    web3 = new Web3()
  }
  return web3!
}

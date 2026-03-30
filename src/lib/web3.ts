import Web3 from 'web3'

let web3: Web3 | null = null

/**
 * Provides a singleton instance of the Web3 library. The getWeb3 function checks if a Web3 instance already exists and returns it if available. If not, it creates a new instance of Web3 and stores it in the web3 variable for future use. This ensures that only one instance of Web3 is created throughout the application, allowing for efficient resource usage and consistent access to the Web3 functionality.
 *
 * @returns {Web3} A singleton instance of the Web3 library, which can be used to interact with the Ethereum blockchain. This instance is created on demand and reused for subsequent calls to getWeb3, ensuring that only one instance exists throughout the application.
 */
export function getWeb3(): Web3 {
  if (!web3) {
    web3 = new Web3()
  }
  return web3!
}

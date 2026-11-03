declare global {
  interface Window {
    // Providers
    unisat?: UniSat
    okxwallet?: any
    XverseProviders?: any
    phantom?: { bitcoin?: unknown }
  }
}

interface UniSat {
  requestAccounts: () => Promise<string[]>
  getAccounts: () => Promise<string[]>
  on: (event: 'accountsChanged', handler: (accounts: string[]) => void) => void
  removeListener: (event: 'accountsChanged', handler: (accounts: string[]) => void) => void
  getNetwork: () => Promise<'livenet' | 'testnet'>
  switchNetwork: (network: string) => Promise<void>
  signMessage: (message: string, type?: 'ecdsa' | 'bip322-simple') => Promise<string>
  signPsbt: (psbt: any, options?: any) => Promise<string>
  /** Signs several PSBT hexes in one prompt; absent before UniSat added batch signing. */
  signPsbts?: (psbts: string[], options?: any[]) => Promise<string[]>
  pushPsbt: (psbt: any) => Promise<string>
  getPublicKey: () => Promise<string>
  sendBitcoin: (toAddress: string, amountSats: number) => Promise<string>
}

export {}

import type { ListenFn, RequestFn } from '@leather-wallet/types'

declare global {
  interface Window {
    // Providers
    unisat?: UniSat
    LeatherProvider?: {
      request: RequestFn
      listen: ListenFn
    }
    magicEden?: any
    okxwallet?: any
    XverseProviders?: any
  }
}

interface UniSat {
  requestAccounts: () => Promise<string[]>
  getNetwork: () => Promise<'livenet' | 'testnet'>
  switchNetwork: (network: string) => Promise<void>
  signMessage: (message: string, type?: 'ecdsa' | 'bip322-simple') => Promise<string>
  signPsbt: (psbt: any, options?: any) => Promise<string>
  pushPsbt: (psbt: any) => Promise<string>
  getPublicKey: () => Promise<string>
  sendBitcoin: (toAddress: string, amountSats: number) => Promise<string>
}

export {}

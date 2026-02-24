import {
  connect,
  disconnect,
  getCardinalBalance,
  getNetwork,
  getOrdinalsWallet,
  getPaymentWallet,
  getSession,
  init,
  sendBTC,
  setNetwork,
  signMessage,
} from './core/bis'

import { checkBaseBRC20Balance, checkSwapBalance } from './core/bis_swap'

import {
  callSmartContract,
  callSmartContractAbi,
  callSmartContractAbiFromPaymentWallet,
  deploySmartContract,
  deploySmartContractAbi,
  depositToBrc20Prog,
  getEvmAddressFromBitcoinAddress as getEvmAddressFromBtcAddress,
  withdrawFromBrc20Prog,
} from './core/brc20'

import {
  getInscribeMultipleFee,
  getMultiInscriptionWithBufferFeeRate,
  inscribe,
  InscriptionDetails,
  jsonInscription,
  sendMultiInscriptionWithBuffer,
  textInscription,
} from './core/mint'

import { modal as modalInner } from './core/modal'

import { saveWallet } from './provider/local'

// -------- Wallet API --------
export const wallet = {
  connect,
  disconnect,
  getCardinalBalance,
  getNetwork,
  setNetwork,
  getSession,
  getOrdinalsWallet,
  getPaymentWallet,
  useLocalWallet: saveWallet,
  sendBTC,
  signMessage,
}

// -------- Modal API --------
export const modal = {
  init,
  connect,
  disconnect,
  setNetwork,
  setTheme: modalInner.setTheme,
}

// -------- BRC20 API --------
export const brc20 = {
  callSmartContract,
  callSmartContractAbi,
  callSmartContractAbiFromPaymentWallet,
  deploySmartContract,
  deploySmartContractAbi,
  depositToBrc20Prog,
  getEvmAddressFromBtcAddress,
  withdrawFromBrc20Prog,
  checkBaseBRC20Balance,
}

// -------- Mint API --------
export const mint = {
  checkInscribeMultipleFee: getInscribeMultipleFee,
  getMultiInscriptionWithBufferFeeRate,
  inscribe,
  sendMultiInscriptionWithBuffer,
  InscriptionDetails,
  jsonInscription,
  textInscription,
}

// -------- Swap API --------
export const swap = {
  checkSwapBalance,
}

// ---- Types ----

export type { BaseBRC20Balance } from './core/bis_swap'

export type { SwapWalletInfo } from './core/store'

export type { LocalWalletSource, LocalWalletType } from './provider/local'

export type {
  BISNetwork,
  BISSession,
  BISWallet,
  BISWalletProvider,
  BISWalletPurpose,
  ConnectCallbacks,
  ModalTheme,
} from './types/common'

// Set up dev mode
if (import.meta.env.DEV) {
  // Mount Vue
  Promise.all([
    import('vue'),
    import('./components/Dev.vue'),
    import('./assets/dev/favicon.ico'),
  ]).then(([{ createApp }, { default: devTest }, faviconModule]) => {
    const app = createApp(devTest)
    app.mount('#app')

    // Set favicon
    const favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.href = faviconModule.default
    document.head.appendChild(favicon)
  })
}

/* eslint-disable perfectionist/sort-exports */
/* eslint-disable perfectionist/sort-named-exports */
import { createApp } from 'vue'

export {
  connect,
  disconnect,
  getCardinalBalance,
  getAllBalanceDetails,
  getNetwork,
  getOrdinalsWallet,
  getPaymentWallet,
  getSession,
  init,
  setNetwork,
  setTheme,
  sendBTC,
  signMessage,
  signMessageLocalVerify,
  signMessageLocalVerifyDeterministic,
} from './core/bis'

export type {
  BISNetwork,
  BISSession,
  BISWallet,
  BISWalletProvider,
  BISWalletPurpose,
  ConnectCallbacks,
  ModalTheme,
} from './types/common'

export type {
  LocalWalletSource,
  LocalWalletType,
} from './provider/local'

export {
  saveWallet as useLocalWallet,
} from './provider/local'

export { bitcoinjs } from './lib/bitcoin'
export { Buff } from '@cmdcode/buff-utils'
export { encode as cbor_encode } from 'cbor2'

export {
  checkBRC2_0BalanceOfPaymentWallet as checkBRC2_0BalanceOfPaymentWalletSwap,
  checkBRC2_0Balance as checkBRC2_0BalanceSwap,

  checkSwapStatus,

  getSwapWalletFromDB,
  generateAndStoreSwapWallet,

  requestMinerFee,

  checkPairReserves,
  checkSwapAllowance,
  checkSwapBalance,
  checkSwapBalances,

  checkBaseBRC20Balance,

  getKlines,
  getPairVolumeOverDays,
  getActivityOfPair,
  getWalletActivities,

  getSwapResult,
  prepareAndSendSwapOrder,
  getSwap2Result,
  prepareAndSendSwap2Order,

  getAddLiquidityResult,
  prepareAndSendAddLiquidityOrder,
  getRemoveLiquidityResult,
  prepareAndSendRemoveLiquidityOrder,

  checkMinerFeesOfWrapOrder,
  createAndBroadcastWrapOrder,
  getUnwrapResult,
  prepareAndSendUnwrapOrder,

  checkMinerFeesOfDepositOrder,
  createAndBroadcastDepositOrder,
  getWithdrawWithdrawToOrdinalWalletResult,
  getWithdrawWithdrawToSelfOrdinalWalletResult,
  prepareAndSendWithdrawOrderToOrdinalWallet,
  prepareAndSendWithdrawOrderToSelfOrdinalWallet,
} from './core/bis_swap'

export type {
  GetActivityOfPairRequest,
  GetActivityOfPairResponse,
  PairActivityEntry,
  GetWalletActivitiesResponse,
  WalletActivityEntry,
  CheckSwapBalancesItem,
} from './core/bis_swap'

export type {
  SwapWalletInfo,
} from './core/store'

export {
  call_smart_contract,
  call_smart_contract_abi,
  call_smart_contract_abi_from_payment_wallet,
  deploy_smart_contract,
  deploy_smart_contract_abi,
  deposit_to_brc20_prog,
  decodeFunctionResponseWithTypes as evm_decode_func_call_resp,
  evm_encode_deploy,
  evm_encode_func_call,
  evm_get_addr_from_btc_address,
  withdraw_from_brc20_prog,
} from './core/brc20'

export type { DecodedFnResponse } from './core/brc20'

export {
  checkInscribeMultipleFee,
  getMultiInscriptionWithBufferFeeRate,
  inscribe,
  inscribeMultiple,
  InscriptionDetails,
  sendMultiInscriptionWithBuffer,
} from './core/mint'

// Set up dev mode
if (import.meta.env.DEV) {
  // Mount Vue
  import('./components/Dev.vue').then(({ default: devTest }) => {
    const app = createApp(devTest)
    app.mount('#app')
  })

  // Set favicon
  import('./assets/dev/favicon.ico').then((module) => {
    const favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.href = module.default
    document.head.appendChild(favicon)
  })
}

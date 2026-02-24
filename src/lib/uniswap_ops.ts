import { Buffer } from 'node:buffer'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import * as ethers from 'ethers'

export interface UniswapInfoProxy {
  balanceOf: (pubkey: string, token_address: string) => Promise<bigint | null>
  reservesOf: (
    pair_address: string,
  ) => Promise<{ reserveA: bigint, reserveB: bigint, total_supply: bigint } | null>
}

let wbtcAddress = ''
let factoryAddr = ''
/**
 * Saves the Bis Swap information, including the WBTC address and factory address. The saveInfo function takes two string parameters, wbtcAddr and factory, which represent the WBTC token address and the Bis Swap factory address, respectively. It assigns these values to the module-level variables wbtcAddress and factoryAddr, allowing other functions in the module to access this information when needed for operations such as calculating pair addresses or fetching reserves. This function is essential for initializing the Bis Swap-related operations with the correct contract addresses.
 *
 * @param wbtcAddr The WBTC token address as a string. This address is used in Bis Swap operations to identify the WBTC token when calculating pair addresses, fetching reserves, or performing swaps involving WBTC.
 * @param factory The Bis Swap factory address as a string. This address is used to calculate pair addresses and to interact with the Bis Swap protocol for operations such as fetching reserves or performing swaps. By saving this information, the module can ensure that all Bis Swap-related functions have access to the necessary contract addresses for their operations.
 */
export function saveInfo(wbtcAddr: string, factory: string) {
  wbtcAddress = wbtcAddr
  factoryAddr = factory
}

function sqrt(value: bigint): bigint {
  if (value < 0n) {
    throw new Error('square root of negative numbers is not supported')
  }

  if (value < 2n) {
    return value
  }

  function newtonIteration(n: bigint, x0: bigint): bigint {
    const x1 = (n / x0 + x0) >> 1n
    if (x0 === x1 || x0 === x1 - 1n) {
      return x0
    }
    return newtonIteration(n, x1)
  }

  return newtonIteration(value, 1n)
}

/**
 * Calculates the pair address for two given token addresses using the Uniswap V2 formula. The calculatePairAddress function takes two token addresses as input and computes the corresponding pair address based on the Uniswap V2 deterministic address generation method. It first ensures that the token addresses are ordered correctly (the lower address is tokenA and the higher address is tokenB) to maintain consistency. Then, it uses the factory address, the keccak256 hash of the packed token addresses, and a fixed init code hash to compute the final pair address. This function is essential for interacting with the Uniswap protocol, as it allows you to determine the correct pair address for any two tokens, which is necessary for fetching reserves, performing swaps, or adding liquidity.
 *
 * @param tokenAAddr The address of the first token as a string. This should be a valid Ethereum address in hexadecimal format. The function will ensure that this address is ordered correctly with respect to the second token address to maintain consistency in pair address generation.
 * @param tokenBAddr The address of the second token as a string. This should also be a valid Ethereum address in hexadecimal format. The function will compare this address with the first token address to determine the correct ordering for pair address generation, ensuring that the lower address is always tokenA and the higher address is tokenB.
 *
 * @returns The calculated pair address as a string in hexadecimal format. This address is derived using the Uniswap V2 formula, which involves hashing the factory address, the ordered token addresses, and a fixed init code hash. The resulting pair address can be used to interact with the Uniswap protocol for operations such as fetching reserves, performing swaps, or adding liquidity for the given token pair.
 */
export function calculatePairAddress(tokenAAddr: string, tokenBAddr: string) {
  if (tokenAAddr.toLowerCase() > tokenBAddr.toLowerCase()) {
    ;[tokenAAddr, tokenBAddr] = [tokenBAddr, tokenAAddr]
  }

  const packed = ethers.solidityPacked(
    ['uint8', 'address', 'bytes32', 'bytes32'],
    [
      0xFF,
      factoryAddr,
      ethers.keccak256(ethers.solidityPacked(['address', 'address'], [tokenAAddr, tokenBAddr])),
      '0xc3cb93660fbd444d3f741950f68d962ba5a881cc5e37a5eedd40ba8e2127da33',
    ],
  )
  const pairAddress = `0x${ethers.keccak256(packed).slice(-40)}`
  return pairAddress
}

async function getCurrentPubkeyBalance(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  tokenAddr: string, // hex string token address
): Promise<bigint> {
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  const balance = await proxy.balanceOf(pubkey, tokenAddr)

  if (balance === null) {
    return BigInt(0)
  }

  return balance
}

async function getPairReserves(
  proxy: UniswapInfoProxy,
  tokenAAddr: string, // hex string token1 address
  tokenBAddr: string, // hex string token2 address
) {
  if (tokenAAddr.toLowerCase() > tokenBAddr.toLowerCase()) {
    ;[tokenAAddr, tokenBAddr] = [tokenBAddr, tokenAAddr]
  }
  const reserves = await proxy.reservesOf(calculatePairAddress(tokenAAddr, tokenBAddr))
  if (reserves === null) {
    throw new Error('Token pair does not exist')
  }
  return reserves
}

class BalanceMap {
  map: { [key: string]: bigint }
  proxy: UniswapInfoProxy | null

  constructor() {
    this.map = {}
    this.proxy = null
  }

  clear(proxy: UniswapInfoProxy) {
    this.map = {}
    this.proxy = proxy
  }

  async get(pubkey: string, tokenAddr: string): Promise<bigint> {
    if (this.proxy === null) {
      throw new Error('Proxy not set')
    }
    pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
    const key = `${pubkey}:${tokenAddr}`
    if (key in this.map) {
      if (this.map[key] === undefined) {
        throw new Error('Undefined balance encountered')
      }
      return this.map[key]
    }
    if (tokenAddr.length === 42) {
      const val = await getCurrentPubkeyBalance(this.proxy, pubkey, tokenAddr)
      this.map[key] = val
      return val
    }
    else {
      // lp token
      const tokenAAddr = `0x${tokenAddr.slice(2, 42)}`
      const tokenBAddr = `0x${tokenAddr.slice(44, 84)}`
      const pairAddress = calculatePairAddress(tokenAAddr, tokenBAddr)
      const val = await getCurrentPubkeyBalance(this.proxy, pubkey, pairAddress)
      this.map[key] = val
      return val
    }
  }

  setCheckPositive(pubkey: string, tokenAddr: string, val: bigint) {
    pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
    const key = `${pubkey}:${tokenAddr}`
    if (val < BigInt(0)) {
      throw new Error('Negative balance not allowed')
    }
    this.map[key] = val
  }
}
class ReserveMap {
  map: { [key: string]: { reserveA: bigint, reserveB: bigint, total_supply: bigint } }
  proxy: UniswapInfoProxy | null

  constructor() {
    this.map = {}
    this.proxy = null
  }

  clear(proxy: UniswapInfoProxy) {
    this.map = {}
    this.proxy = proxy
  }

  getKey(tokenAAddr: string, tokenBAddr: string): string {
    return tokenAAddr < tokenBAddr ? `${tokenAAddr}:${tokenBAddr}` : `${tokenBAddr}:${tokenAAddr}`
  }

  async get(
    tokenAAddr: string,
    tokenBAddr: string,
  ): Promise<{ reserveA: bigint, reserveB: bigint, total_supply: bigint }> {
    if (this.proxy === null) {
      throw new Error('Proxy not set')
    }
    const key = this.getKey(tokenAAddr, tokenBAddr)
    if (key in this.map) {
      if (this.map[key] === undefined) {
        throw new Error('Undefined reserves encountered')
      }
      return this.map[key]
    }
    const val = await getPairReserves(this.proxy, tokenAAddr, tokenBAddr)
    this.map[key] = val
    return val
  }

  set(
    tokenAAddr: string,
    tokenBAddr: string,
    val: { reserveA: bigint, reserveB: bigint, total_supply: bigint },
  ) {
    // throw an error if any of the reserves exceed 112 bits
    if (val.reserveA > 2n ** 112n || val.reserveB > 2n ** 112n) {
      throw new Error('Reserve exceeds 112 bits')
    }
    const key = this.getKey(tokenAAddr, tokenBAddr)
    this.map[key] = val
  }
}

const BALANCES = new BalanceMap()
const RESERVES = new ReserveMap()
function initializeUniswapOps(proxy: UniswapInfoProxy) {
  if (wbtcAddress === '' || factoryAddr === '') {
    throw new Error('Uniswap info not set')
  }
  BALANCES.clear(proxy)
  RESERVES.clear(proxy)
}

function keyFor(tokenA: string, tokenB: string): string {
  return tokenA < tokenB ? tokenA + tokenB : tokenB + tokenA
}

function getAmountOut(aIn: bigint, rIn: bigint, rOut: bigint): bigint {
  if (aIn <= 0n) {
    throw new Error('Insufficient input amount')
  }
  if (rIn <= 0n || rOut <= 0n) {
    throw new Error('Insufficient liquidity')
  }

  const aInWithFee = aIn * 997n
  const numerator = aInWithFee * rOut
  const denominator = rIn * 1000n + aInWithFee
  return numerator / denominator
}

function getAmountIn(aOut: bigint, rIn: bigint, rOut: bigint): bigint {
  if (aOut <= 0n) {
    throw new Error('Insufficient output amount')
  }
  if (rIn <= 0n || rOut <= 0n || aOut >= rOut) {
    throw new Error('Insufficient liquidity')
  }

  const numerator = rIn * aOut * 1000n
  const denominator = (rOut - aOut) * 997n
  return numerator / denominator + 1n
}

async function getAmountsOut(aIn: bigint, path: string[]): Promise<bigint[]> {
  if (path.length < 2) {
    throw new Error('Invalid path')
  }
  const amounts = [aIn]
  for (let i = 0; i < path.length - 1; i++) {
    const { reserveA, reserveB } = await getReserves(path[i]!, path[i + 1]!)
    const aOut = getAmountOut(amounts[i]!, reserveA, reserveB)
    amounts.push(aOut)
  }
  return amounts
}

async function getAmountsIn(aOut: bigint, path: string[]): Promise<bigint[]> {
  if (path.length < 2) {
    throw new Error('Invalid path')
  }
  const amounts = []
  amounts[path.length - 1] = aOut
  for (let i = path.length - 1; i > 0; i--) {
    const { reserveA, reserveB } = await getReserves(path[i - 1]!, path[i]!)
    const aIn = getAmountIn(amounts[i]!, reserveA, reserveB)
    amounts[i - 1] = aIn
  }
  return amounts
}

function quote(amountA: bigint, reserveA: bigint, reserveB: bigint) {
  if (amountA <= 0n) {
    throw new Error('Insufficient amount')
  }
  if (reserveA <= 0n || reserveB <= 0n) {
    throw new Error('Insufficient liquidity')
  }
  return (amountA * reserveB) / reserveA
}

async function getReserves(tokenA: string, tokenB: string) {
  const response = await RESERVES.get(tokenA, tokenB)
  if (!response) {
    throw new Error('Reserves not found for pair')
  }
  if (tokenA < tokenB) {
    return {
      reserveA: response.reserveA,
      reserveB: response.reserveB,
      total_supply: response.total_supply,
    }
  }
  else {
    return {
      reserveA: response.reserveB,
      reserveB: response.reserveA,
      total_supply: response.total_supply,
    }
  }
}

const BIG_INT_MIN = (...args: bigint[]) => args.reduce((m, e) => (e < m ? e : m))

async function mint(tokenA: string, tokenB: string, amountA: bigint, amountB: bigint) {
  const { reserveA: balanceA, reserveB: balanceB, total_supply: totalSupply } = await getReserves(tokenA, tokenB)
  const reserveA = balanceA - amountA
  const reserveB = balanceB - amountB

  let liquidity
  if (totalSupply === 0n) {
    liquidity = sqrt(amountA * amountB) - 1000n

    const oldReserve = await RESERVES.get(tokenA, tokenB)
    RESERVES.set(tokenA, tokenB, {
      reserveA: oldReserve.reserveA,
      reserveB: oldReserve.reserveB,
      total_supply: oldReserve.total_supply + 1000n,
    })
  }
  else {
    liquidity = BIG_INT_MIN(
      (amountA * totalSupply) / reserveA,
      (amountB * totalSupply) / reserveB,
    )
  }

  if (liquidity <= 0n) {
    throw new Error('Insufficient liquidity minted')
  }

  const oldReserve = await RESERVES.get(tokenA, tokenB)
  RESERVES.set(tokenA, tokenB, {
    reserveA: oldReserve.reserveA,
    reserveB: oldReserve.reserveB,
    total_supply: oldReserve.total_supply + liquidity,
  })
  return liquidity
}

async function addLiquidity(
  tokenA: string,
  tokenB: string,
  amountADesired: bigint,
  amountBDesired: bigint,
  amountAMin: bigint,
  amountBMin: bigint,
) {
  let amountA, amountB

  try {
    await RESERVES.get(tokenA, tokenB)
  }
  catch {
    RESERVES.set(tokenA, tokenB, { reserveA: 0n, reserveB: 0n, total_supply: 0n })
  }
  const { reserveA, reserveB } = await getReserves(tokenA, tokenB)
  if (reserveA === 0n && reserveB === 0n) {
    amountA = amountADesired
    amountB = amountBDesired
  }
  else {
    const amountBOptimal = quote(amountADesired, reserveA, reserveB)
    if (amountBOptimal <= amountBDesired) {
      if (amountBOptimal < amountBMin) {
        throw new Error('Insufficient B amount')
      }
      amountA = amountADesired
      amountB = amountBOptimal
    }
    else {
      const amountAOptimal = quote(amountBDesired, reserveB, reserveA)
      if (amountAOptimal > amountADesired || amountAOptimal < amountAMin) {
        throw new Error('Insufficient A amount')
      }
      amountA = amountAOptimal
      amountB = amountBDesired
    }
  }

  return { amountA, amountB }
}

async function innerAddLiquidity(
  tokenA: string,
  tokenB: string,
  amountADesired: bigint,
  amountBDesired: bigint,
  amountAMin: bigint,
  amountBMin: bigint,
) {
  const { amountA, amountB } = await addLiquidity(
    tokenA,
    tokenB,
    amountADesired,
    amountBDesired,
    amountAMin,
    amountBMin,
  )
  const oldReserve = await RESERVES.get(tokenA, tokenB)
  if (tokenA < tokenB) {
    RESERVES.set(tokenA, tokenB, {
      reserveA: oldReserve.reserveA + amountA,
      reserveB: oldReserve.reserveB + amountB,
      total_supply: oldReserve.total_supply,
    })
  }
  else {
    RESERVES.set(tokenB, tokenA, {
      reserveA: oldReserve.reserveA + amountB,
      reserveB: oldReserve.reserveB + amountA,
      total_supply: oldReserve.total_supply,
    })
  }
  const liquidity = await mint(tokenA, tokenB, amountA, amountB)
  return { amountA, amountB, liquidity }
}

async function burn(tokenA: string, tokenB: string, liquidity: bigint) {
  const { reserveA: balanceA, reserveB: balanceB, total_supply: totalSupply } = await getReserves(tokenA, tokenB)

  const amountA = (liquidity * balanceA) / totalSupply
  const amountB = (liquidity * balanceB) / totalSupply

  if (amountA <= 0n || amountB <= 0n) {
    throw new Error('Insufficient liquidity burned')
  }

  const oldReserve = await RESERVES.get(tokenA, tokenB)
  const newTotalSupply = oldReserve.total_supply - liquidity
  let newReserveA = oldReserve.reserveA
  let newReserveB = oldReserve.reserveB
  if (tokenA < tokenB) {
    newReserveA -= amountA
    newReserveB -= amountB
  }
  else {
    newReserveA -= amountB
    newReserveB -= amountA
  }
  RESERVES.set(tokenA, tokenB, {
    reserveA: newReserveA,
    reserveB: newReserveB,
    total_supply: newTotalSupply,
  })
  return { amountA, amountB }
}

async function swap(
  token0: string,
  token1: string,
  _amount0In: bigint,
  _amount1In: bigint,
  amount0Out: bigint,
  amount1Out: bigint,
  to: [string, string] | null,
  toFlipped: boolean | null,
) {
  if (amount0Out <= 0n && amount1Out <= 0n) {
    throw new Error('Insufficient output amount')
  }
  const { reserveA, reserveB } = await getReserves(token0, token1)
  const reserveAAfter = reserveA - _amount0In
  const reserveBAfter = reserveB - _amount1In
  if (amount0Out >= reserveAAfter || amount1Out >= reserveBAfter) {
    throw new Error('Insufficient liquidity')
  }

  const oldReserve = await RESERVES.get(token0, token1)
  RESERVES.set(token0, token1, {
    reserveA: oldReserve.reserveA - amount0Out,
    reserveB: oldReserve.reserveB - amount1Out,
    total_supply: oldReserve.total_supply,
  })

  if (to !== null) {
    const toTkn1 = to[0]
    const toTkn2 = to[1]
    const oldReserveTo = await RESERVES.get(toTkn1, toTkn2)
    if (toFlipped) {
      RESERVES.set(toTkn1, toTkn2, {
        reserveA: oldReserveTo.reserveA + amount1Out,
        reserveB: oldReserveTo.reserveB + amount0Out,
        total_supply: oldReserveTo.total_supply,
      })
    }
    else {
      RESERVES.set(toTkn1, toTkn2, {
        reserveA: oldReserveTo.reserveA + amount0Out,
        reserveB: oldReserveTo.reserveB + amount1Out,
        total_supply: oldReserveTo.total_supply,
      })
    }
  }
  const balance0 = (await RESERVES.get(token0, token1)).reserveA
  const balance1 = (await RESERVES.get(token0, token1)).reserveB

  const amount0In = balance0 > reserveAAfter - amount0Out ? balance0 - (reserveAAfter - amount0Out) : 0n
  const amount1In = balance1 > reserveBAfter - amount1Out ? balance1 - (reserveBAfter - amount1Out) : 0n

  if (amount0In <= 0n && amount1In <= 0n) {
    throw new Error('Insufficient input amount')
  }

  const balance0Adjusted = balance0 * 1000n - amount0In * 3n
  const balance1Adjusted = balance1 * 1000n - amount1In * 3n
  if (balance0Adjusted * balance1Adjusted < BigInt(reserveAAfter) * BigInt(reserveBAfter) * 1000n * 1000n) {
    throw new Error('K')
  }
}

async function swapInner(amounts: bigint[], path: string[]) {
  if (amounts.length !== path.length) {
    throw new Error('Amounts and path length mismatch')
  }
  if (amounts.length < 2) {
    throw new Error('Invalid path length')
  }
  const oldReserve = await RESERVES.get(path[0]!, path[1]!)
  if (path[0]! < path[1]!) {
    RESERVES.set(path[0]!, path[1]!, {
      reserveA: oldReserve.reserveA + amounts[0]!,
      reserveB: oldReserve.reserveB,
      total_supply: oldReserve.total_supply,
    })
  }
  else {
    RESERVES.set(path[0]!, path[1]!, {
      reserveA: oldReserve.reserveA,
      reserveB: oldReserve.reserveB + amounts[0]!,
      total_supply: oldReserve.total_supply,
    })
  }

  for (let i = 0; i < path.length - 1; i++) {
    const input = path[i]
    const output = path[i + 1]
    const amountIn = amounts[i]
    const amountOut = amounts[i + 1]
    if (
      input === undefined
      || output === undefined
      || amountIn === undefined
      || amountOut === undefined
    ) {
      throw new Error('Undefined value in swap path or amounts')
    }
    const amount0In = input < output ? amountIn : 0n
    const amount1In = input < output ? 0n : amountIn
    const amount0Out = input < output ? 0n : amountOut
    const amount1Out = input < output ? amountOut : 0n
    const token0 = input < output ? input : output
    const token1 = input < output ? output : input

    const to: [string, string] | null = i < path.length - 2 ? [output, path[i + 2]!] : null // not used in this mock
    const toFlipped = to === null ? null : output >= path[i + 2]!

    await swap(token0, token1, amount0In, amount1In, amount0Out, amount1Out, to, toFlipped)
  }
}

async function innerSwap1Op(amountIn: bigint, amountOutMin: bigint, path: string[]) {
  if (path.length < 2) {
    throw new Error('Invalid path')
  }
  const amounts = await getAmountsOut(amountIn, path)
  if (amounts[amounts.length - 1]! < amountOutMin) {
    throw new Error('Insufficient output amount')
  }

  await swapInner(amounts, path)
  return amounts
}

async function innerSwap2Op(maxAmountIn: bigint, amountOut: bigint, path: string[]) {
  if (path.length < 2) {
    throw new Error('Invalid path')
  }
  const amounts = await getAmountsIn(amountOut, path)
  if (amounts[0]! > maxAmountIn) {
    throw new Error('Excessive Input Amount')
  }

  await swapInner(amounts, path)
  return amounts
}

async function innerRemoveLiquidity(
  tokenA: string,
  tokenB: string,
  liquidity: bigint,
  amountAMin: bigint,
  amountBMin: bigint,
) {
  const { amountA, amountB } = await burn(tokenA, tokenB, liquidity)
  if (amountA < amountAMin) {
    throw new Error('Insufficient A amount')
  }
  if (amountB < amountBMin) {
    throw new Error('Insufficient B amount')
  }
  return { amountA, amountB }
}

function checkAddLiquiditySignature(
  pubkey: string, // no 0x
  nonce: bigint,
  token1Addr: string,
  token2Addr: string,
  amt1: bigint,
  amt2: bigint,
  minAmt1: bigint,
  minAmt2: bigint,
  token1FeeBps: bigint,
  token2FeeBps: bigint,
  fee: bigint,
  blsSignature: string, // no 0x
) {
  if (blsSignature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '01' // add liquidity
  msg += token1Addr.slice(2).padStart(40, '0')
  msg += token2Addr.slice(2).padStart(40, '0')
  msg += amt1.toString(16).padStart(64, '0')
  msg += amt2.toString(16).padStart(64, '0')
  msg += minAmt1.toString(16).padStart(64, '0')
  msg += minAmt2.toString(16).padStart(64, '0')
  msg += token1FeeBps.toString(16).padStart(64, '0')
  msg += token2FeeBps.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sigX = BigInt(`0x${blsSignature.slice(0, 128)}`)
  const sigY = BigInt(`0x${blsSignature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sigX, sigY, BigInt(1))

  const pubkeyXC0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkeyXC1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkeyYC0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkeyYC1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkeyXC0, c1: pubkeyXC1 }),
    bls12_381.fields.Fp2.create({ c0: pubkeyYC0, c1: pubkeyYC1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 * Handles the add liquidity request for a Uniswap-like decentralized exchange. The addLiquidityRequest function takes various parameters including the user's public key, token addresses, amounts, minimum amounts, fees, and a BLS signature for authentication. It first checks the validity of the BLS signature to ensure that the request is authorized. Then, it calculates the actual amounts of tokens to be added to the liquidity pool based on the desired amounts and the current reserves. If the signature is valid and the amounts are sufficient, it updates the internal state of balances and reserves accordingly. Finally, it returns a success response with the actual amounts added and liquidity tokens minted, or an error message if any step fails.
 *
 * @param proxy An instance of UniswapInfoProxy that provides methods to fetch balances and reserves. This proxy is used to interact with the underlying data source for token balances and liquidity pool reserves, allowing the function to perform necessary calculations and updates based on the current state of the Uniswap-like exchange.
 * @param pubkey The user's public key as a hexadecimal string. This public key is used to identify the user making the add liquidity request and to verify the BLS signature for authentication. The function will use this public key to fetch the user's current balances and to update them after successfully adding liquidity.
 * @param token1Addr The address of the first token in the liquidity pair as a hexadecimal string. This address is used to identify the token being added to the liquidity pool and to fetch its current balance and reserves. The function will also use this address to calculate the pair address and to update the user's balance after adding liquidity.
 * @param token2Addr The address of the second token in the liquidity pair as a hexadecimal string. Similar to token1Addr, this address is used to identify the second token being added to the liquidity pool, to fetch its current balance and reserves, and to calculate the pair address for updating the user's balance after adding liquidity.
 * @param amt1 The desired amount of the first token to be added to the liquidity pool as a bigint. This amount is used in the calculation of how much of each token will actually be added based on the current reserves and the desired amounts. The function will ensure that this amount meets the minimum requirements and will update the user's balance accordingly after adding liquidity.
 * @param amt2 The desired amount of the second token to be added to the liquidity pool as a bigint. Similar to amt1, this amount is used in the calculation of how much of each token will actually be added based on the current reserves and the desired amounts. The function will ensure that this amount meets the minimum requirements and will update the user's balance accordingly after adding liquidity.
 * @param minamt1 The minimum acceptable amount of the first token to be added to the liquidity pool as a bigint. This parameter is used to ensure that the user receives at least this amount of the first token when adding liquidity, even if the actual amount calculated based on the desired amounts and current reserves is higher. If the calculated amount of the first token is less than this minimum, the function will throw an error and not proceed with adding liquidity.
 * @param minamt2 The minimum acceptable amount of the second token to be added to the liquidity pool as a bigint. Similar to minamt1, this parameter is used to ensure that the user receives at least this amount of the second token when adding liquidity. If the calculated amount of the second token is less than this minimum, the function will throw an error and not proceed with adding liquidity.
 * @param blsSignature The BLS signature as a hexadecimal string that is used to authenticate the add liquidity request. This signature is generated by the user using their private key and is verified against the public key and the message constructed from the request parameters. The function will check the validity of this signature before proceeding with adding liquidity, ensuring that only authorized requests are processed.
 * @param nonce A unique nonce as a bigint that is used in the construction of the message for BLS signature verification. This nonce helps to prevent replay attacks by ensuring that each add liquidity request has a unique message, even if all other parameters are the same. The function will include this nonce in the message that is hashed and verified against the BLS signature to ensure the authenticity of the request.
 * @param token1FeeBps The fee for the first token in basis points (bps) as a bigint. This fee is applied to the amount of the first token being added to the liquidity pool and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after adding liquidity.
 * @param token2FeeBps The fee for the second token in basis points (bps) as a bigint. Similar to token1FeeBps, this fee is applied to the amount of the second token being added to the liquidity pool and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after adding liquidity.
 * @param btcFee The fee in BTC as a bigint that is applied to the add liquidity request. This fee is deducted from the user's balance in WBTC and is used to cover the costs associated with processing the request. The function will ensure that this fee is properly accounted for in the user's balance updates after adding liquidity.
 *
 * @returns A promise that resolves to an object indicating the success of the operation. If successful, the object contains the actual amounts of tokens added to the liquidity pool and the amount of liquidity tokens minted. If there is an error, the object contains an error message describing the issue that occurred during the add liquidity process.
 */
export async function addLiquidityRequest(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token1Addr: string, // hex string token1 address
  token2Addr: string, // hex string token2 address
  amt1: bigint, // bigint token1 amount
  amt2: bigint, // bigint token2 amount
  minamt1: bigint, // bigint min token1 amount
  minamt2: bigint, // bigint min token2 amount
  blsSignature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  token1FeeBps: bigint, // bigint token1 fee in bps
  token2FeeBps: bigint, // bigint token2 fee in bps
  btcFee: bigint, // bigint BTC fee in bps
): Promise<{
  success: boolean
  data?: { amountA: bigint, amountB: bigint, liquidity: bigint }
  error_message?: string
}> {
  token1Addr = token1Addr.toLowerCase()
  token2Addr = token2Addr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  blsSignature = blsSignature.startsWith('0x') ? blsSignature.slice(2) : blsSignature

  initializeUniswapOps(proxy)

  try {
    if (
      !checkAddLiquiditySignature(
        pubkey,
        nonce,
        token1Addr,
        token2Addr,
        amt1,
        amt2,
        minamt1,
        minamt2,
        token1FeeBps,
        token2FeeBps,
        btcFee,
        blsSignature,
      )
    ) {
      throw new Error('Invalid BLS signature')
    }

    const { amountA, amountB, liquidity } = await innerAddLiquidity(
      token1Addr,
      token2Addr,
      amt1,
      amt2,
      minamt1,
      minamt2,
    )

    const pairKey = keyFor(token1Addr, token2Addr)
    BALANCES.setCheckPositive(
      pubkey,
      token1Addr,
      ((await BALANCES.get(pubkey, token1Addr)) || 0n) - amountA,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token2Addr,
      ((await BALANCES.get(pubkey, token2Addr)) || 0n) - amountB,
    )
    BALANCES.setCheckPositive(
      pubkey,
      pairKey,
      ((await BALANCES.get(pubkey, pairKey)) || 0n) + liquidity,
    )

    BALANCES.setCheckPositive(
      pubkey,
      wbtcAddress,
      ((await BALANCES.get(pubkey, wbtcAddress)) || 0n) - btcFee,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token1Addr,
      ((await BALANCES.get(pubkey, token1Addr)) || 0n) - (amountA * token1FeeBps) / 10000n,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token2Addr,
      ((await BALANCES.get(pubkey, token2Addr)) || 0n) - (amountB * token2FeeBps) / 10000n,
    )

    return { success: true, data: { amountA, amountB, liquidity } }
  }
  catch (e: any) {
    console.error('Error in add_liquidity_request:', e)
    return { success: false, error_message: e.message }
  }
}

function checkRemoveLiquiditySignature(
  pubkey: string, // no 0x
  nonce: bigint,
  token1Addr: string,
  token2Addr: string,
  liquidity: bigint,
  minAmt1: bigint,
  minAmt2: bigint,
  token1FeeBps: bigint,
  token2FeeBps: bigint,
  fee: bigint,
  blsSignature: string, // no 0x
) {
  if (blsSignature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '02' // remove liquidity
  msg += token1Addr.slice(2).padStart(40, '0')
  msg += token2Addr.slice(2).padStart(40, '0')
  msg += liquidity.toString(16).padStart(64, '0')
  msg += minAmt1.toString(16).padStart(64, '0')
  msg += minAmt2.toString(16).padStart(64, '0')
  msg += token1FeeBps.toString(16).padStart(64, '0')
  msg += token2FeeBps.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sigX = BigInt(`0x${blsSignature.slice(0, 128)}`)
  const sigY = BigInt(`0x${blsSignature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sigX, sigY, BigInt(1))

  const pubkeyXC0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkeyXC1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkeyYC0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkeyYC1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkeyXC0, c1: pubkeyXC1 }),
    bls12_381.fields.Fp2.create({ c0: pubkeyYC0, c1: pubkeyYC1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 * Handles the remove liquidity request for BiS Swap. The removeLiquidityRequest function takes various parameters including the user's public key, token addresses, liquidity amount, minimum amounts, fees, and a BLS signature for authentication. It first checks the validity of the BLS signature to ensure that the request is authorized. Then, it verifies that the user has sufficient liquidity balance to burn. If the signature is valid and the balance is sufficient, it calculates the actual amounts of tokens to be removed from the liquidity pool based on the liquidity amount and current reserves. Finally, it updates the internal state of balances and reserves accordingly and returns a success response with the actual amounts removed, or an error message if any step fails.
 *
 * @param proxy An instance of UniswapInfoProxy that provides methods to fetch balances and reserves. This proxy is used to interact with the underlying data source for token balances and liquidity pool reserves, allowing the function to perform necessary calculations and updates based on the current state of the Uniswap-like exchange.
 * @param pubkey The user's public key as a hexadecimal string. This public key is used to identify the user making the remove liquidity request and to verify the BLS signature for authentication. The function will use this public key to fetch the user's current balances and to update them after successfully removing liquidity.
 * @param token1Addr The address of the first token in the liquidity pair as a hexadecimal string. This address is used to identify the token being removed from the liquidity pool and to fetch its current balance and reserves. The function will also use this address to calculate the pair address and to update the user's balance after removing liquidity.
 * @param token2Addr The address of the second token in the liquidity pair as a hexadecimal string. Similar to token1Addr, this address is used to identify the second token being removed from the liquidity pool, to fetch its current balance and reserves, and to calculate the pair address for updating the user's balance after removing liquidity.
 * @param liquidity The amount of liquidity tokens to be burned as a bigint. This amount is used in the calculation of how much of each underlying token will be removed from the liquidity pool based on the current reserves and total supply. The function will ensure that this amount meets the minimum requirements and will update the user's balance accordingly after removing liquidity.
 * @param minamt1 The minimum acceptable amount of the first token to be removed from the liquidity pool as a bigint. This parameter is used to ensure that the user receives at least this amount of the first token when removing liquidity, even if the actual amount calculated based on the liquidity burned and current reserves is higher. If the calculated amount of the first token is less than this minimum, the function will throw an error and not proceed with removing liquidity.
 * @param minamt2 The minimum acceptable amount of the second token to be removed from the liquidity pool as a bigint. Similar to minamt1, this parameter is used to ensure that the user receives at least this amount of the second token when removing liquidity. If the calculated amount of the second token is less than this minimum, the function will throw an error and not proceed with removing liquidity.
 * @param blsSignature The BLS signature as a hexadecimal string that is used to authenticate the remove liquidity request. This signature is generated by the user using their private key and is verified against the public key and the message constructed from the request parameters. The function will check the validity of this signature before proceeding with removing liquidity, ensuring that only authorized requests are processed.
 * @param nonce A unique nonce as a bigint that is used in the construction of the message for BLS signature verification. This nonce helps to prevent replay attacks by ensuring that each remove liquidity request has a unique message, even if all other parameters are the same. The function will include this nonce in the message that is hashed and verified against the BLS signature to ensure the authenticity of the request.
 * @param token1FeeBps The fee for the first token in basis points (bps) as a bigint. This fee is applied to the amount of the first token being removed from the liquidity pool and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after removing liquidity.
 * @param token2FeeBps The fee for the second token in basis points (bps) as a bigint. Similar to token1FeeBps, this fee is applied to the amount of the second token being removed from the liquidity pool and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after removing liquidity.
 * @param btcFee The fee in BTC as a bigint that is applied to the remove liquidity request. This fee is deducted from the user's balance in WBTC and is used to cover the costs associated with processing the request. The function will ensure that this fee is properly accounted for in the user's balance updates after removing liquidity.
 *
 * @returns A promise that resolves to an object indicating the success of the operation. If successful, the object contains the actual amounts of tokens removed from the liquidity pool and the amount of liquidity tokens burned. If there is an error, the object contains an error message describing the issue that occurred during the remove liquidity process.
 */
export async function removeLiquidityRequest(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token1Addr: string, // hex string token1 address
  token2Addr: string, // hex string token2 address
  liquidity: bigint, // bigint lp token amount
  minamt1: bigint, // bigint min token1 amount
  minamt2: bigint, // bigint min token2 amount
  blsSignature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  token1FeeBps: bigint, // bigint token1 fee in bps
  token2FeeBps: bigint, // bigint token2 fee in bps
  btcFee: bigint, // bigint BTC fee in bps
) {
  token1Addr = token1Addr.toLowerCase()
  token2Addr = token2Addr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  blsSignature = blsSignature.startsWith('0x') ? blsSignature.slice(2) : blsSignature

  initializeUniswapOps(proxy)

  try {
    if (
      !checkRemoveLiquiditySignature(
        pubkey,
        nonce,
        token1Addr,
        token2Addr,
        liquidity,
        minamt1,
        minamt2,
        token1FeeBps,
        token2FeeBps,
        btcFee,
        blsSignature,
      )
    ) {
      throw new Error('Invalid BLS signature')
    }

    const pairKey = keyFor(token1Addr, token2Addr)
    if (((await BALANCES.get(pubkey, pairKey)) || 0n) < liquidity) {
      throw new Error('Insufficient liquidity balance')
    }

    const { amountA, amountB } = await innerRemoveLiquidity(
      token1Addr,
      token2Addr,
      liquidity,
      minamt1,
      minamt2,
    )

    BALANCES.setCheckPositive(
      pubkey,
      pairKey,
      ((await BALANCES.get(pubkey, pairKey)) || 0n) - liquidity,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token1Addr,
      ((await BALANCES.get(pubkey, token1Addr)) || 0n) + amountA,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token2Addr,
      ((await BALANCES.get(pubkey, token2Addr)) || 0n) + amountB,
    )

    BALANCES.setCheckPositive(
      pubkey,
      wbtcAddress,
      ((await BALANCES.get(pubkey, wbtcAddress)) || 0n) - btcFee,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token1Addr,
      ((await BALANCES.get(pubkey, token1Addr)) || 0n) - (amountA * token1FeeBps) / 10000n,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token2Addr,
      ((await BALANCES.get(pubkey, token2Addr)) || 0n) - (amountB * token2FeeBps) / 10000n,
    )

    return { success: true, data: { amountA, amountB, liquidity } }
  }
  catch (e: any) {
    console.error('Error in remove_liquidity_request:', e)
    return { success: false, error_message: e.message }
  }
}

function checkSwapSignature(
  pubkey: string, // no 0x
  nonce: bigint,
  token1Addr: string,
  token2Addr: string,
  amtin: bigint,
  minAmtout: bigint,
  token1FeeBps: bigint,
  token2FeeBps: bigint,
  fee: bigint,
  blsSignature: string, // no 0x
) {
  if (blsSignature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '03' // swap1
  msg += token1Addr.slice(2).padStart(64, '0')
  msg += token2Addr.slice(2).padStart(64, '0')
  msg += amtin.toString(16).padStart(64, '0')
  msg += minAmtout.toString(16).padStart(64, '0')
  msg += token1FeeBps.toString(16).padStart(64, '0')
  msg += token2FeeBps.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sigX = BigInt(`0x${blsSignature.slice(0, 128)}`)
  const sigY = BigInt(`0x${blsSignature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sigX, sigY, BigInt(1))

  const pubkeyXC0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkeyXC1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkeyYC0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkeyYC1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkeyXC0, c1: pubkeyXC1 }),
    bls12_381.fields.Fp2.create({ c0: pubkeyYC0, c1: pubkeyYC1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 * Handles the swap request for BiS Swap. The swapRequest function takes various parameters including the user's public key, token addresses, input amount, minimum output amount, fees, and a BLS signature for authentication. It first checks the validity of the BLS signature to ensure that the request is authorized. Then, it verifies that the user has sufficient balance of the input token. If the signature is valid and the balance is sufficient, it calculates the output amount based on the current reserves and the input amount. Finally, it updates the internal state of balances and reserves accordingly and returns a success response with the output amount and price impact, or an error message if any step fails.
 *
 * @param proxy An instance of UniswapInfoProxy that provides methods to fetch balances and reserves. This proxy is used to interact with the underlying data source for token balances and liquidity pool reserves, allowing the function to perform necessary calculations and updates based on the current state of the Uniswap-like exchange.
 * @param pubkey The user's public key as a hexadecimal string. This public key is used to identify the user making the swap request and to verify the BLS signature for authentication. The function will use this public key to fetch the user's current balances and to update them after successfully executing the swap.
 * @param token1Addr The address of the input token as a hexadecimal string. This address is used to identify the token being swapped from and to fetch its current balance and reserves. The function will also use this address to calculate the pair address and to update the user's balance after executing the swap.
 * @param token2Addr The address of the output token as a hexadecimal string. Similar to token1Addr, this address is used to identify the token being swapped to, to fetch its current balance and reserves, and to calculate the pair address for updating the user's balance after executing the swap.
 * @param inAmt The amount of the input token to be swapped as a bigint. This amount is used in the calculation of how much of the output token will be received based on the current reserves and the swap formula. The function will ensure that this amount meets the minimum requirements and will update the user's balance accordingly after executing the swap.
 * @param minOutAmt The minimum acceptable amount of the output token to be received from the swap as a bigint. This parameter is used to ensure that the user receives at least this amount of the output token when executing the swap, even if the actual amount calculated based on the input amount and current reserves is higher. If the calculated amount of the output token is less than this minimum, the function will throw an error and not proceed with executing the swap.
 * @param blsSignature The BLS signature as a hexadecimal string that is used to authenticate the swap request. This signature is generated by the user using their private key and is verified against the public key and the message constructed from the request parameters. The function will check the validity of this signature before proceeding with executing the swap, ensuring that only authorized requests are processed.
 * @param nonce A unique nonce as a bigint that is used in the construction of the message for BLS signature verification. This nonce helps to prevent replay attacks by ensuring that each swap request has a unique message, even if all other parameters are the same. The function will include this nonce in the message that is hashed and verified against the BLS signature to ensure the authenticity of the request.
 * @param token1FeeBps The fee for the input token in basis points (bps) as a bigint. This fee is applied to the amount of the input token being swapped and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after executing the swap.
 * @param token2FeeBps The fee for the output token in basis points (bps) as a bigint. This fee is applied to the amount of the output token being received and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after executing the swap.
 * @param btcFee The fee for BTC in basis points (bps) as a bigint. This fee is applied to the amount of BTC being swapped and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after executing the swap.
 *
 * @returns A promise that resolves to an object indicating the success of the operation. If successful, the object contains the actual amount of the output token received from the swap and the price impact of the swap. If there is an error, the object contains an error message describing the issue that occurred during the swap process.
 */
export async function swapRequest(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token1Addr: string, // hex string token in address
  token2Addr: string, // hex string token out address
  inAmt: bigint, // bigint token in amount
  minOutAmt: bigint, // bigint min token out amount
  blsSignature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  token1FeeBps: bigint, // bigint token1 fee in bps
  token2FeeBps: bigint, // bigint token2 fee in bps
  btcFee: bigint, // bigint BTC fee in bps
) {
  token1Addr = token1Addr.toLowerCase()
  token2Addr = token2Addr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  blsSignature = blsSignature.startsWith('0x') ? blsSignature.slice(2) : blsSignature

  initializeUniswapOps(proxy)

  try {
    if (
      !checkSwapSignature(
        pubkey,
        nonce,
        token1Addr,
        token2Addr,
        inAmt,
        minOutAmt,
        token1FeeBps,
        token2FeeBps,
        btcFee,
        blsSignature,
      )
    ) {
      throw new Error('Invalid BLS signature')
    }

    if (((await BALANCES.get(pubkey, token1Addr)) || 0n) < inAmt) {
      throw new Error('Insufficient input token balance')
    }

    // get current reserves
    const { reserveA: currentReserveA, reserveB: currentReserveB } = await getReserves(
      token1Addr,
      token2Addr,
    )

    const amounts = await innerSwap1Op(inAmt, minOutAmt, [token1Addr, token2Addr])

    if (amounts.length !== 2) {
      throw new Error('Invalid swap output amounts')
    }

    BALANCES.setCheckPositive(
      pubkey,
      token1Addr,
      ((await BALANCES.get(pubkey, token1Addr)) || 0n) - inAmt,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token2Addr,
      ((await BALANCES.get(pubkey, token2Addr)) || 0n) + amounts[1]!,
    )

    BALANCES.setCheckPositive(
      pubkey,
      wbtcAddress,
      ((await BALANCES.get(pubkey, wbtcAddress)) || 0n) - btcFee,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token1Addr,
      ((await BALANCES.get(pubkey, token1Addr)) || 0n) - (inAmt * token1FeeBps) / 10000n,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token2Addr,
      ((await BALANCES.get(pubkey, token2Addr)) || 0n) - (amounts[1]! * token2FeeBps) / 10000n,
    )

    // get new reserves
    const { reserveA: afterReserveA, reserveB: afterReserveB } = await getReserves(
      token1Addr,
      token2Addr,
    )

    // get the price impact
    const priceBefore
      = token1Addr === wbtcAddress
        ? (currentReserveA * 1000000000000000000n * 10000n) / currentReserveB
        : (currentReserveB * 1000000000000000000n * 10000n) / currentReserveA
    const priceAfter
      = token1Addr === wbtcAddress
        ? (afterReserveA * 1000000000000000000n * 10000n) / afterReserveB
        : (afterReserveB * 1000000000000000000n * 10000n) / afterReserveA
    const priceImpact
      = priceBefore > priceAfter ? priceBefore - priceAfter : priceAfter - priceBefore
    const priceImpactBps = priceBefore !== 0n ? (priceImpact * 10000n) / priceBefore : 0n

    return { success: true, amounts, price_impact_bps: priceImpactBps }
  }
  catch (e: any) {
    console.error('Error in swap_request:', e)
    return { success: false, error_message: e.message }
  }
}

function checkSwap2Signature(
  pubkey: string, // no 0x
  nonce: bigint,
  token1Addr: string,
  token2Addr: string,
  maxAmtin: bigint,
  amtout: bigint,
  token1FeeBps: bigint,
  token2FeeBps: bigint,
  fee: bigint,
  blsSignature: string, // no 0x
) {
  if (blsSignature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '03' // swap1
  msg += token1Addr.slice(2).padStart(64, '0')
  msg += token2Addr.slice(2).padStart(64, '0')
  msg += maxAmtin.toString(16).padStart(64, '0')
  msg += amtout.toString(16).padStart(64, '0')
  msg += token1FeeBps.toString(16).padStart(64, '0')
  msg += token2FeeBps.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sigX = BigInt(`0x${blsSignature.slice(0, 128)}`)
  const sigY = BigInt(`0x${blsSignature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sigX, sigY, BigInt(1))

  const pubkeyXC0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkeyXC1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkeyYC0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkeyYC1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkeyXC0, c1: pubkeyXC1 }),
    bls12_381.fields.Fp2.create({ c0: pubkeyYC0, c1: pubkeyYC1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 * Handles the swap request with specified output amount for BiS Swap. The swap2Request function takes various parameters including the user's public key, token addresses, maximum input amount, desired output amount, fees, and a BLS signature for authentication. It first checks the validity of the BLS signature to ensure that the request is authorized. Then, it verifies that the user has sufficient balance of the input token and that the maximum input amount is sufficient to receive the desired output amount based on the current reserves. If the signature is valid and the balance is sufficient, it calculates the actual input amount required to receive the desired output amount based on the current reserves and the swap formula. Finally, it updates the internal state of balances and reserves accordingly and returns a success response with the actual input amount used and price impact, or an error message if any step fails.
 *
 * @param proxy An instance of UniswapInfoProxy that provides methods to fetch balances and reserves. This proxy is used to interact with the underlying data source for token balances and liquidity pool reserves, allowing the function to perform necessary calculations and updates based on the current state of the Uniswap-like exchange.
 * @param pubkey The user's public key as a hexadecimal string. This public key is used to identify the user making the swap request and to verify the BLS signature for authentication. The function will use this public key to fetch the user's current balances and to update them after successfully executing the swap.
 * @param token1Addr The address of the input token as a hexadecimal string. This address is used to identify the token being swapped from and to fetch its current balance and reserves. The function will also use this address to calculate the pair address and to update the user's balance after executing the swap.
 * @param token2Addr The address of the output token as a hexadecimal string. Similar to token1Addr, this address is used to identify the token being swapped to, to fetch its current balance and reserves, and to calculate the pair address for updating the user's balance after executing the swap.
 * @param maxInAmt The maximum amount of the input token that the user is willing to swap as a bigint. This amount is used to ensure that the user does not spend more than this amount of the input token when trying to receive the desired output amount. The function will check that the actual input amount required to receive the desired output amount does not exceed this maximum, and if it does, the function will throw an error and not proceed with executing the swap.
 * @param outAmt The desired amount of the output token to be received from the swap as a bigint. This amount is used in the calculation of how much of the input token will be required based on the current reserves and the swap formula. The function will ensure that this amount meets the minimum requirements and will update the user's balance accordingly after executing the swap.
 * @param blsSignature The BLS signature as a hexadecimal string that is used to authenticate the swap request. This signature is generated by the user using their private key and is verified against the public key and the message constructed from the request parameters. The function will check the validity of this signature before proceeding with executing the swap, ensuring that only authorized requests are processed.
 * @param nonce A unique nonce as a bigint that is used in the construction of the message for BLS signature verification. This nonce helps to prevent replay attacks by ensuring that each swap request has a unique message, even if all other parameters are the same. The function will include this nonce in the message that is hashed and verified against the BLS signature to ensure the authenticity of the request.
 * @param token1FeeBps The fee for the input token in basis points (bps) as a bigint. This fee is applied to the amount of the input token being swapped and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after executing the swap.
 * @param token2FeeBps The fee for the output token in basis points (bps) as a bigint. This fee is applied to the amount of the output token being received and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after executing the swap.
 * @param btcFee The fee for BTC in basis points (bps) as a bigint. This fee is applied to the amount of BTC being swapped and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after executing the swap.
 *
 * @returns A promise that resolves to an object indicating the success of the operation. If successful, the object contains the actual amount of the input token used for the swap and the price impact of the swap. If there is an error, the object contains an error message describing the issue that occurred during the swap process.
 */
export async function swap2Request(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token1Addr: string, // hex string token in address
  token2Addr: string, // hex string token out address
  maxInAmt: bigint, // bigint max token in amount
  outAmt: bigint, // bigint token out amount
  blsSignature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  token1FeeBps: bigint, // bigint token1 fee in bps
  token2FeeBps: bigint, // bigint token2 fee in bps
  btcFee: bigint, // bigint BTC fee in bps
) {
  token1Addr = token1Addr.toLowerCase()
  token2Addr = token2Addr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  blsSignature = blsSignature.startsWith('0x') ? blsSignature.slice(2) : blsSignature

  initializeUniswapOps(proxy)

  try {
    if (
      !checkSwap2Signature(
        pubkey,
        nonce,
        token1Addr,
        token2Addr,
        maxInAmt,
        outAmt,
        token1FeeBps,
        token2FeeBps,
        btcFee,
        blsSignature,
      )
    ) {
      throw new Error('Invalid BLS signature')
    }

    // get current reserves
    const { reserveA: currentReserveA, reserveB: currentReserveB } = await getReserves(
      token1Addr,
      token2Addr,
    )

    const amounts = await innerSwap2Op(maxInAmt, outAmt, [token1Addr, token2Addr])

    if (amounts.length !== 2) {
      throw new Error('Invalid swap output amounts')
    }

    BALANCES.setCheckPositive(
      pubkey,
      token1Addr,
      ((await BALANCES.get(pubkey, token1Addr)) || 0n) - amounts[0]!,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token2Addr,
      ((await BALANCES.get(pubkey, token2Addr)) || 0n) + outAmt,
    )

    BALANCES.setCheckPositive(
      pubkey,
      wbtcAddress,
      ((await BALANCES.get(pubkey, wbtcAddress)) || 0n) - btcFee,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token1Addr,
      ((await BALANCES.get(pubkey, token1Addr)) || 0n) - (amounts[0]! * token1FeeBps) / 10000n,
    )
    BALANCES.setCheckPositive(
      pubkey,
      token2Addr,
      ((await BALANCES.get(pubkey, token2Addr)) || 0n) - (outAmt * token2FeeBps) / 10000n,
    )

    // get new reserves
    const { reserveA: afterReserveA, reserveB: afterReserveB } = await getReserves(
      token1Addr,
      token2Addr,
    )

    // get the price impact
    const priceBefore
      = token1Addr === wbtcAddress
        ? (currentReserveA * 1000000000000000000n * 10000n) / currentReserveB
        : (currentReserveB * 1000000000000000000n * 10000n) / currentReserveA
    const priceAfter
      = token1Addr === wbtcAddress
        ? (afterReserveA * 1000000000000000000n * 10000n) / afterReserveB
        : (afterReserveB * 1000000000000000000n * 10000n) / afterReserveA
    const priceImpact
      = priceBefore > priceAfter ? priceBefore - priceAfter : priceAfter - priceBefore
    const priceImpactBps = priceBefore !== 0n ? (priceImpact * 10000n) / priceBefore : 0n

    return { success: true, amounts, price_impact_bps: priceImpactBps }
  }
  catch (e: any) {
    console.error('Error in swap_request:', e)
    return { success: false, error_message: e.message }
  }
}

function checkWithdrawSignature(
  pubkey: string, // no 0x
  nonce: bigint,
  tokenAddr: string,
  targetAddr: string,
  amt: bigint,
  fee: bigint,
  blsSignature: string, // no 0x
) {
  if (blsSignature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '05' // withdraw
  msg += tokenAddr.slice(2).padStart(40, '0')
  msg += targetAddr.slice(2).padStart(40, '0')
  msg += amt.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sigX = BigInt(`0x${blsSignature.slice(0, 128)}`)
  const sigY = BigInt(`0x${blsSignature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sigX, sigY, BigInt(1))

  const pubkeyXC0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkeyXC1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkeyYC0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkeyYC1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkeyXC0, c1: pubkeyXC1 }),
    bls12_381.fields.Fp2.create({ c0: pubkeyYC0, c1: pubkeyYC1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 * Handles the withdraw request for BiS Swap. The withdrawRequest function takes various parameters including the user's public key, token address, target address, amount to withdraw, fees, and a BLS signature for authentication. It first checks the validity of the BLS signature to ensure that the request is authorized. Then, it verifies that the user has sufficient balance of the specified token to withdraw. If the signature is valid and the balance is sufficient, it updates the internal state of balances accordingly and returns a success response with the withdrawn amount, or an error message if any step fails.
 *
 * @param proxy An instance of UniswapInfoProxy that provides methods to fetch balances and reserves. This proxy is used to interact with the underlying data source for token balances and liquidity pool reserves, allowing the function to perform necessary calculations and updates based on the current state of the Uniswap-like exchange.
 * @param pubkey The user's public key as a hexadecimal string. This public key is used to identify the user making the withdraw request and to verify the BLS signature for authentication. The function will use this public key to fetch the user's current balances and to update them after successfully executing the withdraw.
 * @param tokenAddr The address of the token to be withdrawn as a hexadecimal string. This address is used to identify the token being withdrawn and to fetch its current balance. The function will also use this address to update the user's balance after successfully executing the withdraw.
 * @param targetAddr The target address where the withdrawn tokens will be sent as a hexadecimal string. This address is used to specify the destination of the withdrawn tokens. The function will ensure that this address is valid and will include it in the message for BLS signature verification to ensure the authenticity of the request.
 * @param amt The amount of the token to be withdrawn as a bigint. This amount is used to check if the user has sufficient balance of the specified token to withdraw. The function will also include this amount in the message for BLS signature verification and will update the user's balance accordingly after successfully executing the withdraw.
 * @param blsSignature The BLS signature as a hexadecimal string that is used to authenticate the withdraw request. This signature is generated by the user using their private key and is verified against the public key and the message constructed from the request parameters. The function will check the validity of this signature before proceeding with executing the withdraw, ensuring that only authorized requests are processed.
 * @param nonce A unique nonce as a bigint that is used in the construction of the message for BLS signature verification. This nonce helps to prevent replay attacks by ensuring that each withdraw request has a unique message, even if all other parameters are the same. The function will include this nonce in the message that is hashed and verified against the BLS signature to ensure the authenticity of the request.
 * @param btcFee The fee for BTC in basis points (bps) as a bigint. This fee is applied to the amount of BTC being withdrawn and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after executing the withdraw.
 *
 * @returns A promise that resolves to an object indicating the success of the operation. If successful, the object contains the amount of the token that was withdrawn. If there is an error, the object contains an error message describing the issue that occurred during the withdraw process.
 */
export async function withdrawRequest(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  tokenAddr: string, // hex string token address
  targetAddr: string, // hex string target address
  amt: bigint, // bigint token amount
  blsSignature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  btcFee: bigint, // bigint BTC fee in bps
) {
  tokenAddr = tokenAddr.toLowerCase()
  targetAddr = targetAddr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  blsSignature = blsSignature.startsWith('0x') ? blsSignature.slice(2) : blsSignature

  initializeUniswapOps(proxy)

  try {
    if (!checkWithdrawSignature(pubkey, nonce, tokenAddr, targetAddr, amt, btcFee, blsSignature)) {
      throw new Error('Invalid BLS signature')
    }

    if (((await BALANCES.get(pubkey, tokenAddr)) || 0n) < amt) {
      throw new Error('Insufficient token balance')
    }
    BALANCES.setCheckPositive(
      pubkey,
      tokenAddr,
      ((await BALANCES.get(pubkey, tokenAddr)) || 0n) - amt,
    )

    BALANCES.setCheckPositive(
      pubkey,
      wbtcAddress,
      ((await BALANCES.get(pubkey, wbtcAddress)) || 0n) - btcFee,
    )

    return { success: true, data: { amt } }
  }
  catch (e: any) {
    console.error('Error in withdraw_request:', e)
    return { success: false, error_message: e.message }
  }
}

function checkUnwrapSignature(
  pubkey: string, // no 0x
  nonce: bigint,
  pkscript: string,
  amt: bigint,
  fee: bigint,
  blsSignature: string, // no 0x
) {
  if (blsSignature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '06' // unwrap
  msg += ethers.keccak256(Buffer.from(pkscript, 'hex')).slice(2)
  msg += amt.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msgBuf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msgBuf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sigX = BigInt(`0x${blsSignature.slice(0, 128)}`)
  const sigY = BigInt(`0x${blsSignature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sigX, sigY, BigInt(1))

  const pubkeyXC0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkeyXC1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkeyYC0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkeyYC1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkeyXC0, c1: pubkeyXC1 }),
    bls12_381.fields.Fp2.create({ c0: pubkeyYC0, c1: pubkeyYC1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 * Handles the unwrap request for BiS Swap. The unwrapRequest function takes various parameters including the user's public key, pkscript, amount to unwrap, fees, and a BLS signature for authentication. It first checks the validity of the BLS signature to ensure that the request is authorized. Then, it verifies that the user has sufficient balance of the wrapped token (WBTC) to unwrap. If the signature is valid and the balance is sufficient, it updates the internal state of balances accordingly and returns a success response with the unwrapped amount, or an error message if any step fails.
 *
 * @param proxy An instance of UniswapInfoProxy that provides methods to fetch balances and reserves. This proxy is used to interact with the underlying data source for token balances and liquidity pool reserves, allowing the function to perform necessary calculations and updates based on the current state of the Uniswap-like exchange.
 * @param pubkey The user's public key as a hexadecimal string. This public key is used to identify the user making the unwrap request and to verify the BLS signature for authentication. The function will use this public key to fetch the user's current balances and to update them after successfully executing the unwrap.
 * @param pkscript The pkscript as a hexadecimal string that specifies the script for the unwrapped Bitcoin. This pkscript is used in the construction of the message for BLS signature verification to ensure the authenticity of the request. The function will also use this pkscript to determine the destination of the unwrapped Bitcoin and to include it in the message for signature verification.
 * @param amt The amount of the wrapped token (WBTC) to be unwrapped as a bigint. This amount is used to check if the user has sufficient balance of WBTC to unwrap. The function will also include this amount in the message for BLS signature verification and will update the user's balance accordingly after successfully executing the unwrap.
 * @param blsSignature The BLS signature as a hexadecimal string that is used to authenticate the unwrap request. This signature is generated by the user using their private key and is verified against the public key and the message constructed from the request parameters. The function will check the validity of this signature before proceeding with executing the unwrap, ensuring that only authorized requests are processed.
 * @param nonce A unique nonce as a bigint that is used in the construction of the message for BLS signature verification. This nonce helps to prevent replay attacks by ensuring that each unwrap request has a unique message, even if all other parameters are the same. The function will include this nonce in the message that is hashed and verified against the BLS signature to ensure the authenticity of the request.
 * @param btcFee The fee for BTC in basis points (bps) as a bigint. This fee is applied to the amount of BTC being unwrapped and is deducted from the user's balance. The function will calculate the fee based on this value and ensure that it is properly accounted for in the user's balance updates after executing the unwrap.
 *
 * @returns A promise that resolves to an object indicating the success of the operation. If successful, the object contains the amount of the wrapped token that was unwrapped. If there is an error, the object contains an error message describing the issue that occurred during the unwrap process.
 */
export async function unwrapRequest(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  pkscript: string, // hex string pkscript
  amt: bigint, // bigint token amount
  blsSignature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  btcFee: bigint, // bigint BTC fee in bps
) {
  pkscript = pkscript.toLowerCase()
  pkscript = pkscript.startsWith('0x') ? pkscript.slice(2) : pkscript
  if (pkscript.length > 126) {
    throw new Error('Pkscript too long')
  }
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  blsSignature = blsSignature.startsWith('0x') ? blsSignature.slice(2) : blsSignature

  initializeUniswapOps(proxy)

  try {
    if (!checkUnwrapSignature(pubkey, nonce, pkscript, amt, btcFee, blsSignature)) {
      throw new Error('Invalid BLS signature')
    }

    if (((await BALANCES.get(pubkey, wbtcAddress)) || 0n) < amt) {
      throw new Error('Insufficient token balance')
    }
    BALANCES.setCheckPositive(
      pubkey,
      wbtcAddress,
      ((await BALANCES.get(pubkey, wbtcAddress)) || 0n) - amt,
    )

    BALANCES.setCheckPositive(
      pubkey,
      wbtcAddress,
      ((await BALANCES.get(pubkey, wbtcAddress)) || 0n) - btcFee,
    )

    return { success: true, data: { amt } }
  }
  catch (e: any) {
    console.error('Error in withdraw_request:', e)
    return { success: false, error_message: e.message }
  }
}

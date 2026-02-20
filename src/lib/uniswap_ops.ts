import { Buffer } from 'node:buffer'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import * as ethers from 'ethers'

export interface UniswapInfoProxy {
  balanceOf: (pubkey: string, token_address: string) => Promise<bigint | null>
  reservesOf: (
    pair_address: string,
  ) => Promise<{ reserveA: bigint, reserveB: bigint, total_supply: bigint } | null>
}

let wbtc_address = ''
let factory_addr = ''
/**
 *
 * @param wbtc_addr
 * @param factory
 */
export function save_info(wbtc_addr: string, factory: string) {
  wbtc_address = wbtc_addr
  factory_addr = factory
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
 *
 * @param token_a_addr
 * @param token_b_addr
 */
export function calculate_pair_address(token_a_addr: string, token_b_addr: string) {
  if (token_a_addr.toLowerCase() > token_b_addr.toLowerCase()) {
    ;[token_a_addr, token_b_addr] = [token_b_addr, token_a_addr]
  }

  const packed = ethers.solidityPacked(
    ['uint8', 'address', 'bytes32', 'bytes32'],
    [
      0xFF,
      factory_addr,
      ethers.keccak256(ethers.solidityPacked(['address', 'address'], [token_a_addr, token_b_addr])),
      '0xc3cb93660fbd444d3f741950f68d962ba5a881cc5e37a5eedd40ba8e2127da33',
    ],
  )
  const pair_address = `0x${ethers.keccak256(packed).slice(-40)}`
  return pair_address
}

async function get_current_pubkey_balance(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token_addr: string, // hex string token address
): Promise<bigint> {
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  const balance = await proxy.balanceOf(pubkey, token_addr)

  if (balance === null) {
    return BigInt(0)
  }

  return balance
}

async function get_pair_reserves(
  proxy: UniswapInfoProxy,
  token_a_addr: string, // hex string token1 address
  token_b_addr: string, // hex string token2 address
) {
  if (token_a_addr.toLowerCase() > token_b_addr.toLowerCase()) {
    ;[token_a_addr, token_b_addr] = [token_b_addr, token_a_addr]
  }
  const reserves = await proxy.reservesOf(calculate_pair_address(token_a_addr, token_b_addr))
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

  async get(pubkey: string, token_addr: string): Promise<bigint> {
    if (this.proxy === null) {
      throw new Error('Proxy not set')
    }
    pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
    const key = `${pubkey}:${token_addr}`
    if (key in this.map) {
      if (this.map[key] === undefined) {
        throw new Error('Undefined balance encountered')
      }
      return this.map[key]
    }
    if (token_addr.length === 42) {
      const val = await get_current_pubkey_balance(this.proxy, pubkey, token_addr)
      this.map[key] = val
      return val
    }
    else {
      // lp token
      const token_a_addr = `0x${token_addr.slice(2, 42)}`
      const token_b_addr = `0x${token_addr.slice(44, 84)}`
      const pair_address = calculate_pair_address(token_a_addr, token_b_addr)
      const val = await get_current_pubkey_balance(this.proxy, pubkey, pair_address)
      this.map[key] = val
      return val
    }
  }

  set_check_positive(pubkey: string, token_addr: string, val: bigint) {
    pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
    const key = `${pubkey}:${token_addr}`
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

  get_key(token_a_addr: string, token_b_addr: string): string {
    return token_a_addr < token_b_addr
      ? `${token_a_addr}:${token_b_addr}`
      : `${token_b_addr}:${token_a_addr}`
  }

  async get(
    token_a_addr: string,
    token_b_addr: string,
  ): Promise<{ reserveA: bigint, reserveB: bigint, total_supply: bigint }> {
    if (this.proxy === null) {
      throw new Error('Proxy not set')
    }
    const key = this.get_key(token_a_addr, token_b_addr)
    if (key in this.map) {
      if (this.map[key] === undefined) {
        throw new Error('Undefined reserves encountered')
      }
      return this.map[key]
    }
    const val = await get_pair_reserves(this.proxy, token_a_addr, token_b_addr)
    this.map[key] = val
    return val
  }

  set(
    token_a_addr: string,
    token_b_addr: string,
    val: { reserveA: bigint, reserveB: bigint, total_supply: bigint },
  ) {
    // throw an error if any of the reserves exceed 112 bits
    if (val.reserveA > 2n ** 112n || val.reserveB > 2n ** 112n) {
      throw new Error('Reserve exceeds 112 bits')
    }
    const key = this.get_key(token_a_addr, token_b_addr)
    this.map[key] = val
  }
}

const balances = new BalanceMap()
const reserves = new ReserveMap()
function initialize_uniswap_ops(proxy: UniswapInfoProxy) {
  if (wbtc_address === '' || factory_addr === '') {
    throw new Error('Uniswap info not set')
  }
  balances.clear(proxy)
  reserves.clear(proxy)
}

function key_for(tokenA: string, tokenB: string): string {
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
    const { reserveA, reserveB } = await get_reserves(path[i]!, path[i + 1]!)
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
    const { reserveA, reserveB } = await get_reserves(path[i - 1]!, path[i]!)
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

async function get_reserves(tokenA: string, tokenB: string) {
  const response = await reserves.get(tokenA, tokenB)
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

const bigIntMin = (...args: bigint[]) => args.reduce((m, e) => (e < m ? e : m))

async function mint(tokenA: string, tokenB: string, amountA: bigint, amountB: bigint) {
  const {
    reserveA: balanceA,
    reserveB: balanceB,
    total_supply,
  } = await get_reserves(tokenA, tokenB)
  const reserveA = balanceA - amountA
  const reserveB = balanceB - amountB

  let liquidity
  if (total_supply === 0n) {
    liquidity = sqrt(amountA * amountB) - 1000n

    const old_reserve = await reserves.get(tokenA, tokenB)
    reserves.set(tokenA, tokenB, {
      reserveA: old_reserve.reserveA,
      reserveB: old_reserve.reserveB,
      total_supply: old_reserve.total_supply + 1000n,
    })
  }
  else {
    liquidity = bigIntMin((amountA * total_supply) / reserveA, (amountB * total_supply) / reserveB)
  }

  if (liquidity <= 0n) {
    throw new Error('Insufficient liquidity minted')
  }

  const old_reserve = await reserves.get(tokenA, tokenB)
  reserves.set(tokenA, tokenB, {
    reserveA: old_reserve.reserveA,
    reserveB: old_reserve.reserveB,
    total_supply: old_reserve.total_supply + liquidity,
  })
  return liquidity
}

async function _addLiquidity(
  tokenA: string,
  tokenB: string,
  amountADesired: bigint,
  amountBDesired: bigint,
  amountAMin: bigint,
  amountBMin: bigint,
) {
  let amountA, amountB

  try {
    await reserves.get(tokenA, tokenB)
  }
  catch {
    reserves.set(tokenA, tokenB, { reserveA: 0n, reserveB: 0n, total_supply: 0n })
  }
  const { reserveA, reserveB } = await get_reserves(tokenA, tokenB)
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
  const { amountA, amountB } = await _addLiquidity(
    tokenA,
    tokenB,
    amountADesired,
    amountBDesired,
    amountAMin,
    amountBMin,
  )
  const old_reserve = await reserves.get(tokenA, tokenB)
  if (tokenA < tokenB) {
    reserves.set(tokenA, tokenB, {
      reserveA: old_reserve.reserveA + amountA,
      reserveB: old_reserve.reserveB + amountB,
      total_supply: old_reserve.total_supply,
    })
  }
  else {
    reserves.set(tokenB, tokenA, {
      reserveA: old_reserve.reserveA + amountB,
      reserveB: old_reserve.reserveB + amountA,
      total_supply: old_reserve.total_supply,
    })
  }
  const liquidity = await mint(tokenA, tokenB, amountA, amountB)
  return { amountA, amountB, liquidity }
}

async function burn(tokenA: string, tokenB: string, liquidity: bigint) {
  const {
    reserveA: balanceA,
    reserveB: balanceB,
    total_supply,
  } = await get_reserves(tokenA, tokenB)

  const amountA = (liquidity * balanceA) / total_supply
  const amountB = (liquidity * balanceB) / total_supply

  if (amountA <= 0n || amountB <= 0n) {
    throw new Error('Insufficient liquidity burned')
  }

  const old_reserve = await reserves.get(tokenA, tokenB)
  const new_total_supply = old_reserve.total_supply - liquidity
  let new_reserveA = old_reserve.reserveA
  let new_reserveB = old_reserve.reserveB
  if (tokenA < tokenB) {
    new_reserveA -= amountA
    new_reserveB -= amountB
  }
  else {
    new_reserveA -= amountB
    new_reserveB -= amountA
  }
  reserves.set(tokenA, tokenB, {
    reserveA: new_reserveA,
    reserveB: new_reserveB,
    total_supply: new_total_supply,
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
  to_flipped: boolean | null,
) {
  if (amount0Out <= 0n && amount1Out <= 0n) {
    throw new Error('Insufficient output amount')
  }
  const { reserveA: _reserveA, reserveB: _reserveB } = await get_reserves(token0, token1)
  const reserveA = _reserveA - _amount0In
  const reserveB = _reserveB - _amount1In
  if (amount0Out >= reserveA || amount1Out >= reserveB) {
    throw new Error('Insufficient liquidity')
  }

  const old_reserve = await reserves.get(token0, token1)
  reserves.set(token0, token1, {
    reserveA: old_reserve.reserveA - amount0Out,
    reserveB: old_reserve.reserveB - amount1Out,
    total_supply: old_reserve.total_supply,
  })

  if (to !== null) {
    const to_tkn1 = to[0]
    const to_tkn2 = to[1]
    const old_reserve_to = await reserves.get(to_tkn1, to_tkn2)
    if (to_flipped) {
      reserves.set(to_tkn1, to_tkn2, {
        reserveA: old_reserve_to.reserveA + amount1Out,
        reserveB: old_reserve_to.reserveB + amount0Out,
        total_supply: old_reserve_to.total_supply,
      })
    }
    else {
      reserves.set(to_tkn1, to_tkn2, {
        reserveA: old_reserve_to.reserveA + amount0Out,
        reserveB: old_reserve_to.reserveB + amount1Out,
        total_supply: old_reserve_to.total_supply,
      })
    }
  }
  const balance0 = (await reserves.get(token0, token1)).reserveA
  const balance1 = (await reserves.get(token0, token1)).reserveB

  const amount0In = balance0 > reserveA - amount0Out ? balance0 - (reserveA - amount0Out) : 0n
  const amount1In = balance1 > reserveB - amount1Out ? balance1 - (reserveB - amount1Out) : 0n

  if (amount0In <= 0n && amount1In <= 0n) {
    throw new Error('Insufficient input amount')
  }

  const balance0Adjusted = balance0 * 1000n - amount0In * 3n
  const balance1Adjusted = balance1 * 1000n - amount1In * 3n
  if (balance0Adjusted * balance1Adjusted < BigInt(reserveA) * BigInt(reserveB) * 1000n * 1000n) {
    throw new Error('K')
  }
}
async function _swap(amounts: bigint[], path: string[]) {
  if (amounts.length !== path.length) {
    throw new Error('Amounts and path length mismatch')
  }
  if (amounts.length < 2) {
    throw new Error('Invalid path length')
  }
  const old_reserve = await reserves.get(path[0]!, path[1]!)
  if (path[0]! < path[1]!) {
    reserves.set(path[0]!, path[1]!, {
      reserveA: old_reserve.reserveA + amounts[0]!,
      reserveB: old_reserve.reserveB,
      total_supply: old_reserve.total_supply,
    })
  }
  else {
    reserves.set(path[0]!, path[1]!, {
      reserveA: old_reserve.reserveA,
      reserveB: old_reserve.reserveB + amounts[0]!,
      total_supply: old_reserve.total_supply,
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
    const to_flipped = to === null ? null : output >= path[i + 2]!

    await swap(token0, token1, amount0In, amount1In, amount0Out, amount1Out, to, to_flipped)
  }
}

async function inner_swap1_op(amountIn: bigint, amountOutMin: bigint, path: string[]) {
  if (path.length < 2) {
    throw new Error('Invalid path')
  }
  const amounts = await getAmountsOut(amountIn, path)
  if (amounts[amounts.length - 1]! < amountOutMin) {
    throw new Error('Insufficient output amount')
  }

  await _swap(amounts, path)
  return amounts
}

async function inner_swap2_op(maxAmountIn: bigint, amountOut: bigint, path: string[]) {
  if (path.length < 2) {
    throw new Error('Invalid path')
  }
  const amounts = await getAmountsIn(amountOut, path)
  if (amounts[0]! > maxAmountIn) {
    throw new Error('Excessive Input Amount')
  }

  await _swap(amounts, path)
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

function check_add_liquidity_signature(
  pubkey: string, // no 0x
  nonce: bigint,
  token1_addr: string,
  token2_addr: string,
  amt1: bigint,
  amt2: bigint,
  min_amt1: bigint,
  min_amt2: bigint,
  token1FeeBps: bigint,
  token2FeeBps: bigint,
  fee: bigint,
  bls_signature: string, // no 0x
) {
  if (bls_signature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '01' // add liquidity
  msg += token1_addr.slice(2).padStart(40, '0')
  msg += token2_addr.slice(2).padStart(40, '0')
  msg += amt1.toString(16).padStart(64, '0')
  msg += amt2.toString(16).padStart(64, '0')
  msg += min_amt1.toString(16).padStart(64, '0')
  msg += min_amt2.toString(16).padStart(64, '0')
  msg += token1FeeBps.toString(16).padStart(64, '0')
  msg += token2FeeBps.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sig_x = BigInt(`0x${bls_signature.slice(0, 128)}`)
  const sig_y = BigInt(`0x${bls_signature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sig_x, sig_y, BigInt(1))

  const pubkey_x_c0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkey_x_c1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkey_y_c0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkey_y_c1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkey_x_c0, c1: pubkey_x_c1 }),
    bls12_381.fields.Fp2.create({ c0: pubkey_y_c0, c1: pubkey_y_c1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 *
 * @param proxy
 * @param pubkey
 * @param token1_addr
 * @param token2_addr
 * @param amt1
 * @param amt2
 * @param minamt1
 * @param minamt2
 * @param bls_signature
 * @param nonce
 * @param token1FeeBps
 * @param token2FeeBps
 * @param btc_fee
 */
export async function add_liquidity_request(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token1_addr: string, // hex string token1 address
  token2_addr: string, // hex string token2 address
  amt1: bigint, // bigint token1 amount
  amt2: bigint, // bigint token2 amount
  minamt1: bigint, // bigint min token1 amount
  minamt2: bigint, // bigint min token2 amount
  bls_signature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  token1FeeBps: bigint, // bigint token1 fee in bps
  token2FeeBps: bigint, // bigint token2 fee in bps
  btc_fee: bigint, // bigint BTC fee in bps
): Promise<{
  success: boolean
  data?: { amountA: bigint, amountB: bigint, liquidity: bigint }
  error_message?: string
}> {
  token1_addr = token1_addr.toLowerCase()
  token2_addr = token2_addr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  bls_signature = bls_signature.startsWith('0x') ? bls_signature.slice(2) : bls_signature

  initialize_uniswap_ops(proxy)

  try {
    if (
      !check_add_liquidity_signature(
        pubkey,
        nonce,
        token1_addr,
        token2_addr,
        amt1,
        amt2,
        minamt1,
        minamt2,
        token1FeeBps,
        token2FeeBps,
        btc_fee,
        bls_signature,
      )
    ) {
      throw new Error('Invalid BLS signature')
    }

    const { amountA, amountB, liquidity } = await innerAddLiquidity(
      token1_addr,
      token2_addr,
      amt1,
      amt2,
      minamt1,
      minamt2,
    )

    const pair_key = key_for(token1_addr, token2_addr)
    balances.set_check_positive(
      pubkey,
      token1_addr,
      ((await balances.get(pubkey, token1_addr)) || 0n) - amountA,
    )
    balances.set_check_positive(
      pubkey,
      token2_addr,
      ((await balances.get(pubkey, token2_addr)) || 0n) - amountB,
    )
    balances.set_check_positive(
      pubkey,
      pair_key,
      ((await balances.get(pubkey, pair_key)) || 0n) + liquidity,
    )

    balances.set_check_positive(
      pubkey,
      wbtc_address,
      ((await balances.get(pubkey, wbtc_address)) || 0n) - btc_fee,
    )
    balances.set_check_positive(
      pubkey,
      token1_addr,
      ((await balances.get(pubkey, token1_addr)) || 0n) - (amountA * token1FeeBps) / 10000n,
    )
    balances.set_check_positive(
      pubkey,
      token2_addr,
      ((await balances.get(pubkey, token2_addr)) || 0n) - (amountB * token2FeeBps) / 10000n,
    )

    return { success: true, data: { amountA, amountB, liquidity } }
  }
  catch (e: any) {
    console.error('Error in add_liquidity_request:', e)
    return { success: false, error_message: e.message }
  }
}

function check_remove_liquidity_signature(
  pubkey: string, // no 0x
  nonce: bigint,
  token1_addr: string,
  token2_addr: string,
  liquidity: bigint,
  min_amt1: bigint,
  min_amt2: bigint,
  token1FeeBps: bigint,
  token2FeeBps: bigint,
  fee: bigint,
  bls_signature: string, // no 0x
) {
  if (bls_signature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '02' // remove liquidity
  msg += token1_addr.slice(2).padStart(40, '0')
  msg += token2_addr.slice(2).padStart(40, '0')
  msg += liquidity.toString(16).padStart(64, '0')
  msg += min_amt1.toString(16).padStart(64, '0')
  msg += min_amt2.toString(16).padStart(64, '0')
  msg += token1FeeBps.toString(16).padStart(64, '0')
  msg += token2FeeBps.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sig_x = BigInt(`0x${bls_signature.slice(0, 128)}`)
  const sig_y = BigInt(`0x${bls_signature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sig_x, sig_y, BigInt(1))

  const pubkey_x_c0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkey_x_c1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkey_y_c0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkey_y_c1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkey_x_c0, c1: pubkey_x_c1 }),
    bls12_381.fields.Fp2.create({ c0: pubkey_y_c0, c1: pubkey_y_c1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 *
 * @param proxy
 * @param pubkey
 * @param token1_addr
 * @param token2_addr
 * @param liquidity
 * @param minamt1
 * @param minamt2
 * @param bls_signature
 * @param nonce
 * @param token1FeeBps
 * @param token2FeeBps
 * @param btc_fee
 */
export async function remove_liquidity_request(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token1_addr: string, // hex string token1 address
  token2_addr: string, // hex string token2 address
  liquidity: bigint, // bigint lp token amount
  minamt1: bigint, // bigint min token1 amount
  minamt2: bigint, // bigint min token2 amount
  bls_signature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  token1FeeBps: bigint, // bigint token1 fee in bps
  token2FeeBps: bigint, // bigint token2 fee in bps
  btc_fee: bigint, // bigint BTC fee in bps
) {
  token1_addr = token1_addr.toLowerCase()
  token2_addr = token2_addr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  bls_signature = bls_signature.startsWith('0x') ? bls_signature.slice(2) : bls_signature

  initialize_uniswap_ops(proxy)

  try {
    if (
      !check_remove_liquidity_signature(
        pubkey,
        nonce,
        token1_addr,
        token2_addr,
        liquidity,
        minamt1,
        minamt2,
        token1FeeBps,
        token2FeeBps,
        btc_fee,
        bls_signature,
      )
    ) {
      throw new Error('Invalid BLS signature')
    }

    const pair_key = key_for(token1_addr, token2_addr)
    if (((await balances.get(pubkey, pair_key)) || 0n) < liquidity) {
      throw new Error('Insufficient liquidity balance')
    }

    const { amountA, amountB } = await innerRemoveLiquidity(
      token1_addr,
      token2_addr,
      liquidity,
      minamt1,
      minamt2,
    )

    balances.set_check_positive(
      pubkey,
      pair_key,
      ((await balances.get(pubkey, pair_key)) || 0n) - liquidity,
    )
    balances.set_check_positive(
      pubkey,
      token1_addr,
      ((await balances.get(pubkey, token1_addr)) || 0n) + amountA,
    )
    balances.set_check_positive(
      pubkey,
      token2_addr,
      ((await balances.get(pubkey, token2_addr)) || 0n) + amountB,
    )

    balances.set_check_positive(
      pubkey,
      wbtc_address,
      ((await balances.get(pubkey, wbtc_address)) || 0n) - btc_fee,
    )
    balances.set_check_positive(
      pubkey,
      token1_addr,
      ((await balances.get(pubkey, token1_addr)) || 0n) - (amountA * token1FeeBps) / 10000n,
    )
    balances.set_check_positive(
      pubkey,
      token2_addr,
      ((await balances.get(pubkey, token2_addr)) || 0n) - (amountB * token2FeeBps) / 10000n,
    )

    return { success: true, data: { amountA, amountB, liquidity } }
  }
  catch (e: any) {
    console.error('Error in remove_liquidity_request:', e)
    return { success: false, error_message: e.message }
  }
}

function check_swap_signature(
  pubkey: string, // no 0x
  nonce: bigint,
  token1_addr: string,
  token2_addr: string,
  amtin: bigint,
  min_amtout: bigint,
  token1FeeBps: bigint,
  token2FeeBps: bigint,
  fee: bigint,
  bls_signature: string, // no 0x
) {
  if (bls_signature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '03' // swap1
  msg += token1_addr.slice(2).padStart(64, '0')
  msg += token2_addr.slice(2).padStart(64, '0')
  msg += amtin.toString(16).padStart(64, '0')
  msg += min_amtout.toString(16).padStart(64, '0')
  msg += token1FeeBps.toString(16).padStart(64, '0')
  msg += token2FeeBps.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sig_x = BigInt(`0x${bls_signature.slice(0, 128)}`)
  const sig_y = BigInt(`0x${bls_signature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sig_x, sig_y, BigInt(1))

  const pubkey_x_c0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkey_x_c1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkey_y_c0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkey_y_c1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkey_x_c0, c1: pubkey_x_c1 }),
    bls12_381.fields.Fp2.create({ c0: pubkey_y_c0, c1: pubkey_y_c1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 *
 * @param proxy
 * @param pubkey
 * @param token1_addr
 * @param token2_addr
 * @param in_amt
 * @param min_out_amt
 * @param bls_signature
 * @param nonce
 * @param token1FeeBps
 * @param token2FeeBps
 * @param btc_fee
 */
export async function swap_request(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token1_addr: string, // hex string token in address
  token2_addr: string, // hex string token out address
  in_amt: bigint, // bigint token in amount
  min_out_amt: bigint, // bigint min token out amount
  bls_signature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  token1FeeBps: bigint, // bigint token1 fee in bps
  token2FeeBps: bigint, // bigint token2 fee in bps
  btc_fee: bigint, // bigint BTC fee in bps
) {
  token1_addr = token1_addr.toLowerCase()
  token2_addr = token2_addr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  bls_signature = bls_signature.startsWith('0x') ? bls_signature.slice(2) : bls_signature

  initialize_uniswap_ops(proxy)

  try {
    if (
      !check_swap_signature(
        pubkey,
        nonce,
        token1_addr,
        token2_addr,
        in_amt,
        min_out_amt,
        token1FeeBps,
        token2FeeBps,
        btc_fee,
        bls_signature,
      )
    ) {
      throw new Error('Invalid BLS signature')
    }

    if (((await balances.get(pubkey, token1_addr)) || 0n) < in_amt) {
      throw new Error('Insufficient input token balance')
    }

    // get current reserves
    const { reserveA: reserveA_before, reserveB: reserveB_before } = await get_reserves(
      token1_addr,
      token2_addr,
    )

    const amounts = await inner_swap1_op(in_amt, min_out_amt, [token1_addr, token2_addr])

    if (amounts.length !== 2) {
      throw new Error('Invalid swap output amounts')
    }

    balances.set_check_positive(
      pubkey,
      token1_addr,
      ((await balances.get(pubkey, token1_addr)) || 0n) - in_amt,
    )
    balances.set_check_positive(
      pubkey,
      token2_addr,
      ((await balances.get(pubkey, token2_addr)) || 0n) + amounts[1]!,
    )

    balances.set_check_positive(
      pubkey,
      wbtc_address,
      ((await balances.get(pubkey, wbtc_address)) || 0n) - btc_fee,
    )
    balances.set_check_positive(
      pubkey,
      token1_addr,
      ((await balances.get(pubkey, token1_addr)) || 0n) - (in_amt * token1FeeBps) / 10000n,
    )
    balances.set_check_positive(
      pubkey,
      token2_addr,
      ((await balances.get(pubkey, token2_addr)) || 0n) - (amounts[1]! * token2FeeBps) / 10000n,
    )

    // get new reserves
    const { reserveA: reserveA_after, reserveB: reserveB_after } = await get_reserves(
      token1_addr,
      token2_addr,
    )

    // get the price impact
    const price_before
      = token1_addr === wbtc_address
        ? (reserveA_before * 1000000000000000000n * 10000n) / reserveB_before
        : (reserveB_before * 1000000000000000000n * 10000n) / reserveA_before
    const price_after
      = token1_addr === wbtc_address
        ? (reserveA_after * 1000000000000000000n * 10000n) / reserveB_after
        : (reserveB_after * 1000000000000000000n * 10000n) / reserveA_after
    const price_impact
      = price_before > price_after ? price_before - price_after : price_after - price_before
    const price_impact_bps = price_before !== 0n ? (price_impact * 10000n) / price_before : 0n

    return { success: true, amounts, price_impact_bps }
  }
  catch (e: any) {
    console.error('Error in swap_request:', e)
    return { success: false, error_message: e.message }
  }
}

function check_swap2_signature(
  pubkey: string, // no 0x
  nonce: bigint,
  token1_addr: string,
  token2_addr: string,
  max_amtin: bigint,
  amtout: bigint,
  token1FeeBps: bigint,
  token2FeeBps: bigint,
  fee: bigint,
  bls_signature: string, // no 0x
) {
  if (bls_signature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '03' // swap1
  msg += token1_addr.slice(2).padStart(64, '0')
  msg += token2_addr.slice(2).padStart(64, '0')
  msg += max_amtin.toString(16).padStart(64, '0')
  msg += amtout.toString(16).padStart(64, '0')
  msg += token1FeeBps.toString(16).padStart(64, '0')
  msg += token2FeeBps.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sig_x = BigInt(`0x${bls_signature.slice(0, 128)}`)
  const sig_y = BigInt(`0x${bls_signature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sig_x, sig_y, BigInt(1))

  const pubkey_x_c0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkey_x_c1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkey_y_c0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkey_y_c1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkey_x_c0, c1: pubkey_x_c1 }),
    bls12_381.fields.Fp2.create({ c0: pubkey_y_c0, c1: pubkey_y_c1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 *
 * @param proxy
 * @param pubkey
 * @param token1_addr
 * @param token2_addr
 * @param max_in_amt
 * @param out_amt
 * @param bls_signature
 * @param nonce
 * @param token1FeeBps
 * @param token2FeeBps
 * @param btc_fee
 */
export async function swap2_request(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token1_addr: string, // hex string token in address
  token2_addr: string, // hex string token out address
  max_in_amt: bigint, // bigint max token in amount
  out_amt: bigint, // bigint token out amount
  bls_signature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  token1FeeBps: bigint, // bigint token1 fee in bps
  token2FeeBps: bigint, // bigint token2 fee in bps
  btc_fee: bigint, // bigint BTC fee in bps
) {
  token1_addr = token1_addr.toLowerCase()
  token2_addr = token2_addr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  bls_signature = bls_signature.startsWith('0x') ? bls_signature.slice(2) : bls_signature

  initialize_uniswap_ops(proxy)

  try {
    if (
      !check_swap2_signature(
        pubkey,
        nonce,
        token1_addr,
        token2_addr,
        max_in_amt,
        out_amt,
        token1FeeBps,
        token2FeeBps,
        btc_fee,
        bls_signature,
      )
    ) {
      throw new Error('Invalid BLS signature')
    }

    // get current reserves
    const { reserveA: reserveA_before, reserveB: reserveB_before } = await get_reserves(
      token1_addr,
      token2_addr,
    )

    const amounts = await inner_swap2_op(max_in_amt, out_amt, [token1_addr, token2_addr])

    if (amounts.length !== 2) {
      throw new Error('Invalid swap output amounts')
    }

    balances.set_check_positive(
      pubkey,
      token1_addr,
      ((await balances.get(pubkey, token1_addr)) || 0n) - amounts[0]!,
    )
    balances.set_check_positive(
      pubkey,
      token2_addr,
      ((await balances.get(pubkey, token2_addr)) || 0n) + out_amt,
    )

    balances.set_check_positive(
      pubkey,
      wbtc_address,
      ((await balances.get(pubkey, wbtc_address)) || 0n) - btc_fee,
    )
    balances.set_check_positive(
      pubkey,
      token1_addr,
      ((await balances.get(pubkey, token1_addr)) || 0n) - (amounts[0]! * token1FeeBps) / 10000n,
    )
    balances.set_check_positive(
      pubkey,
      token2_addr,
      ((await balances.get(pubkey, token2_addr)) || 0n) - (out_amt * token2FeeBps) / 10000n,
    )

    // get new reserves
    const { reserveA: reserveA_after, reserveB: reserveB_after } = await get_reserves(
      token1_addr,
      token2_addr,
    )

    // get the price impact
    const price_before
      = token1_addr === wbtc_address
        ? (reserveA_before * 1000000000000000000n * 10000n) / reserveB_before
        : (reserveB_before * 1000000000000000000n * 10000n) / reserveA_before
    const price_after
      = token1_addr === wbtc_address
        ? (reserveA_after * 1000000000000000000n * 10000n) / reserveB_after
        : (reserveB_after * 1000000000000000000n * 10000n) / reserveA_after
    const price_impact
      = price_before > price_after ? price_before - price_after : price_after - price_before
    const price_impact_bps = price_before !== 0n ? (price_impact * 10000n) / price_before : 0n

    return { success: true, amounts, price_impact_bps }
  }
  catch (e: any) {
    console.error('Error in swap_request:', e)
    return { success: false, error_message: e.message }
  }
}

function check_withdraw_signature(
  pubkey: string, // no 0x
  nonce: bigint,
  token_addr: string,
  target_addr: string,
  amt: bigint,
  fee: bigint,
  bls_signature: string, // no 0x
) {
  if (bls_signature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '05' // withdraw
  msg += token_addr.slice(2).padStart(40, '0')
  msg += target_addr.slice(2).padStart(40, '0')
  msg += amt.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sig_x = BigInt(`0x${bls_signature.slice(0, 128)}`)
  const sig_y = BigInt(`0x${bls_signature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sig_x, sig_y, BigInt(1))

  const pubkey_x_c0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkey_x_c1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkey_y_c0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkey_y_c1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkey_x_c0, c1: pubkey_x_c1 }),
    bls12_381.fields.Fp2.create({ c0: pubkey_y_c0, c1: pubkey_y_c1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 *
 * @param proxy
 * @param pubkey
 * @param token_addr
 * @param target_addr
 * @param amt
 * @param bls_signature
 * @param nonce
 * @param btc_fee
 */
export async function withdraw_request(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  token_addr: string, // hex string token address
  target_addr: string, // hex string target address
  amt: bigint, // bigint token amount
  bls_signature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  btc_fee: bigint, // bigint BTC fee in bps
) {
  token_addr = token_addr.toLowerCase()
  target_addr = target_addr.toLowerCase()
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  bls_signature = bls_signature.startsWith('0x') ? bls_signature.slice(2) : bls_signature

  initialize_uniswap_ops(proxy)

  try {
    if (
      !check_withdraw_signature(pubkey, nonce, token_addr, target_addr, amt, btc_fee, bls_signature)
    ) {
      throw new Error('Invalid BLS signature')
    }

    if (((await balances.get(pubkey, token_addr)) || 0n) < amt) {
      throw new Error('Insufficient token balance')
    }
    balances.set_check_positive(
      pubkey,
      token_addr,
      ((await balances.get(pubkey, token_addr)) || 0n) - amt,
    )

    balances.set_check_positive(
      pubkey,
      wbtc_address,
      ((await balances.get(pubkey, wbtc_address)) || 0n) - btc_fee,
    )

    return { success: true, data: { amt } }
  }
  catch (e: any) {
    console.error('Error in withdraw_request:', e)
    return { success: false, error_message: e.message }
  }
}

function check_unwrap_signature(
  pubkey: string, // no 0x
  nonce: bigint,
  pkscript: string,
  amt: bigint,
  fee: bigint,
  bls_signature: string, // no 0x
) {
  if (bls_signature === '') {
    return true // skip signature verification if empty
  }

  let msg = ethers.keccak256(Buffer.from(pubkey, 'hex')).slice(2)
  msg += nonce.toString(16).padStart(8, '0')
  msg += '06' // unwrap
  msg += ethers.keccak256(Buffer.from(pkscript, 'hex')).slice(2)
  msg += amt.toString(16).padStart(64, '0')
  msg += fee.toString(16).padStart(64, '0')
  // console.log("Message for signature verification:", msg);
  const msg_buf = Buffer.from(msg, 'hex')
  const P = bls12_381.G1.hashToCurve(msg_buf, {
    DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
  })

  const sig_x = BigInt(`0x${bls_signature.slice(0, 128)}`)
  const sig_y = BigInt(`0x${bls_signature.slice(128, 256)}`)
  const signaturePoint = new bls12_381.G1.Point(sig_x, sig_y, BigInt(1))

  const pubkey_x_c0 = BigInt(`0x${pubkey.slice(0, 128)}`)
  const pubkey_x_c1 = BigInt(`0x${pubkey.slice(128, 256)}`)
  const pubkey_y_c0 = BigInt(`0x${pubkey.slice(256, 384)}`)
  const pubkey_y_c1 = BigInt(`0x${pubkey.slice(384, 512)}`)
  const pubkeyPoint = new bls12_381.G2.Point(
    bls12_381.fields.Fp2.create({ c0: pubkey_x_c0, c1: pubkey_x_c1 }),
    bls12_381.fields.Fp2.create({ c0: pubkey_y_c0, c1: pubkey_y_c1 }),
    bls12_381.fields.Fp2.ONE,
  )

  const res = bls12_381.shortSignatures.verify(signaturePoint, P, pubkeyPoint)
  return res
}
/**
 *
 * @param proxy
 * @param pubkey
 * @param pkscript
 * @param amt
 * @param bls_signature
 * @param nonce
 * @param btc_fee
 */
export async function unwrap_request(
  proxy: UniswapInfoProxy,
  pubkey: string, // hex string bls pubkey
  pkscript: string, // hex string pkscript
  amt: bigint, // bigint token amount
  bls_signature: string, // hex string BLS signature
  nonce: bigint, // unique request nonce
  btc_fee: bigint, // bigint BTC fee in bps
) {
  pkscript = pkscript.toLowerCase()
  pkscript = pkscript.startsWith('0x') ? pkscript.slice(2) : pkscript
  if (pkscript.length > 126) {
    throw new Error('Pkscript too long')
  }
  pubkey = pubkey.startsWith('0x') ? pubkey.slice(2) : pubkey
  bls_signature = bls_signature.startsWith('0x') ? bls_signature.slice(2) : bls_signature

  initialize_uniswap_ops(proxy)

  try {
    if (!check_unwrap_signature(pubkey, nonce, pkscript, amt, btc_fee, bls_signature)) {
      throw new Error('Invalid BLS signature')
    }

    if (((await balances.get(pubkey, wbtc_address)) || 0n) < amt) {
      throw new Error('Insufficient token balance')
    }
    balances.set_check_positive(
      pubkey,
      wbtc_address,
      ((await balances.get(pubkey, wbtc_address)) || 0n) - amt,
    )

    balances.set_check_positive(
      pubkey,
      wbtc_address,
      ((await balances.get(pubkey, wbtc_address)) || 0n) - btc_fee,
    )

    return { success: true, data: { amt } }
  }
  catch (e: any) {
    console.error('Error in withdraw_request:', e)
    return { success: false, error_message: e.message }
  }
}

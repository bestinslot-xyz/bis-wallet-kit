// Swap constants with no dependencies of their own, so both the AMM engine
// (`uniswap_ops`) and the pure reporting helpers (`swap-reporting`) can import
// them without either dragging the other's dependencies into a bundle.

/**
 * The constant-product pool fee, in basis points. Charged by the pool on the way
 * in and already baked into the amounts `getAmountOut`/`getAmountIn` return, via
 * their 997/1000 factor — keep the two in step if either ever changes. The
 * `POOL_FEE_BPS` unit test pins this to that factor, so drift fails the build.
 */
export const POOL_FEE_BPS = 30n

import type { SignFunction } from '../provider/api'

/** A wallet prompt a multi-signature flow is about to raise. */
export interface SignRequest {
  /** 1-based index of this prompt within the flow. */
  step: number
  /**
   * How many prompts the flow raises in all, when that is known before the first one. Absent for flows
   * whose count depends on signed results, such as a wrap's gas-sizing rounds.
   */
  total?: number
}

export interface SignProgressOptions {
  /**
   * Called just before each wallet prompt the flow raises, so a UI can show "2 of 5". It runs
   * synchronously; an exception it throws is logged and does not interrupt the flow.
   */
  onSignRequest?: (request: SignRequest) => void
}

/**
 * Counts the wallet prompts of one flow and reports each through `onSignRequest`. Wrap the flow's
 * `signFn` with `wrap` so every PSBT signature is counted, and call `next` before each message signature.
 */
export class SignProgress {
  private step = 0
  private readonly onSignRequest: SignProgressOptions['onSignRequest']
  private readonly total: number | undefined

  constructor(options: SignProgressOptions = {}, total?: number) {
    this.onSignRequest = options.onSignRequest
    this.total = total
  }

  next(): void {
    this.step += 1
    if (!this.onSignRequest) return
    try {
      this.onSignRequest({ step: this.step, total: this.total })
    } catch (e) {
      console.error('onSignRequest threw', e)
    }
  }

  wrap(signFn: SignFunction): SignFunction {
    return (...args) => {
      this.next()
      return signFn(...args)
    }
  }
}

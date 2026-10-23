/**
 * Thrown when a backend request fails: the request did not complete, the response had a 4xx/5xx
 * status, or a 2xx body carried an `error` field.
 *
 * Branch on `code`, the backend's stable machine-readable code (e.g. `WALLET_KEY_MISMATCH`,
 * `FEES_INSUFFICIENT`, `SEQUENCER_HALTED`), and fall back to `status`. `detail` is the backend's
 * own English text; `message` is that text prefixed with `API Request Failed: `. `ref` is the
 * backend's ID for the failed request, which its logs carry too.
 */
export class BackendError extends Error {
  /**
   * @param detail The backend's error text, or a description of the transport failure.
   * @param status The HTTP status, or `undefined` when no response arrived.
   * @param code The backend's error code, when its body carried one.
   * @param url The requested URL.
   * @param ref The backend's request ID, when its body carried one.
   */
  constructor(
    readonly detail: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
    readonly url: string,
    readonly ref?: string
  ) {
    super(`API Request Failed: ${detail}`)
    this.name = 'BackendError'
  }
}

/** The error built from a JSON body with an `error` field, carrying its `code` and `ref`. */
export function backendErrorFromBody(body: any, status: number, url: string): BackendError {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return new BackendError(String(body.error), status, str(body.code), url, str(body.ref))
}

/**
 * Reads an error response body: a JSON `{ error, code, ref }` object, any other JSON value, or
 * plain text. An empty body falls back to the status line.
 */
export async function backendErrorFromResponse(
  response: Response,
  url: string
): Promise<BackendError> {
  const text = (await response.text().catch(() => '')).trim()
  try {
    const body = JSON.parse(text)
    if (body && typeof body === 'object' && !Array.isArray(body) && body.error != null) {
      return backendErrorFromBody(body, response.status, url)
    }
  } catch {
    // Plain-text body: the text itself is the detail.
  }
  const detail = text || `HTTP Error: ${response.status} ${response.statusText}`.trim()
  return new BackendError(detail, response.status, undefined, url)
}

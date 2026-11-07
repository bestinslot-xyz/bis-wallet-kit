/**
 * Sat-flow helpers for spending outputs that carry used BRC-20 inscriptions.
 *
 * A transaction's input sats fill its outputs in order: the inputs' sats line up end to end, each
 * output takes the next `value` sats, and the remainder is the fee. An inscription sits on one sat
 * of its output (its satpoint offset). The helpers here follow those sats so the transaction
 * builders can keep inscribed sats out of outputs that must start or stay clean.
 */

/** A half-open range `[start, end)` of sat offsets. */
export type SatRange = [number, number]

/** The inscription fields a cardinal output carries when its provider includes used BRC-20 inscriptions. */
export interface InscribedFields {
  value: number
  inscription_ids?: string[] | null
  satpoints?: string[] | null
}

/** An inscription on an output, at `offset` sats from the output's start. */
export interface InscriptionAt {
  id: string
  offset: number
}

/**
 * The inscriptions of an output by offset. An inscription whose satpoint is missing or does not
 * parse covers the whole output (`whole`), since its sat could be any of them.
 */
export function inscriptionsOf(utxo: InscribedFields): { at: InscriptionAt[]; whole: boolean } {
  const ids = utxo.inscription_ids ?? []
  const satpoints = utxo.satpoints ?? []
  const at: InscriptionAt[] = []
  let whole = false
  for (let i = 0; i < ids.length; i++) {
    const offset = Number(satpoints[i]?.split(':')[2])
    if (
      satpoints.length !== ids.length ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset >= utxo.value
    ) {
      whole = true
    } else {
      at.push({ id: ids[i]!, offset })
    }
  }
  return { at, whole }
}

/** Whether the output carries any inscription. */
export function isInscribed(utxo: InscribedFields): boolean {
  return (utxo.inscription_ids?.length ?? 0) > 0
}

/** The inscribed sat ranges of an output, relative to its start. */
export function inscribedRanges(utxo: InscribedFields): SatRange[] {
  const { at, whole } = inscriptionsOf(utxo)
  if (whole) return [[0, utxo.value]]
  return at.map(({ offset }) => [offset, offset + 1])
}

/**
 * Where the inscribed sats of the inputs land, as absolute ranges in the transaction's sat stream.
 * Inputs flagged `skip` (forced inputs whose inscriptions the caller places on purpose) contribute
 * none.
 */
export function inscribedSatRanges(inputs: { utxo: InscribedFields; skip: boolean }[]): SatRange[] {
  const ranges: SatRange[] = []
  let position = 0
  for (const { utxo, skip } of inputs) {
    if (!skip) {
      for (const [a, b] of inscribedRanges(utxo)) ranges.push([position + a, position + b])
    }
    position += utxo.value
  }
  return ranges
}

/** The absolute sat range each output takes, given the output values in order. */
export function outputRanges(values: number[]): SatRange[] {
  const ranges: SatRange[] = []
  let position = 0
  for (const value of values) {
    ranges.push([position, position + value])
    position += value
  }
  return ranges
}

/** The end of the last inscribed range overlapping `range`, or -1 when none does. */
export function lastInscribedEndIn(range: SatRange, inscribed: SatRange[]): number {
  let end = -1
  for (const [a, b] of inscribed) {
    if (a < range[1] && b > range[0]) end = Math.max(end, b)
  }
  return end
}

/**
 * The inscriptions each output receives, by output index, with offsets relative to the output's
 * start. `whole` marks an output that receives part of an input whose inscriptions have no usable
 * satpoints.
 */
export function inscriptionsByOutput(
  inputs: { utxo: InscribedFields; skip: boolean }[],
  values: number[]
): { at: InscriptionAt[]; whole: boolean }[] {
  const outs = outputRanges(values)
  const result = outs.map(() => ({ at: [] as InscriptionAt[], whole: false }))
  let position = 0
  for (const { utxo, skip } of inputs) {
    if (!skip) {
      const { at, whole } = inscriptionsOf(utxo)
      for (const { id, offset } of at) {
        const sat = position + offset
        const j = outs.findIndex(([a, b]) => sat >= a && sat < b)
        if (j !== -1) result[j]!.at.push({ id, offset: sat - outs[j]![0] })
      }
      if (whole) {
        const span: SatRange = [position, position + utxo.value]
        outs.forEach(([a, b], j) => {
          if (a < span[1] && b > span[0]) result[j]!.whole = true
        })
      }
    }
    position += utxo.value
  }
  return result
}

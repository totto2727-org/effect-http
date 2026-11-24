import { Array, Option, Record, String } from 'effect'

import type { Kind, Parsed, Preference } from './accepts.ts'
import type { QualityValue } from './acceptsGrammar.ts'
import { fullQuality, refusedQuality } from './acceptsGrammar.ts'

const unmatchedRank = -1
const wildcardRank = 0
const exactRank = 1
const mediaSubtypeRank = 1
const mediaExactRank = 2
// A type or subtype match always outranks any allowed number of parameters.
const mediaRangeWeight = 1000

const mediaSpecificity = (range: Preference, offer: Preference): number => {
  const [type, subtype] = String.split(range.value, '/')
  const [offeredType, offeredSubtype] = String.split(offer.value, '/')
  if ((type !== '*' && type !== offeredType) || (subtype !== '*' && subtype !== offeredSubtype)) {
    return unmatchedRank
  }
  const parameters = Record.toEntries(range.parameters)
  if (!Array.every(parameters, ([key, value]) => Option.contains(value)(Record.get(offer.parameters, key)))) {
    return unmatchedRank
  }
  if (type === '*') {
    return parameters.length
  }
  return (subtype === '*' ? mediaSubtypeRank : mediaExactRank) * mediaRangeWeight + parameters.length
}

const specificity = (kind: Kind, range: Preference, offer: Preference): number => {
  if (kind === 'mediaType') {
    return mediaSpecificity(range, offer)
  }
  if (range.value === '*') {
    return wildcardRank
  }
  if (kind === 'language') {
    return offer.value === range.value || String.startsWith(`${range.value}-`)(offer.value)
      ? String.split(range.value, '-').length
      : unmatchedRank
  }
  return range.value === offer.value ? exactRank : unmatchedRank
}

export const effectiveQuality = (parsed: Parsed, offer: Preference): QualityValue => {
  if (parsed.missing) {
    return fullQuality
  }
  const { kind } = parsed
  const best = Array.reduce(parsed.preferences, { quality: refusedQuality, rank: unmatchedRank }, (current, range) => {
    const rank = specificity(kind, range, offer)
    if (rank === unmatchedRank || rank < current.rank) {
      return current
    }
    if (rank === current.rank && current.quality <= range.quality) {
      return current
    }
    return { quality: range.quality, rank }
  })
  if (kind === 'encoding' && offer.value === 'identity' && best.rank < exactRank) {
    return best.rank === wildcardRank && best.quality === refusedQuality ? refusedQuality : fullQuality
  }
  return best.quality
}

import { DateTime, Option, Result, String } from 'effect'
import * as Headers from 'effect/http/Headers'

/** Accept only the canonical IMF-fixdate form, including the correct weekday. */
export const parse = (value: string) =>
  String.length(value) === 29
    ? Headers.parseHttpDate(value).pipe(
        Result.getSuccess,
        Option.filter((date) => DateTime.getPartUtc(date, 'year') >= 100 && Headers.formatHttpDate(date) === value),
      )
    : Option.none()

import { DateTime, Effect, Option, Result, Schema, SchemaGetter, SchemaIssue } from 'effect'
import { Headers } from 'effect/http'

const CanonicalHttpDate = Schema.DateTimeUtc.check(
  Schema.makeFilter((date) => DateTime.getPartUtc(date, 'year') >= 100, {
    expected: 'an HTTP date with year 0100 or later',
  }),
).pipe(Schema.brand('CanonicalHttpDate'))

const HttpDateFromHeader = Schema.String.check(Schema.isBetweenLength(29, 29)).pipe(
  Schema.decodeTo(CanonicalHttpDate, {
    decode: SchemaGetter.transformEffect((value, options) => {
      const date = Result.getSuccess(Headers.parseHttpDate(value))
      return Option.isSome(date) && Headers.formatHttpDate(date.value) === value
        ? Effect.succeed(date.value)
        : Effect.fail(new SchemaIssue.InvalidValue({ expected: 'a canonical IMF-fixdate' }, value, options))
    }),
    encode: SchemaGetter.transform(Headers.formatHttpDate),
  }),
)

/** Accept only the canonical IMF-fixdate form, including the correct weekday. */
export const parse = (value: string): Option.Option<typeof CanonicalHttpDate.Type> => decodeHttpDate(value)

const decodeHttpDate = Schema.decodeUnknownOption(HttpDateFromHeader)

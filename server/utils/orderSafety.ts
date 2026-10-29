/**
 * Order-identification and failure-classification rules that decide whether it is safe to
 * retry a leveraged entry. Kept out of the engine so the money-critical predicates can be
 * asserted directly instead of being re-derived from a stack trace.
 */

/** Binance caps clientOrderId at 36 characters of `[A-Za-z0-9_-]`. */
const CLIENT_ORDER_ID_MAX = 36;

/**
 * Deterministic per attempt: the id is the only handle that can prove, after a timeout, whether
 * this rung of the leverage ladder actually filled. The timestamp tail is what makes attempts
 * unique, so when a long symbol overflows the limit the symbol is trimmed, never the tail.
 */
export function makeEntryClientOrderId(
  symbol: string,
  side: 'LONG' | 'SHORT',
  leverage: number
): string {
  const ts = Date.now().toString(36);
  const suffix = `-${side[0]}${leverage}x-${ts}`;
  const budget = CLIENT_ORDER_ID_MAX - 'hft'.length - suffix.length;
  const head = symbol.slice(0, Math.max(1, budget));
  return `hft${head}${suffix}`;
}

/**
 * Failures that prove the order never reached the book: our own rate governor shedding the
 * request, and the validation codes Binance returns before matching. Anything else — socket
 * error, timeout, 5xx, unknown code — is ambiguous and must be resolved by query instead of
 * by re-sending, because a re-send on a live order doubles the position.
 */
const PRE_FILL_ERROR_CODES = new Set<number>([
  -9999, // shed by the local rate governor; nothing was sent
  -1008, // server busy before matching
  -1015, // too many requests
  -1013, // LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL filter failure
  -1106, // parameter invalid
  -1111, // precision over maximum
  -1114, // negative price
  -1116, // price less than minimum
  -1117, // price greater than maximum
  -1121, // invalid symbol
  -1122, // invalid side for this order type
  -1128, // bad reduceOnly
  -2019, // margin insufficient — the risk check runs before the book
  -4008, // risk denied by exchange
  -4112, // disable reduce-only cross order
  -4164, // min notional
]);

export function isAmbiguousOrderFailure(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  if (typeof code !== 'number') return true;
  return !PRE_FILL_ERROR_CODES.has(code);
}

/** A query result that still says the order is live must never be booked as a fill. */
export function isUnfilledOrderStatus(status: string): boolean {
  const s = (status || '').toUpperCase();
  return !['FILLED', 'PARTIALLY_FILLED', 'ACCEPTED'].includes(s);
}

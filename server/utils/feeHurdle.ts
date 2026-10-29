/**
 * The fee hurdle, expressed in the one unit the bot's exits are measured in: ROI on margin.
 *
 * Taker fees are charged on *notional*, ROI is measured on *margin*, so the break-even
 * hurdle scales with leverage. The consequence is the single most important fact about a
 * $2 levered scalping book: raising leverage never makes a trade easier to win, because the
 * excursion the tape offers and the fee the exchange takes both scale by the same factor.
 * Leverage only changes how fast a wrong trade is liquidated.
 */

/** Round-trip (entry + exit) taker cost as a percentage of margin ROI. */
export function roundTripFeeHurdleRoiPct(takerRate: number, leverage: number): number {
  return 2 * takerRate * leverage * 100;
}

/** The excursion a 15s ATR can realistically deliver, in the same ROI units. */
export function expectedExcursionRoiPct(atrPct: number, leverage: number): number {
  return atrPct * leverage;
}

export interface HurdleCheck {
  ok: boolean;
  hurdleRoiPct: number;
  expectedRoiPct: number;
  /** How many times the fee round trip fits inside the expected excursion. */
  ratio: number;
  requiredRatio: number;
}

/**
 * An entry only earns if the structure it is buying is larger than what the exchange charges
 * to open and close it, with margin for the retrace every exit pays for. Requiring
 * `requiredRatio` (default 2) means at least one whole round trip of fees is still left over
 * at the top of the expected move.
 */
export function clearsFeeHurdle(
  atrPct: number,
  takerRate: number,
  leverage: number,
  requiredRatio: number
): HurdleCheck {
  const hurdleRoiPct = roundTripFeeHurdleRoiPct(takerRate, leverage);
  const expectedRoiPct = expectedExcursionRoiPct(atrPct, leverage);
  const ratio = hurdleRoiPct > 0 ? expectedRoiPct / hurdleRoiPct : 0;
  return {
    ok: ratio >= requiredRatio,
    hurdleRoiPct,
    expectedRoiPct,
    ratio,
    requiredRatio,
  };
}

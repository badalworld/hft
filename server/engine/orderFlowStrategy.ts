import type {
  AdaptiveStyleParams,
  OrderBookSnapshot,
  OrderFlowDecision,
  OrderFlowSnapshot,
  OrderFlowVerdict,
} from '../types.js';
import { roundTripFeeHurdleRoiPct } from '../utils/feeHurdle.js';

export interface OrderFlowEvaluation {
  side: 'LONG' | 'SHORT';
  book: OrderBookSnapshot | null;
  flow: OrderFlowSnapshot | null;
  params: Pick<
    AdaptiveStyleParams,
    | 'orderFlowMinObi'
    | 'orderFlowMinVolumeRatio'
    | 'orderFlowAbsorptionMultiple'
    | 'minFeeHurdleMultiple'
  >;
  /** Expected 15s excursion in margin-ROI %, and the leverage that produced it. */
  expectedRoiPct?: number;
  leverage?: number;
  takerFeeRate?: number;
  bookMaxAgeMs?: number;
}

const DEFAULT_BOOK_MAX_AGE_MS = 5_000;
/** A tape window thinner than this cannot say anything about pressure. */
const MIN_TAPE_SAMPLES = 5;
/** Up to this much price progress, "aggression with no movement" is absorption. */
const ABSORPTION_PRICE_PROGRESS_PCT = 0.05;
/** Touch depth at or above its own baseline means the resting side refilled. */
const REFILL_CONFIRM = 1.05;
/**
 * A pullback trigger and an exact "new window extreme" test cannot both be true, so the
 * price confirmation asks whether the tape has reclaimed the leading half of its own range.
 * That is the "reclaims a key level" leg of the rule rather than its "breaks a high" leg.
 */
const PRICE_LOCATION_CONFIRM = 0.5;

function reject(
  side: 'LONG' | 'SHORT',
  verdict: OrderFlowVerdict,
  reason: string,
  ctx: Partial<OrderFlowDecision>
): OrderFlowDecision {
  return {
    verdict,
    side,
    ok: false,
    obi: null,
    cvdUsd: null,
    cvdSlopePct: null,
    buySellRatio: null,
    spreadBps: null,
    costRoiPct: null,
    expectedRoiPct: ctx.expectedRoiPct ?? null,
    absorption: 'NONE',
    updatedAt: Date.now(),
    ...ctx,
    reasons: [reason],
  };
}

/**
 * Order Flow Imbalance + Trade Aggression + Liquidity Confirmation.
 *
 * Six gates, in the order a desk would check them: is the data real, does the
 * spread-inclusive cost fit inside the expected move, is the book leaning our way, is the
 * executed tape agreeing and accelerating, has price reclaimed the leading half of its own
 * range, and is the move we are about to join actually being absorbed by the other side.
 * Every threshold is a hypothesis owned by the council, not a proven edge — which is why
 * the gate ships in shadow mode.
 */
export function evaluateOrderFlow(input: OrderFlowEvaluation): OrderFlowDecision {
  const { side, book, flow, params } = input;
  const expectedRoiPct = input.expectedRoiPct ?? null;

  if (!book) {
    return reject(side, 'NO_DATA', 'no depth snapshot for this symbol yet', { expectedRoiPct });
  }
  const maxAge = input.bookMaxAgeMs ?? DEFAULT_BOOK_MAX_AGE_MS;
  const bookAge = Date.now() - book.updatedAt;
  if (bookAge > maxAge) {
    return reject(
      side,
      'NO_DATA',
      `depth snapshot is ${(bookAge / 1000).toFixed(1)}s old (limit ${(maxAge / 1000).toFixed(1)}s)`,
      { expectedRoiPct, spreadBps: book.spreadBps, obi: book.obi }
    );
  }
  if (!flow || flow.samples < MIN_TAPE_SAMPLES) {
    return reject(
      side,
      'NO_SIGNAL',
      `tape window holds ${flow?.samples ?? 0} active second(s); need ${MIN_TAPE_SAMPLES}`,
      { expectedRoiPct, spreadBps: book.spreadBps, obi: book.obi }
    );
  }

  const ctx: Partial<OrderFlowDecision> = {
    obi: book.obi,
    cvdUsd: flow.cvdUsd,
    cvdSlopePct: flow.cvdSlopePct,
    buySellRatio: flow.buySellRatio,
    spreadBps: book.spreadBps,
    expectedRoiPct,
  };

  // 1. Execution: the spread is paid on top of the taker fees, so it belongs in the same
  // affordability ratio. A quote that is wide relative to the move is a loss before entry.
  if (expectedRoiPct !== null && input.leverage && input.takerFeeRate !== undefined) {
    const feeRoiPct = roundTripFeeHurdleRoiPct(input.takerFeeRate, input.leverage);
    const spreadRoiPct = (book.spreadBps / 10_000) * input.leverage * 100;
    const costRoiPct = feeRoiPct + spreadRoiPct;
    ctx.costRoiPct = costRoiPct;
    const requiredRatio = params.minFeeHurdleMultiple;
    if (costRoiPct > 0 && expectedRoiPct < costRoiPct * requiredRatio) {
      return reject(
        side,
        'EXECUTION_REJECT',
        `expected ${expectedRoiPct.toFixed(3)}% ROI cannot cover ${costRoiPct.toFixed(
          3
        )}% of fees+spread ${requiredRatio.toFixed(2)}x`,
        ctx
      );
    }
  }

  // 2. Book imbalance. Weighted top-20 depth; the leading side has to dominate.
  const obiFloor = Math.abs(params.orderFlowMinObi);
  const obiOk = side === 'LONG' ? book.obi >= obiFloor : book.obi <= -obiFloor;
  if (!obiOk) {
    return reject(
      side,
      'OBI_REJECT',
      `book OBI ${book.obi.toFixed(4)} is inside the ±${obiFloor.toFixed(4)} neutral band`,
      ctx
    );
  }

  // 3. Executed delta. Both the level and the slope must agree: a positive CVD that is
  // already fading is the exhaustion print this layer exists to refuse.
  const cvdLevelOk = side === 'LONG' ? flow.cvdUsd > 0 : flow.cvdUsd < 0;
  const cvdSlopeOk = side === 'LONG' ? flow.cvdSlopeUsd > 0 : flow.cvdSlopeUsd < 0;
  if (!cvdLevelOk || !cvdSlopeOk) {
    return reject(
      side,
      'CVD_REJECT',
      `CVD $${flow.cvdUsd.toFixed(2)} (${(flow.cvdSlopePct * 100).toFixed(
        3
      )}% slope) is not ${side === 'LONG' ? 'positive and rising' : 'negative and falling'}`,
      ctx
    );
  }

  // 4. Aggressive volume ratio, denominated in the aggressor's own size. For a SHORT the
  // reciprocal is compared, so 1.5x buying and 0.67x buying are the same evidence mirrored.
  const ratio = params.orderFlowMinVolumeRatio;
  const ratioOk = side === 'LONG' ? flow.buySellRatio >= ratio : 1 / flow.buySellRatio >= ratio;
  if (!ratioOk) {
    return reject(
      side,
      'RATIO_REJECT',
      `${flow.buySellRatio.toFixed(3)}x aggressive buy/sell does not clear ${ratio.toFixed(3)}x on the ${side} side`,
      ctx
    );
  }

  // 5. Price confirmation: the leading half of the window's own range.
  const range = flow.windowHigh - flow.windowLow;
  const location = range > 0 ? (flow.lastPrice - flow.windowLow) / range : 0.5;
  const priceOk =
    side === 'LONG' ? location >= PRICE_LOCATION_CONFIRM : location <= 1 - PRICE_LOCATION_CONFIRM;
  if (!priceOk) {
    return reject(
      side,
      'PRICE_REJECT',
      `price sits at ${(location * 100).toFixed(1)}% of its ${flow.windowSec}s range; ${side} needs the ${
        side === 'LONG' ? 'upper' : 'lower'
      } half`,
      ctx
    );
  }

  // 6. Absorption: heavy initiator flow that the resting side is quietly eating. Entering
  // with the aggressor here means selling into a wall that has already proven it holds.
  const aggression = side === 'LONG' ? flow.buyAggressionMultiple : flow.sellAggressionMultiple;
  const progressPct = side === 'LONG' ? flow.priceChangePct : -flow.priceChangePct;
  const refill = side === 'LONG' ? book.askRefillRatio : book.bidRefillRatio;
  const absorbed =
    aggression >= params.orderFlowAbsorptionMultiple &&
    progressPct <= ABSORPTION_PRICE_PROGRESS_PCT &&
    refill >= REFILL_CONFIRM;
  if (absorbed) {
    return reject(
      side,
      'ABSORPTION_REJECT',
      `${side === 'LONG' ? 'buy' : 'sell'} aggression ${aggression.toFixed(2)}x moved price ${flow.priceChangePct.toFixed(
        3
      )}% while the ${side === 'LONG' ? 'ask' : 'bid'} touch refilled ${refill.toFixed(2)}x — the other side is absorbing`,
      { ...ctx, absorption: side === 'LONG' ? 'ABSORBED_BUYERS' : 'ABSORBED_SELLERS' }
    );
  }

  return {
    verdict: 'CONFIRM',
    side,
    ok: true,
    reasons: [
      `OBI ${book.obi.toFixed(4)}, CVD $${flow.cvdUsd.toFixed(2)} ${
        flow.cvdSlopePct >= 0 ? 'rising' : 'falling'
      }, ${flow.buySellRatio.toFixed(3)}x aggressor ratio, price at ${(location * 100).toFixed(
        1
      )}% of range`,
    ],
    obi: book.obi,
    cvdUsd: flow.cvdUsd,
    cvdSlopePct: flow.cvdSlopePct,
    buySellRatio: flow.buySellRatio,
    spreadBps: book.spreadBps,
    costRoiPct: ctx.costRoiPct ?? null,
    expectedRoiPct,
    absorption: 'NONE',
    updatedAt: Date.now(),
  };
}

import type { AdaptiveStyleParams, EntryFeatureVector, LossAutopsy, LossRootCause } from '../types.js';
import { clamp, f6 } from '../utils/format.js';

/**
 * Loss forensics written the way a desk analyst writes them: the loss is attributed
 * to one mechanism, that mechanism is proved with the trade's own numbers, and the
 * fix is stated as something the entry gate or the exit logic can actually do.
 *
 * The arithmetic that drives every branch here is the fee hurdle. On a levered
 * perpetual, round-trip taker fees are charged on *notional*, but ROI is measured on
 * *margin*, so the hurdle scales with leverage: at 15x and 0.05% taker, a trade has
 * to clear +1.500000% ROI before it has earned nothing. A +1% spike is not a
 * near-miss, it is a guaranteed loss, and no exit logic can rescue it.
 */

export interface AutopsyInput {
  symbol: string;
  side: 'LONG' | 'SHORT';
  netPnl: number;
  grossPnl: number;
  binanceFees: number;
  initialMargin: number;
  leverage: number;
  entryPrice: number;
  exitPrice: number;
  finalRoiPct: number;
  peakRoiPct: number;
  worstRoiPct: number;
  durationSec: number;
  exitReason: string;
  features: EntryFeatureVector;
  params: AdaptiveStyleParams;
  /**
   * The guard value that was live when this position filled. The council can tighten or
   * loosen afterwards, and a post-mortem that re-judges an old exit against a newer level
   * invents a slippage that never happened (or hides a real one).
   */
  entryGuardRoiPct?: number;
}

/** The guard the trade was actually managed against. */
function liveGuardRoiPct(i: AutopsyInput): number {
  return typeof i.entryGuardRoiPct === 'number' ? i.entryGuardRoiPct : i.params.protectiveStopRoiPct;
}

/** ROI the position had to reach just to pay for its own round trip. */
export function feeHurdleRoiPct(binanceFees: number, initialMargin: number): number {
  return initialMargin > 0 ? (binanceFees / initialMargin) * 100 : 0;
}

/** The underlying price move with the trade's sign applied: positive means direction was right. */
function signedMovePct(side: 'LONG' | 'SHORT', entryPrice: number, exitPrice: number): number {
  if (!(entryPrice > 0)) return 0;
  const raw = ((exitPrice - entryPrice) / entryPrice) * 100;
  return side === 'LONG' ? raw : -raw;
}

const CAUSE_LABEL: Record<LossRootCause, string> = {
  EXIT_SLIPPAGE: 'Exit filled through the guard',
  TRAIL_TOO_LOOSE: 'Won the spike, gave it back',
  FEE_DRAG: 'Right direction, wrong hurdle',
  MOVE_TOO_SMALL_FOR_FEES: 'Move too small to pay for itself',
  ENTRY_INTO_SPENT_MOVE: 'Entered a move already over',
  ADVERSE_TAKER_FLOW: 'Bought the blow-off / sold the panic',
  ENTRY_TOO_EARLY: 'Pullback had not finished',
  REGIME_FADED: 'Momentum regime snapped back',
};

export function lossRootCauseLabel(cause: LossRootCause): string {
  return CAUSE_LABEL[cause];
}

/**
 * Ordered by how much damage each mechanism does and how confidently the trade
 * record can prove it. Slippage is checked first because it is a risk-of-ruin
 * problem: a guard that does not hold means the sizing is wrong for the book depth,
 * and no amount of better signal selection fixes that.
 */
function classify(i: AutopsyInput): { cause: LossRootCause; contributing: LossRootCause[] } {
  const hurdle = feeHurdleRoiPct(i.binanceFees, i.initialMargin);
  const move = signedMovePct(i.side, i.entryPrice, i.exitPrice);
  const stopExit = /STOP_LOSS|PROTECTIVE/i.test(i.exitReason) && !/TRAILING/i.test(i.exitReason);
  const overshootPct = liveGuardRoiPct(i) - i.finalRoiPct;
  // Slippage must be measured in the unit the book actually moves — the underlying
  // price, not ROI. At 10x, 4% of ROI overshoot is a 0.40% price slip, which is what a
  // thin alt perp prints on any cascade; calling that a depth failure blames the exit
  // and lets a bad entry off the hook. Only a real hole through the guard qualifies.
  const leverage = Math.max(1, i.leverage || 10);
  const overshootMovePct = overshootPct / leverage;
  const depthFailure = stopExit && overshootPct >= 1 && overshootMovePct >= 0.5;
  const giveBackPct = i.peakRoiPct - i.finalRoiPct;
  const giveBackRatio = i.peakRoiPct > 0.5 ? clamp(giveBackPct / i.peakRoiPct, 0, 2) : 0;

  const causes: LossRootCause[] = [];
  if (i.grossPnl > 0 && i.netPnl <= 0) causes.push('FEE_DRAG');
  if (i.peakRoiPct > 0 && i.peakRoiPct < hurdle) causes.push('MOVE_TOO_SMALL_FOR_FEES');
  if (i.peakRoiPct >= i.params.trailingTriggerRoiPct && giveBackRatio > 0.4) causes.push('TRAIL_TOO_LOOSE');
  if (move < 0 && i.features.absChange24hPct >= 45) causes.push('ENTRY_INTO_SPENT_MOVE');
  if (i.worstRoiPct <= -4 && i.peakRoiPct < 2) causes.push('ENTRY_TOO_EARLY');

  if (depthFailure) return { cause: 'EXIT_SLIPPAGE', contributing: causes };
  if (i.peakRoiPct >= i.params.trailingTriggerRoiPct && giveBackRatio > 0.4)
    return { cause: 'TRAIL_TOO_LOOSE', contributing: causes };
  if (i.grossPnl > 0 && i.netPnl <= 0) return { cause: 'FEE_DRAG', contributing: causes };
  // A position that went deep before it ever went anywhere lost to its entry, not to
  // its fees — the hurdle only explains losses on trades that actually moved.
  if (i.worstRoiPct <= -4 && i.peakRoiPct < 2) return { cause: 'ENTRY_TOO_EARLY', contributing: causes };
  if (i.peakRoiPct > 0 && i.peakRoiPct < hurdle)
    return { cause: 'MOVE_TOO_SMALL_FOR_FEES', contributing: causes };
  if (isLateStageChase(i)) return { cause: 'ADVERSE_TAKER_FLOW', contributing: causes };
  if (i.durationSec < 60 && i.peakRoiPct < 1)
    return { cause: 'ENTRY_INTO_SPENT_MOVE', contributing: causes };
  if (move < 0 && i.features.absChange24hPct >= 45)
    return { cause: 'ENTRY_INTO_SPENT_MOVE', contributing: causes };
  return { cause: 'REGIME_FADED', contributing: causes };
}

/**
 * Aggressor delta only reads as conviction when it arrives at a calm price. The same
 * spike at an RSI extreme is exhaustion — the side that is late is the side providing
 * liquidity to whoever is exiting — so a high delta there is adverse selection, not fuel.
 */
function isLateStageChase(i: AutopsyInput): boolean {
  const extremeRsi =
    i.side === 'LONG' ? i.features.rsi15s >= 68 : i.features.rsi15s <= 32;
  const heavyFlow = i.features.orderflowDeltaRatio >= 1.5;
  const rejected = i.features.wickRejectionRatio >= 0.45;
  return (extremeRsi && heavyFlow) || (extremeRsi && rejected);
}

export function diagnoseLoss(i: AutopsyInput): LossAutopsy {
  const hurdle = feeHurdleRoiPct(i.binanceFees, i.initialMargin);
  const move = signedMovePct(i.side, i.entryPrice, i.exitPrice);
  const giveBackPct = i.peakRoiPct - i.finalRoiPct;
  const captureRatio =
    i.peakRoiPct > 0.5 ? clamp(i.finalRoiPct / i.peakRoiPct, -1, 1) : 0;
  const { cause, contributing } = classify(i);
  const f = i.features;

  const evidence: LossAutopsy['evidence'] = {
    feeHurdleRoiPct: Number(hurdle.toFixed(6)),
    peakRoiPct: Number(i.peakRoiPct.toFixed(6)),
    worstRoiPct: Number(i.worstRoiPct.toFixed(6)),
    finalRoiPct: Number(i.finalRoiPct.toFixed(6)),
    underlyingMovePct: Number(move.toFixed(6)),
    mfeGiveBackPct: Number(giveBackPct.toFixed(6)),
    mfeCaptureRatio: Number(captureRatio.toFixed(6)),
    durationSec: Number(i.durationSec.toFixed(6)),
    leverage: Number(i.leverage.toFixed(6)),
    rsi15s: Number(f.rsi15s.toFixed(6)),
    orderflowDeltaRatio: Number(f.orderflowDeltaRatio.toFixed(6)),
    absChange24hPct: Number(f.absChange24hPct.toFixed(6)),
  };

  const head = `${i.symbol} ${i.side} @ ${i.leverage}x on $${f6(i.initialMargin)} margin:`;
  let whyItHappened = '';
  let avoidanceRule = '';
  let executionUpdate = '';

  switch (cause) {
    case 'EXIT_SLIPPAGE': {
      const guard = liveGuardRoiPct(i);
      const overshoot = i.finalRoiPct - guard;
      whyItHappened = `${head} the protective guard was ${f6(guard)}% ROI but the fill printed ${f6(
        i.finalRoiPct
      )}% — ${f6(Math.abs(overshoot))}% through the level. A stop is a promise about price, and on a thin alt-perp book during a cascade that promise is only worth the depth sitting inside the spread. The order was right; the size was too big for the liquidity available at the worst moment.`;
      avoidanceRule = `Stand down on ${i.symbol} unless the 15s range can carry this position out at no more than ${f6(
        guard
      )}% ROI. A guard that overshoots by more than 1% is a depth problem, and depth does not improve when the market is falling.`;
      executionUpdate = `Cut ${i.side} size on this band until a stop fill lands within 1% of the guard, and treat a market-exit fill beyond the guard as a hard veto on re-entry in the same move.`;
      break;
    }
    case 'TRAIL_TOO_LOOSE': {
      whyItHappened = `${head} the position reached +${f6(
        i.peakRoiPct
      )}% ROI and closed at +${f6(i.finalRoiPct)}%, handing back ${f6(giveBackPct)}% — ${f6(
        (1 - captureRatio) * 100
      )}% of the excursion. Crypto perp spikes are short and reflexive: the liquidity that pushed price up is the same liquidity that pulls it, and the retrace usually completes inside a few 15s bars. A callback that trails by ${f6(
        i.params.trailingCallbackRoiPct
      )}% ROI is sized for a trend, not for a squeeze.`;
      avoidanceRule = `On any ${i.side} whose peak clears the ${f6(
        i.params.trailingTriggerRoiPct
      )}% trigger, bank at least 60% of the excursion. Past that point the trade is over and what remains is a gamble on a second leg that rarely arrives.`;
      executionUpdate = `Tighten the trailing callback so a +${f6(
        i.peakRoiPct
      )}% peak cannot settle below +${f6(i.peakRoiPct * 0.6)}%, and keep the floor above the ${f6(
        hurdle
      )}% fee hurdle so a banked trade is actually a paid trade.`;
      break;
    }
    case 'FEE_DRAG': {
      whyItHappened = `${head} direction was correct — price moved ${f6(move)}% in our favour for +$${f6(
        i.grossPnl
      )} gross — and the whole of it went to Binance. Taker is charged on notional both ways, so at ${i.leverage}x the round trip cost $${f6(
        i.binanceFees
      )}, which is ${f6(hurdle)}% of margin. The trade had to reach +${f6(
        hurdle
      )}% ROI to break even and peaked at +${f6(i.peakRoiPct)}%.`;
      avoidanceRule = `Do not take a ${i.side} in this band unless the 15s structure offers at least ${f6(
        hurdle * 2
      )}% ROI of headroom. Under twice the hurdle, the expected value is negative before any adverse selection is counted.`;
      executionUpdate = `Raise the trailing floor from ${f6(
        i.params.trailingFloorRoiPct
      )}% to at least ${f6(hurdle + 0.5)}% so profit is banked above the fee line, and skip setups whose recent 15s range cannot produce that excursion.`;
      break;
    }
    case 'MOVE_TOO_SMALL_FOR_FEES': {
      whyItHappened = `${head} the entire favourable excursion was +${f6(
        i.peakRoiPct
      )}% ROI, below the ${f6(hurdle)}% the round-trip taker fee costs at ${
        i.leverage
      }x. This position was never able to finish green — the loss was locked in the moment it opened. The signal was a real micro-move in a low-energy tape, and leverage turned a small move into a small edge that fees ate.`;
      avoidanceRule = `Reject ${i.side} candidates on this band when the 15s ATR and pullback depth (measured ${f6(
        f.pullbackDepthPct
      )}%) cannot plausibly out-run ${f6(hurdle)}% of margin ROI. Small-structure entries are only worth taking at low leverage, where the hurdle shrinks.`;
      executionUpdate = `Require a wider 15s range before entering this band, or drop the start leverage so the fee hurdle falls with it — the hurdle is ${f6(
        hurdle
      )}% at ${i.leverage}x and roughly ${f6(
        (i.binanceFees / (i.initialMargin || 1)) * 100 * (5 / (i.leverage || 1))
      )}% at 5x.`;
      break;
    }
    case 'ENTRY_INTO_SPENT_MOVE': {
      whyItHappened = `${head} we entered after a 24h move of ${f6(
        f.absChange24hPct
      )}% and held ${f6(i.durationSec)}s. Over-extended perp moves do not continue smoothly — they are liquidation fuel, and the squeeze that produced the print is over the instant the funding and the late longs are loaded. Peak ROI reached only +${f6(
        i.peakRoiPct
      )}% before the reversal took it to ${f6(i.worstRoiPct)}%.`;
      avoidanceRule = `No fresh ${i.side} once the 24h move exceeds ${f6(
        Math.min(i.params.max24hOverextensionPct, 45)
      )}% without a full 15s pullback and re-confirmation first. Buying the last leg of a vertical move is where late money exits.`;
      executionUpdate = `Lower the 24h overextension cap from ${f6(
        i.params.max24hOverextensionPct
      )}% and require a deeper pullback (${f6(f.pullbackDepthPct)}% measured) before re-arming this symbol.`;
      break;
    }
    case 'ADVERSE_TAKER_FLOW': {
      whyItHappened = `${head} the entry read as strength — RSI ${f6(f.rsi15s)}, aggressor delta ${f6(
        f.orderflowDeltaRatio
      )}x — but that combination at a 15s extreme is exhaustion, not conviction. When the aggressor prints pile up at an RSI ${
        i.side === 'LONG' ? 'high' : 'low'
      }, the marginal buyer is providing exit liquidity to whoever is already in. Wick rejection on the confirmation bar was ${f6(
        f.wickRejectionRatio
      )}, which is the tape telling us the level had already been defended.`;
      avoidanceRule = `Treat delta above 1.5x at RSI ${
        i.side === 'LONG' ? '>=68' : '<=32'
      } as a warning, not a signal. Require the confirmation bar to close with a body ratio above ${f6(
        i.params.minConfirmationBodyRatio
      )} and wick rejection below 0.35 before calling it momentum.`;
      executionUpdate = `Refuse entries in this band when RSI is at the extreme and wick rejection is high; demand a mean-reversion bar (lower RSI for ${
        i.side === 'LONG' ? 'LONG' : 'SHORT'
      }) rather than paying up into the exhaustion print.`;
      break;
    }
    case 'ENTRY_TOO_EARLY': {
      whyItHappened = `${head} price went to ${f6(i.worstRoiPct)}% ROI before it ever reached +${f6(
        i.peakRoiPct
      )}%. We bought into a pullback that was still in progress: RSI ${f6(f.rsi15s)} and delta ${f6(
        f.orderflowDeltaRatio
      )}x said the reversal had started, but not that it had finished. In a 15s pullback the first bounce is the one that gets sold hardest, because the sellers are still covering their own size.`;
      avoidanceRule = `On this band, require the drawdown leg to be over before entering: RSI reset to ${
        i.side === 'LONG' ? 'below 45' : 'above 55'
      } and at least one 15s bar that holds the prior extreme. Entering the first bounce pays for someone else's exit.`;
      executionUpdate = `Wait for a deeper RSI cooldown and stronger delta than this entry used (${f6(
        f.rsi15s
      )} / ${f6(f.orderflowDeltaRatio)}x), and widen the per-symbol cooldown after a loss so the same unfinished pullback is not re-entered immediately.`;
      break;
    }
    case 'REGIME_FADED':
    default: {
      whyItHappened = `${head} the setup printed as designed (RSI ${f6(f.rsi15s)}, delta ${f6(
        f.orderflowDeltaRatio
      )}x, body ${f6(f.candleBodyRatio)}) and the position reached +${f6(
        i.peakRoiPct
      )}% ROI before the 24h momentum of ${f6(
        f.absChange24hPct
      )}% mean-reverted underneath it. This is a regime cost, not an execution error: the entry logic was followed and the market changed its mind.`;
      avoidanceRule = `Keep ${i.side} exposure in this band only while the wider tape confirms it. When a ${f6(
        f.absChange24hPct
      )}% 24h move is already more than half digested on the 15s, the remaining flow is against us.`;
      executionUpdate = `Hold the entry rules and re-check the regime filter rather than the exit logic — ${f6(
        i.params.minOrderflowDeltaRatio
      )}x delta and ${f6(
        i.params.minConfirmationBodyRatio
      )} body are still the right asks; the cap on 24h overextension is what this trade argues about.`;
      break;
    }
  }

  return {
    rootCause: cause,
    rootCauseLabel: CAUSE_LABEL[cause],
    contributingCauses: contributing.filter((c) => c !== cause),
    evidence,
    whyItHappened,
    avoidanceRule,
    executionUpdate,
  };
}

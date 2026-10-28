import type {
  AdaptiveStyleParams,
  EntryFeatureVector,
  SignalStage,
} from '../types.js';
import type { TechnicalSnapshot15s } from '../binance/candleBuilder15s.js';
import { f6 } from '../utils/format.js';

export interface Strategy15sEvaluation {
  stage: SignalStage;
  pullbackDepthPct: number;
  triggered: boolean;
  reason: string;
  features: EntryFeatureVector;
}

export function evaluate15sPullbackStrategy(params: {
  side: 'LONG' | 'SHORT';
  absChange24hPct: number;
  snap: TechnicalSnapshot15s;
  style: AdaptiveStyleParams;
  inPosition: boolean;
  inCooldown: boolean;
}): Strategy15sEvaluation {
  const { side, absChange24hPct, snap, style, inPosition, inCooldown } = params;

  const bar = snap.lastClosed;
  const prev = snap.prevClosed;

  const range = bar ? Math.max(bar.high - bar.low, bar.close * 0.0001) : 1;
  const body = bar ? Math.abs(bar.close - bar.open) : 0;
  const candleBodyRatio = bar ? body / range : 0;

  let wickRejectionRatio = 0;
  if (bar) {
    if (side === 'LONG') {
      const lowerWick = Math.min(bar.open, bar.close) - bar.low;
      wickRejectionRatio = lowerWick / range;
    } else {
      const upperWick = bar.high - Math.max(bar.open, bar.close);
      wickRejectionRatio = upperWick / range;
    }
  }

  let pullbackDepthPct = 0;
  if (bar && snap.recentHigh > 0 && snap.recentLow > 0) {
    if (side === 'LONG') {
      const dipLow = prev ? Math.min(bar.low, prev.low) : bar.low;
      pullbackDepthPct = Math.max(0, ((snap.recentHigh - dipLow) / snap.recentHigh) * 100);
    } else {
      const bounceHigh = prev ? Math.max(bar.high, prev.high) : bar.high;
      pullbackDepthPct = Math.max(0, ((bounceHigh - snap.recentLow) / snap.recentLow) * 100);
    }
  }

  const emaSpreadPct =
    snap.ema21 > 0 ? ((snap.ema9 - snap.ema21) / snap.ema21) * 100 : 0;

  const features: EntryFeatureVector = {
    rsi15s: snap.rsi7,
    emaSpreadPct,
    pullbackDepthPct,
    orderflowDeltaRatio: snap.orderflowDeltaRatio,
    candleBodyRatio,
    wickRejectionRatio,
    absChange24hPct,
    volatilityAtrPct: snap.atrPct,
    aiConfidence: 0.5,
    leverageUsed: 10,
  };

  if (inPosition) {
    return {
      stage: 'IN_POSITION',
      pullbackDepthPct,
      triggered: false,
      reason: 'Active running position — monitored every 1.000000s',
      features,
    };
  }

  if (inCooldown) {
    return {
      stage: 'COOLDOWN',
      pullbackDepthPct,
      triggered: false,
      reason: 'Post-trade cooldown guard active',
      features,
    };
  }

  if (!bar || !prev || snap.candleCount < 4) {
    return {
      stage: 'MONITORING',
      pullbackDepthPct,
      triggered: false,
      reason: `Building 15s candles (${snap.candleCount}/4 closed)`,
      features,
    };
  }

  if (side === 'LONG') {
    const hadPullback =
      pullbackDepthPct >= 0.08 &&
      (prev.close < prev.open ||
        snap.rsi7 <= style.pullbackRsiLongMax ||
        bar.low <= snap.ema9 * 1.0012);

    const trendIntact = bar.close >= snap.ema21 * 0.9935;

    if (!hadPullback || !trendIntact) {
      return {
        stage: 'MONITORING',
        pullbackDepthPct,
        triggered: false,
        reason: !trendIntact
          ? 'Below 15s EMA21 support — waiting structure reclaim'
          : `Awaiting 15s pullback (Dip=${f6(pullbackDepthPct)}%, RSI=${f6(snap.rsi7)})`,
        features,
      };
    }

    const bullishClose = bar.close > bar.open;
    const structureReclaim =
      bar.close > (prev.open + prev.close) / 2 || wickRejectionRatio >= 0.42;
    const convictionOk =
      candleBodyRatio >= style.minConfirmationBodyRatio || wickRejectionRatio >= 0.45;
    const orderflowOk = snap.orderflowDeltaRatio >= style.minOrderflowDeltaRatio;

    if (bullishClose && structureReclaim && convictionOk && orderflowOk) {
      return {
        stage: 'CONFIRMED_SIGNAL',
        pullbackDepthPct,
        triggered: true,
        reason: `15s Bullish Pullback Confirmed (Dip=${f6(pullbackDepthPct)}%, Delta=${f6(
          snap.orderflowDeltaRatio
        )}x)`,
        features,
      };
    }

    return {
      stage: 'PULLBACK_DETECTED',
      pullbackDepthPct,
      triggered: false,
      reason: `Pullback in zone (${f6(pullbackDepthPct)}%) — awaiting 15s bullish confirmation candle`,
      features,
    };
  } else {
    // SHORT on Top 20 Negative 24h Market Change Asset
    const hadBouncePullback =
      pullbackDepthPct >= 0.08 &&
      (prev.close > prev.open ||
        snap.rsi7 >= style.pullbackRsiShortMin ||
        bar.high >= snap.ema9 * 0.9988);

    const downtrendIntact = bar.close <= snap.ema21 * 1.0065;

    if (!hadBouncePullback || !downtrendIntact) {
      return {
        stage: 'MONITORING',
        pullbackDepthPct,
        triggered: false,
        reason: !downtrendIntact
          ? 'Above 15s EMA21 resistance — waiting breakdown'
          : `Awaiting 15s relief bounce (Bounce=${f6(pullbackDepthPct)}%, RSI=${f6(snap.rsi7)})`,
        features,
      };
    }

    const bearishClose = bar.close < bar.open;
    const structureBreak =
      bar.close < (prev.open + prev.close) / 2 || wickRejectionRatio >= 0.42;
    const convictionOk =
      candleBodyRatio >= style.minConfirmationBodyRatio || wickRejectionRatio >= 0.45;
    const orderflowOk = snap.orderflowDeltaRatio >= style.minOrderflowDeltaRatio;

    if (bearishClose && structureBreak && convictionOk && orderflowOk) {
      return {
        stage: 'CONFIRMED_SIGNAL',
        pullbackDepthPct,
        triggered: true,
        reason: `15s Bearish Pullback Confirmed (Bounce=${f6(pullbackDepthPct)}%, Delta=${f6(
          snap.orderflowDeltaRatio
        )}x)`,
        features,
      };
    }

    return {
      stage: 'PULLBACK_DETECTED',
      pullbackDepthPct,
      triggered: false,
      reason: `Relief bounce in zone (${f6(pullbackDepthPct)}%) — awaiting 15s bearish confirmation`,
      features,
    };
  }
}

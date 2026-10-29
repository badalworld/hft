export type StopKind = 'GUARD' | 'TRAIL';

export interface StopDecision {
  kind: StopKind;
  /** The tighter of the two levels — the price the exchange stop must sit at. */
  levelRoiPct: number;
  triggered: boolean;
}

/**
 * Decide the exit level for a position. The capital guard is ALWAYS live: arming the
 * trail can only raise the trigger, never remove it, so a decayed or missing trail can
 * never leave a position with no exit at all. The `kind` labels the level that was
 * actually breached — a collapse through the guard is a stop-loss, not a profit trail,
 * and the loss post-mortem classifies on exactly that difference.
 */
export function decideStop(
  roiPct: number,
  trailingActive: boolean,
  trailingStopRoiPct: number | null,
  guardRoiPct: number
): StopDecision {
  const trail = trailingActive && trailingStopRoiPct !== null ? trailingStopRoiPct : null;
  const levelRoiPct = trail === null ? guardRoiPct : Math.max(trail, guardRoiPct);
  const triggered = roiPct <= levelRoiPct;
  const breachedGuard = triggered && roiPct <= guardRoiPct;
  const kind: StopKind = trail === null || breachedGuard ? 'GUARD' : 'TRAIL';
  return { kind, levelRoiPct, triggered };
}

/**
 * Invert the ROI definition used by the engine:
 *   LONG  roi = (price - entry) * qty / margin * 100
 *   SHORT roi = (entry - price) * qty / margin * 100
 */
export function priceForRoi(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  initialMargin: number,
  quantity: number,
  roiPct: number
): number {
  if (!(entryPrice > 0) || !(initialMargin > 0) || !(quantity > 0)) return 0;
  const delta = (roiPct / 100) * (initialMargin / quantity);
  return side === 'LONG' ? entryPrice + delta : entryPrice - delta;
}

/**
 * Tick-round a stop trigger away from the trigger zone: a SELL stop floors (fires no
 * earlier than the guard), a BUY stop ceils. Rounding the other way would trip the
 * exchange stop the instant it is placed.
 */
export function roundStopPrice(
  price: number,
  tickSize: number,
  tickDecimals: number,
  side: 'LONG' | 'SHORT'
): string {
  const decimals = Math.min(Math.max(tickDecimals, 0), 12);
  if (!Number.isFinite(price) || price <= 0) return '';
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price.toFixed(decimals);
  const steps =
    side === 'LONG' ? Math.floor(price / tickSize + 1e-9) : Math.ceil(price / tickSize - 1e-9);
  return (steps * tickSize).toFixed(decimals);
}

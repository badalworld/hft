import type { ClosedTradeRecord, IncomeLedgerSummary, PnlLedger, PnlLedgerPoint, PnlLedgerStats } from '../types.js';

const EMPTY_STATS: PnlLedgerStats = {
  totalTrades: 0,
  winTrades: 0,
  lossTrades: 0,
  winRatePct: 0,
  longTrades: 0,
  shortTrades: 0,
  longWinTrades: 0,
  shortWinTrades: 0,
  longWinRatePct: 0,
  shortWinRatePct: 0,
  longNetPnl: 0,
  shortNetPnl: 0,
  totalGrossPnl: 0,
  totalBinanceFees: 0,
  totalFundingFees: 0,
  totalNetPnl: 0,
  feeDragPctOfGross: 0,
  bestTradeNet: 0,
  worstTradeNet: 0,
  avgWinNet: 0,
  avgLossNet: 0,
  firstTradeAt: null,
  lastTradeAt: null,
};

/**
 * Settled-trade analytics for the PNL Ledger panel. Pure: the engine feeds it the
 * persisted closed-trade history plus the exchange-reported income summary, and the
 * UI renders whatever comes back without recomputing anything.
 */
export function buildPnlLedger(
  history: ClosedTradeRecord[],
  income: IncomeLedgerSummary
): PnlLedger {
  const chronological = [...history].sort((a, b) => a.closedAt - b.closedAt);

  const points: PnlLedgerPoint[] = [];
  let cumulative = 0;
  const sideRunning: Record<'LONG' | 'SHORT', number> = { LONG: 0, SHORT: 0 };

  for (const t of chronological) {
    cumulative += t.netPnl;
    sideRunning[t.side] += t.netPnl;
    points.push({
      symbol: t.symbol,
      side: t.side,
      closedAt: t.closedAt,
      grossPnl: t.grossPnl,
      binanceFees: t.binanceFees,
      netPnl: t.netPnl,
      finalRoiPct: t.finalRoiPct,
      durationSec: t.durationSec,
      exitReason: t.exitReason,
      cumulativeNet: cumulative,
      cumulativeSideNet: sideRunning[t.side],
    });
  }

  if (points.length === 0) {
    return { stats: { ...EMPTY_STATS, totalFundingFees: income.fundingFeeTotal }, points: [], income };
  }

  let winTrades = 0;
  let longTrades = 0;
  let shortTrades = 0;
  let longWinTrades = 0;
  let shortWinTrades = 0;
  let longNetPnl = 0;
  let shortNetPnl = 0;
  let totalGrossPnl = 0;
  let totalBinanceFees = 0;
  let bestTradeNet = -Infinity;
  let worstTradeNet = Infinity;
  let winSum = 0;
  let lossSum = 0;

  for (const t of chronological) {
    totalGrossPnl += t.grossPnl;
    totalBinanceFees += t.binanceFees;
    if (t.netPnl > 0) {
      winTrades += 1;
      winSum += t.netPnl;
    } else {
      lossSum += t.netPnl;
    }
    if (t.netPnl > bestTradeNet) bestTradeNet = t.netPnl;
    if (t.netPnl < worstTradeNet) worstTradeNet = t.netPnl;

    if (t.side === 'LONG') {
      longTrades += 1;
      longNetPnl += t.netPnl;
      if (t.netPnl > 0) longWinTrades += 1;
    } else {
      shortTrades += 1;
      shortNetPnl += t.netPnl;
      if (t.netPnl > 0) shortWinTrades += 1;
    }
  }

  const totalTrades = chronological.length;
  const lossTrades = totalTrades - winTrades;
  const winRatePct = (winTrades / totalTrades) * 100;
  // Fees are booked as a positive magnitude, so gross profit consumed by taker fees
  // is the ratio the operator actually needs to beat with every trade.
  const feeDragPctOfGross =
    totalGrossPnl > 0 ? Math.min(100, (totalBinanceFees / totalGrossPnl) * 100) : 0;

  const stats: PnlLedgerStats = {
    totalTrades,
    winTrades,
    lossTrades,
    winRatePct,
    longTrades,
    shortTrades,
    longWinTrades,
    shortWinTrades,
    longWinRatePct: longTrades > 0 ? (longWinTrades / longTrades) * 100 : 0,
    shortWinRatePct: shortTrades > 0 ? (shortWinTrades / shortTrades) * 100 : 0,
    longNetPnl,
    shortNetPnl,
    totalGrossPnl,
    totalBinanceFees,
    totalFundingFees: income.fundingFeeTotal,
    totalNetPnl: cumulative,
    feeDragPctOfGross,
    bestTradeNet,
    worstTradeNet,
    avgWinNet: winTrades > 0 ? winSum / winTrades : 0,
    avgLossNet: lossTrades > 0 ? lossSum / lossTrades : 0,
    firstTradeAt: chronological[0].closedAt,
    lastTradeAt: chronological[totalTrades - 1].closedAt,
  };

  return { stats, points, income };
}

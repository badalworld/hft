import type {
  AdaptiveStyleParams,
  OpenTradePosition,
} from '../types.js';
import type { RawPositionRisk } from '../binance/restClient.js';
import type { StateStore } from './stateStore.js';
import { f6 } from '../utils/format.js';
import { logger } from '../utils/logger.js';

export interface ExitTriggerSignal {
  position: OpenTradePosition;
  reason: string;
}

export class PositionMonitor1s {
  private openPositions = new Map<string, OpenTradePosition>();

  constructor(private readonly stateStore: StateStore) {}

  private makeKey(symbol: string, positionSide: string): string {
    return `${symbol}:${positionSide}`;
  }

  public getOpenPositionsList(): OpenTradePosition[] {
    return Array.from(this.openPositions.values()).sort((a, b) => a.openedAt - b.openedAt);
  }

  public getOpenSymbolSet(): Set<string> {
    const s = new Set<string>();
    for (const p of this.openPositions.values()) {
      s.add(p.symbol);
    }
    return s;
  }

  public getTotalUsedMargin(): number {
    let sum = 0;
    for (const p of this.openPositions.values()) {
      sum += p.initialMargin;
    }
    return sum;
  }

  public getTotalUnrealizedGrossPnl(): number {
    let sum = 0;
    for (const p of this.openPositions.values()) {
      sum += p.grossPnl;
    }
    return sum;
  }

  /**
   * Reconciles live positions from Binance /fapi/v2/positionRisk + live WS mark prices every 1 second.
   */
  public syncFromBinanceRisks(
    rawRisks: RawPositionRisk[],
    markPrices: (sym: string) => number | undefined,
    commissionLookup: (sym: string) => number,
    style: AdaptiveStyleParams
  ): {
    exitsToExecute: ExitTriggerSignal[];
    externallyClosedPositions: OpenTradePosition[];
  } {
    const now = Date.now();
    const seenKeys = new Set<string>();
    const exitsToExecute: ExitTriggerSignal[] = [];

    for (const r of rawRisks) {
      if (!r.positionAmt || Math.abs(r.positionAmt) <= 0 || r.entryPrice <= 0) {
        continue;
      }

      const side: 'LONG' | 'SHORT' = r.positionAmt > 0 ? 'LONG' : 'SHORT';
      const key = this.makeKey(r.symbol, r.positionSide);
      seenKeys.add(key);

      const qty = Math.abs(r.positionAmt);
      const wsMark = markPrices(r.symbol);
      const markPrice = wsMark && wsMark > 0 ? wsMark : r.markPrice;
      const entryPrice = r.entryPrice;
      const leverage = Math.max(1, r.leverage || 10);

      const initialMargin =
        r.initialMargin > 0 ? r.initialMargin : (qty * entryPrice) / leverage;
      const notionalValue = qty * markPrice;

      const grossPnl =
        side === 'LONG' ? (markPrice - entryPrice) * qty : (entryPrice - markPrice) * qty;

      const takerRate = commissionLookup(r.symbol);
      const entryFee = qty * entryPrice * takerRate;
      const exitFee = qty * markPrice * takerRate;
      const binanceFees = entryFee + exitFee;
      const netPnl = grossPnl - binanceFees;

      const roiPct = initialMargin > 0 ? (grossPnl / initialMargin) * 100 : 0;

      const existing = this.openPositions.get(key);
      const persisted = this.stateStore.getOpenPositionMeta(key);

      const openedAt = existing?.openedAt ?? persisted?.openedAt ?? now;
      let trailingActive = existing?.trailingActive ?? persisted?.trailingActive ?? false;
      let peakRoiPct = Math.max(
        existing?.peakRoiPct ?? persisted?.peakRoiPct ?? roiPct,
        roiPct
      );
      let worstRoiPct = Math.min(
        existing?.worstRoiPct ?? persisted?.worstRoiPct ?? roiPct,
        roiPct
      );

      // Check 5.000000% ROI Trailing Stop Activation
      if (!trailingActive && roiPct >= style.trailingTriggerRoiPct) {
        trailingActive = true;
        peakRoiPct = Math.max(peakRoiPct, roiPct);
        logger.success(
          'MONITOR_1S',
          `🎯 ${r.symbol} (${side} ${leverage}x) achieved +${f6(
            roiPct
          )}% ROI (>= ${f6(style.trailingTriggerRoiPct)}%)! Trailing Stop ARMED.`,
          { symbol: r.symbol, roiPct, netPnl }
        );
      }

      let trailingStopRoiPct: number | null = null;
      if (trailingActive) {
        const dynamicTightener = peakRoiPct >= 14 ? 0.75 : peakRoiPct >= 9 ? 0.88 : 1.0;
        const effectiveCallback = style.trailingCallbackRoiPct * dynamicTightener;
        trailingStopRoiPct = Math.max(
          style.trailingFloorRoiPct,
          peakRoiPct - effectiveCallback
        );
      }

      const updatedPos: OpenTradePosition = {
        symbol: r.symbol,
        side,
        positionSide: r.positionSide,
        quantity: qty,
        leverage,
        entryPrice,
        markPrice,
        initialMargin,
        notionalValue,
        roiPct,
        grossPnl,
        binanceFees,
        netPnl,
        commissionRate: takerRate,
        openedAt,
        runningTimeSec: Math.max(0, (now - openedAt) / 1000),
        trailingActive,
        peakRoiPct,
        worstRoiPct,
        trailingStopRoiPct,
        protectiveStopRoiPct: style.protectiveStopRoiPct,
        lastCheckedAt: now,
        entryFeatures: existing?.entryFeatures ?? persisted?.entryFeatures,
      };

      this.openPositions.set(key, updatedPos);
      this.stateStore.setOpenPositionMeta(key, {
        symbol: r.symbol,
        openedAt,
        trailingActive,
        peakRoiPct,
        worstRoiPct,
        entryFeatures: updatedPos.entryFeatures,
      });

      // Evaluate exit triggers on 1-second check
      if (trailingActive && trailingStopRoiPct !== null && roiPct <= trailingStopRoiPct) {
        exitsToExecute.push({
          position: updatedPos,
          reason: `TRAILING_STOP_HIT (ROI ${f6(roiPct)}% <= Trail ${f6(
            trailingStopRoiPct
          )}%, Peak +${f6(peakRoiPct)}%)`,
        });
      } else if (!trailingActive && roiPct <= style.protectiveStopRoiPct) {
        exitsToExecute.push({
          position: updatedPos,
          reason: `PROTECTIVE_STOP_LOSS (ROI ${f6(roiPct)}% <= Guard ${f6(
            style.protectiveStopRoiPct
          )}%)`,
        });
      }
    }

    // Detect positions that were closed externally on Binance App/Web
    const externallyClosedPositions: OpenTradePosition[] = [];
    for (const [key, prevPos] of Array.from(this.openPositions.entries())) {
      if (!seenKeys.has(key)) {
        this.openPositions.delete(key);
        this.stateStore.removeOpenPositionMeta(key);
        externallyClosedPositions.push(prevPos);
      }
    }

    return { exitsToExecute, externallyClosedPositions };
  }

  /**
   * Fast sub-second / 1-second tick update from WebSocket markPrice between REST syncs
   */
  public tickRealtimePrices(
    markLookup: (sym: string) => number | undefined,
    style: AdaptiveStyleParams
  ): ExitTriggerSignal[] {
    const now = Date.now();
    const exits: ExitTriggerSignal[] = [];

    for (const [key, pos] of this.openPositions.entries()) {
      const mp = markLookup(pos.symbol);
      if (mp && mp > 0) {
        pos.markPrice = mp;
        pos.notionalValue = pos.quantity * mp;
        pos.grossPnl =
          pos.side === 'LONG'
            ? (mp - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - mp) * pos.quantity;
        const entryFee = pos.quantity * pos.entryPrice * pos.commissionRate;
        const exitFee = pos.quantity * mp * pos.commissionRate;
        pos.binanceFees = entryFee + exitFee;
        pos.netPnl = pos.grossPnl - pos.binanceFees;
        pos.roiPct = pos.initialMargin > 0 ? (pos.grossPnl / pos.initialMargin) * 100 : 0;

        if (pos.roiPct > pos.peakRoiPct) pos.peakRoiPct = pos.roiPct;
        if (pos.roiPct < pos.worstRoiPct) pos.worstRoiPct = pos.roiPct;

        if (!pos.trailingActive && pos.roiPct >= style.trailingTriggerRoiPct) {
          pos.trailingActive = true;
          logger.success(
            'MONITOR_1S',
            `🎯 ${pos.symbol} (${pos.side} ${pos.leverage}x) crossed +${f6(
              pos.roiPct
            )}% ROI! Trailing Stop ARMED.`
          );
        }

        if (pos.trailingActive) {
          const dynamicTightener =
            pos.peakRoiPct >= 14 ? 0.75 : pos.peakRoiPct >= 9 ? 0.88 : 1.0;
          pos.trailingStopRoiPct = Math.max(
            style.trailingFloorRoiPct,
            pos.peakRoiPct - style.trailingCallbackRoiPct * dynamicTightener
          );
          if (pos.roiPct <= pos.trailingStopRoiPct) {
            exits.push({
              position: pos,
              reason: `TRAILING_STOP_HIT (ROI ${f6(pos.roiPct)}% <= Trail ${f6(
                pos.trailingStopRoiPct
              )}%, Peak +${f6(pos.peakRoiPct)}%)`,
            });
          }
        } else if (pos.roiPct <= style.protectiveStopRoiPct) {
          exits.push({
            position: pos,
            reason: `PROTECTIVE_STOP_LOSS (ROI ${f6(pos.roiPct)}% <= Guard ${f6(
              style.protectiveStopRoiPct
            )}%)`,
          });
        }

        this.stateStore.setOpenPositionMeta(key, {
          symbol: pos.symbol,
          openedAt: pos.openedAt,
          trailingActive: pos.trailingActive,
          peakRoiPct: pos.peakRoiPct,
          worstRoiPct: pos.worstRoiPct,
          entryFeatures: pos.entryFeatures,
        });
      }
      pos.runningTimeSec = Math.max(0, (now - pos.openedAt) / 1000);
      pos.lastCheckedAt = now;
    }

    return exits;
  }

  public registerNewlyOpenedPosition(pos: OpenTradePosition) {
    const key = this.makeKey(pos.symbol, pos.positionSide);
    this.openPositions.set(key, pos);
    this.stateStore.setOpenPositionMeta(key, {
      symbol: pos.symbol,
      openedAt: pos.openedAt,
      trailingActive: pos.trailingActive,
      peakRoiPct: pos.peakRoiPct,
      worstRoiPct: pos.worstRoiPct,
      entryFeatures: pos.entryFeatures,
    });
  }

  public removePosition(symbol: string, positionSide: string) {
    const key = this.makeKey(symbol, positionSide);
    this.openPositions.delete(key);
    this.stateStore.removeOpenPositionMeta(key);
  }
}

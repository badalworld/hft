import type { OrderFlowSnapshot } from '../types.js';

interface SecondBucket {
  /** Unix second this bucket covers. */
  t: number;
  buyUsd: number;
  sellUsd: number;
  buyQty: number;
  sellQty: number;
  firstPrice: number;
  lastPrice: number;
  high: number;
  low: number;
}

const RETENTION_SEC = 130;

/**
 * Cumulative Volume Delta and trade aggression, built from the aggTrade tape the
 * candle builder already consumes — no extra subscription, no extra weight.
 *
 * Every figure is in quote currency so a $2 margin position is compared against the
 * same units it will be filled in, and so a 0.1 BTC trade on a $100k book does not
 * drown out a real move on a $0.4 alt.
 */
export class OrderFlowTracker {
  private bucketsBySymbol = new Map<string, SecondBucket[]>();
  private lastIngestAt = new Map<string, number>();

  public ingest(
    symbol: string,
    price: number,
    qty: number,
    tradeTimeMs: number,
    isBuyerMaker: boolean
  ) {
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) return;

    const sec = Math.floor(tradeTimeMs / 1000) * 1000;
    const usd = price * qty;
    let buckets = this.bucketsBySymbol.get(symbol);
    if (!buckets) {
      buckets = [];
      this.bucketsBySymbol.set(symbol, buckets);
    }

    const last = buckets[buckets.length - 1];
    if (last && last.t === sec) {
      if (isBuyerMaker) {
        last.sellUsd += usd;
        last.sellQty += qty;
      } else {
        last.buyUsd += usd;
        last.buyQty += qty;
      }
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      last.lastPrice = price;
      this.lastIngestAt.set(symbol, Date.now());
      return;
    }

    buckets.push({
      t: sec,
      buyUsd: isBuyerMaker ? 0 : usd,
      sellUsd: isBuyerMaker ? usd : 0,
      buyQty: isBuyerMaker ? 0 : qty,
      sellQty: isBuyerMaker ? qty : 0,
      firstPrice: price,
      lastPrice: price,
      high: price,
      low: price,
    });

    // Trades arrive in time order in practice, but a warmup replay can interleave, so
    // trim by timestamp rather than by count.
    const cutoff = sec - RETENTION_SEC * 1000;
    let drop = 0;
    while (drop < buckets.length && buckets[drop].t < cutoff) drop++;
    if (drop > 0) buckets.splice(0, drop);

    this.lastIngestAt.set(symbol, Date.now());
  }

  public getLastIngestAt(symbol: string): number {
    return this.lastIngestAt.get(symbol) || 0;
  }

  public getSnapshot(symbol: string, windowSec: number): OrderFlowSnapshot | null {
    const buckets = this.bucketsBySymbol.get(symbol);
    if (!buckets || buckets.length === 0) return null;

    const now = Date.now();
    const span = Math.max(5, Math.round(windowSec)) * 1000;
    const from = now - span;
    const prevFrom = from - span;
    const midpoint = from + span / 2;

    let buyUsd = 0;
    let sellUsd = 0;
    let prevBuyUsd = 0;
    let prevSellUsd = 0;
    let cvdFirstHalf = 0;
    let cvdSecondHalf = 0;
    let samples = 0;
    let windowHigh = 0;
    let windowLow = 0;
    let firstPrice = 0;
    let lastPrice = 0;

    for (const b of buckets) {
      if (b.t < prevFrom) continue;

      if (b.t < from) {
        prevBuyUsd += b.buyUsd;
        prevSellUsd += b.sellUsd;
        continue;
      }

      buyUsd += b.buyUsd;
      sellUsd += b.sellUsd;
      samples++;
      if (firstPrice === 0) firstPrice = b.firstPrice;
      lastPrice = b.lastPrice;
      if (b.high > windowHigh) windowHigh = b.high;
      if (windowLow === 0 || b.low < windowLow) windowLow = b.low;

      const delta = b.buyUsd - b.sellUsd;
      if (b.t < midpoint) cvdFirstHalf += delta;
      else cvdSecondHalf += delta;
    }

    if (samples === 0 || lastPrice <= 0) return null;

    const turnover = buyUsd + sellUsd;
    const eps = 1e-9;
    const cvdUsd = buyUsd - sellUsd;
    const cvdSlopeUsd = cvdSecondHalf - cvdFirstHalf;

    return {
      symbol,
      windowSec: Math.round(windowSec),
      samples,
      buyUsd,
      sellUsd,
      buySellRatio: (buyUsd + eps) / (sellUsd + eps),
      cvdUsd,
      cvdSlopeUsd,
      cvdSlopePct: cvdSlopeUsd / (turnover + eps),
      priceChangePct: firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0,
      windowHigh,
      windowLow,
      lastPrice,
      buyAggressionMultiple: prevBuyUsd > eps ? buyUsd / prevBuyUsd : 1,
      sellAggressionMultiple: prevSellUsd > eps ? sellUsd / prevSellUsd : 1,
      updatedAt: now,
    };
  }

  public pruneSymbolsExcept(keepSymbols: Set<string>) {
    for (const sym of Array.from(this.bucketsBySymbol.keys())) {
      if (!keepSymbols.has(sym)) {
        this.bucketsBySymbol.delete(sym);
        this.lastIngestAt.delete(sym);
      }
    }
  }
}

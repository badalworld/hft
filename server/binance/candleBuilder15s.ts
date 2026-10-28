import type { Candle15s } from '../types.js';

export interface TechnicalSnapshot15s {
  symbol: string;
  candleCount: number;
  lastClosed: Candle15s | null;
  prevClosed: Candle15s | null;
  currentBar: Candle15s | null;
  ema9: number;
  ema21: number;
  rsi7: number;
  atrPct: number;
  recentHigh: number;
  recentLow: number;
  orderflowDeltaRatio: number; // buyVol / sellVol for LONG or sellVol / buyVol for SHORT
  rawBuySellRatio: number;
}

const INTERVAL_MS = 15_000;
const MAX_BARS_PER_SYMBOL = 80; // 20 minutes of 15-second bars

export class CandleBuilder15s {
  private barsBySymbol = new Map<string, Candle15s[]>();
  private onCandleCloseCallbacks: Array<(symbol: string, closedCandle: Candle15s) => void> = [];
  private boundaryTimer: NodeJS.Timeout | null = null;

  public start() {
    if (this.boundaryTimer) return;
    this.boundaryTimer = setInterval(() => {
      this.flushClosedBoundaries(Date.now());
    }, 500);
  }

  public stop() {
    if (this.boundaryTimer) {
      clearInterval(this.boundaryTimer);
      this.boundaryTimer = null;
    }
  }

  public onCandleClosed(cb: (symbol: string, closedCandle: Candle15s) => void) {
    this.onCandleCloseCallbacks.push(cb);
  }

  public ingestAggTrade(
    symbol: string,
    price: number,
    qty: number,
    tradeTimeMs: number,
    isBuyerMaker: boolean,
    emitCloseEvents = true
  ) {
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) return;

    const bucketStart = Math.floor(tradeTimeMs / INTERVAL_MS) * INTERVAL_MS;
    let bars = this.barsBySymbol.get(symbol);
    if (!bars) {
      bars = [];
      this.barsBySymbol.set(symbol, bars);
    }

    const quote = price * qty;
    const buyVol = isBuyerMaker ? 0 : qty;
    const sellVol = isBuyerMaker ? qty : 0;

    const lastBar = bars[bars.length - 1];

    if (!lastBar) {
      bars.push({
        symbol,
        openTime: bucketStart,
        closeTime: bucketStart + INTERVAL_MS - 1,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: qty,
        quoteVolume: quote,
        buyVolume: buyVol,
        sellVolume: sellVol,
        tradeCount: 1,
        isClosed: false,
      });
      return;
    }

    if (bucketStart === lastBar.openTime) {
      if (price > lastBar.high) lastBar.high = price;
      if (price < lastBar.low) lastBar.low = price;
      lastBar.close = price;
      lastBar.volume += qty;
      lastBar.quoteVolume += quote;
      lastBar.buyVolume += buyVol;
      lastBar.sellVolume += sellVol;
      lastBar.tradeCount += 1;
      return;
    }

    if (bucketStart > lastBar.openTime) {
      if (!lastBar.isClosed) {
        lastBar.isClosed = true;
        if (emitCloseEvents) {
          this.emitClosed(symbol, lastBar);
        }
      }

      // Fill any silent 15s gaps with flat continuity bars (max 6 gaps)
      let nextOpenTime = lastBar.openTime + INTERVAL_MS;
      let gapFillGuard = 0;
      while (nextOpenTime < bucketStart && gapFillGuard < 6) {
        bars.push({
          symbol,
          openTime: nextOpenTime,
          closeTime: nextOpenTime + INTERVAL_MS - 1,
          open: lastBar.close,
          high: lastBar.close,
          low: lastBar.close,
          close: lastBar.close,
          volume: 0,
          quoteVolume: 0,
          buyVolume: 0,
          sellVolume: 0,
          tradeCount: 0,
          isClosed: true,
        });
        nextOpenTime += INTERVAL_MS;
        gapFillGuard++;
      }

      bars.push({
        symbol,
        openTime: bucketStart,
        closeTime: bucketStart + INTERVAL_MS - 1,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: qty,
        quoteVolume: quote,
        buyVolume: buyVol,
        sellVolume: sellVol,
        tradeCount: 1,
        isClosed: false,
      });

      if (bars.length > MAX_BARS_PER_SYMBOL) {
        bars.splice(0, bars.length - MAX_BARS_PER_SYMBOL);
      }
    }
  }

  public warmupFromHistoricalAggTrades(
    symbol: string,
    trades: Array<{ p: string; q: string; T: number; m: boolean }>
  ) {
    if (!trades || trades.length === 0) return;
    const sorted = [...trades].sort((a, b) => a.T - b.T);
    for (const t of sorted) {
      this.ingestAggTrade(symbol, parseFloat(t.p), parseFloat(t.q), t.T, t.m, false);
    }
  }

  private flushClosedBoundaries(nowMs: number) {
    const currentBucket = Math.floor(nowMs / INTERVAL_MS) * INTERVAL_MS;
    for (const [symbol, bars] of this.barsBySymbol.entries()) {
      const lastBar = bars[bars.length - 1];
      if (!lastBar) continue;
      if (lastBar.openTime < currentBucket && !lastBar.isClosed) {
        lastBar.isClosed = true;
        this.emitClosed(symbol, lastBar);
        bars.push({
          symbol,
          openTime: currentBucket,
          closeTime: currentBucket + INTERVAL_MS - 1,
          open: lastBar.close,
          high: lastBar.close,
          low: lastBar.close,
          close: lastBar.close,
          volume: 0,
          quoteVolume: 0,
          buyVolume: 0,
          sellVolume: 0,
          tradeCount: 0,
          isClosed: false,
        });
        if (bars.length > MAX_BARS_PER_SYMBOL) {
          bars.splice(0, bars.length - MAX_BARS_PER_SYMBOL);
        }
      }
    }
  }

  private emitClosed(symbol: string, bar: Candle15s) {
    for (const cb of this.onCandleCloseCallbacks) {
      try {
        cb(symbol, bar);
      } catch {
        // ignore handler error
      }
    }
  }

  public pruneSymbolsExcept(keepSymbols: Set<string>) {
    for (const sym of this.barsBySymbol.keys()) {
      if (!keepSymbols.has(sym)) {
        this.barsBySymbol.delete(sym);
      }
    }
  }

  public getTechnicalSnapshot(symbol: string, intendedSide: 'LONG' | 'SHORT'): TechnicalSnapshot15s {
    const bars = this.barsBySymbol.get(symbol) || [];
    const closedBars = bars.filter((b) => b.isClosed);
    const currentBar = bars.find((b) => !b.isClosed) || bars[bars.length - 1] || null;
    const lastClosed = closedBars[closedBars.length - 1] || null;
    const prevClosed = closedBars[closedBars.length - 2] || null;

    const series = closedBars.length >= 3 ? closedBars : bars;
    const closes = series.map((b) => b.close);
    const fallbackPrice = currentBar?.close || lastClosed?.close || 0;

    const ema9 = computeEma(closes, 9, fallbackPrice);
    const ema21 = computeEma(closes, 21, fallbackPrice);
    const rsi7 = computeRsi(closes, 7);
    const atrPct = computeAtrPct(series, 10);

    const lookback = series.slice(-14);
    let recentHigh = fallbackPrice;
    let recentLow = fallbackPrice;
    for (const b of lookback) {
      if (b.high > recentHigh) recentHigh = b.high;
      if (b.low < recentLow || recentLow === 0) recentLow = b.low;
    }

    // Compute recent orderflow delta on active/last-closed bar
    const refBar =
      currentBar && currentBar.volume > 0
        ? currentBar
        : lastClosed || { buyVolume: 1, sellVolume: 1 };
    const eps = 1e-8;
    const rawBuySellRatio = (refBar.buyVolume + eps) / (refBar.sellVolume + eps);
    const orderflowDeltaRatio =
      intendedSide === 'LONG'
        ? rawBuySellRatio
        : (refBar.sellVolume + eps) / (refBar.buyVolume + eps);

    return {
      symbol,
      candleCount: closedBars.length,
      lastClosed,
      prevClosed,
      currentBar,
      ema9,
      ema21,
      rsi7,
      atrPct,
      recentHigh,
      recentLow,
      orderflowDeltaRatio: Math.min(9.999999, orderflowDeltaRatio),
      rawBuySellRatio: Math.min(9.999999, rawBuySellRatio),
    };
  }
}

function computeEma(values: number[], period: number, fallback: number): number {
  if (values.length === 0) return fallback;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeRsi(values: number[], period: number): number {
  if (values.length < 2) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  const start = Math.max(1, values.length - period * 3);

  let count = 0;
  for (let i = start; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (count < period) {
      avgGain += gain / period;
      avgLoss += loss / period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    count++;
  }

  if (avgLoss <= 1e-12) return avgGain > 0 ? 95 : 50;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeAtrPct(bars: Candle15s[], period: number): number {
  if (bars.length < 2) return 0.15;
  const slice = bars.slice(-(period + 1));
  let sumPct = 0;
  let n = 0;
  for (let i = 1; i < slice.length; i++) {
    const cur = slice[i];
    const prev = slice[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    if (cur.close > 0) {
      sumPct += (tr / cur.close) * 100;
      n++;
    }
  }
  return n > 0 ? sumPct / n : 0.15;
}

import type { OrderBookSnapshot } from '../types.js';

interface BookState {
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  obi: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  bidTouchUsd: number;
  askTouchUsd: number;
  /** Slow baseline of touch depth, used to tell a refill from a genuine pull. */
  bidTouchEma: number;
  askTouchEma: number;
  updatedAt: number;
}

const LEVELS = 20;
const TOUCH_LEVELS = 5;
const EMA_ALPHA = 0.05;
const STALE_MS = 5_000;

/**
 * Top-of-book state from the `<symbol>@depth20@500ms` partial snapshot stream.
 *
 * The book is treated as a full replacement on every frame — that is what the partial
 * depth stream is — so no diff sequencing or REST resync is needed. OBI is weighted by
 * level distance because resting size one tick from the touch is worth more than size
 * nineteen levels away, which is the difference between a wall and a wish.
 */
export class OrderBookTracker {
  private books = new Map<string, BookState>();

  public ingest(
    symbol: string,
    bids: Array<[number, number]>,
    asks: Array<[number, number]>,
    ts: number
  ) {
    const bid = bids.length > 0 ? bids[0][0] : 0;
    const ask = asks.length > 0 ? asks[0][0] : 0;
    if (!(bid > 0) || !(ask > 0) || ask <= bid) return;

    const mid = (bid + ask) / 2;
    const spreadBps = ((ask - bid) / mid) * 10_000;

    let bidWeighted = 0;
    let askWeighted = 0;
    let bidDepthUsd = 0;
    let askDepthUsd = 0;
    let bidTouchUsd = 0;
    let askTouchUsd = 0;

    const n = Math.min(LEVELS, bids.length, asks.length);
    for (let i = 0; i < n; i++) {
      const w = 1 / (1 + 0.2 * i);
      const bidNotional = bids[i][0] * bids[i][1];
      const askNotional = asks[i][0] * asks[i][1];
      bidWeighted += bidNotional * w;
      askWeighted += askNotional * w;
      bidDepthUsd += bidNotional;
      askDepthUsd += askNotional;
      if (i < TOUCH_LEVELS) {
        bidTouchUsd += bidNotional;
        askTouchUsd += askNotional;
      }
    }

    const totalWeighted = bidWeighted + askWeighted;
    const obi = totalWeighted > 0 ? (bidWeighted - askWeighted) / totalWeighted : 0;

    const prev = this.books.get(symbol);
    const bidTouchEma = prev ? prev.bidTouchEma * (1 - EMA_ALPHA) + bidTouchUsd * EMA_ALPHA : bidTouchUsd;
    const askTouchEma = prev ? prev.askTouchEma * (1 - EMA_ALPHA) + askTouchUsd * EMA_ALPHA : askTouchUsd;

    this.books.set(symbol, {
      bid,
      ask,
      mid,
      spreadBps,
      obi,
      bidDepthUsd,
      askDepthUsd,
      bidTouchUsd,
      askTouchUsd,
      bidTouchEma,
      askTouchEma,
      updatedAt: ts > 0 ? ts : Date.now(),
    });
  }

  public getSnapshot(symbol: string): OrderBookSnapshot | null {
    const b = this.books.get(symbol);
    if (!b) return null;
    return {
      symbol,
      bid: b.bid,
      ask: b.ask,
      mid: b.mid,
      spreadBps: b.spreadBps,
      obi: b.obi,
      bidDepthUsd: b.bidDepthUsd,
      askDepthUsd: b.askDepthUsd,
      bidTouchUsd: b.bidTouchUsd,
      askTouchUsd: b.askTouchUsd,
      // >1 means the touch is deeper than its own recent average — size came back
      // while price failed to move, which is what absorption looks like from here.
      bidRefillRatio: b.bidTouchEma > 0 ? b.bidTouchUsd / b.bidTouchEma : 1,
      askRefillRatio: b.askTouchEma > 0 ? b.askTouchUsd / b.askTouchEma : 1,
      updatedAt: b.updatedAt,
    };
  }

  public isFresh(symbol: string, maxAgeMs = STALE_MS): boolean {
    const b = this.books.get(symbol);
    return !!b && Date.now() - b.updatedAt <= maxAgeMs;
  }

  public getFreshCount(maxAgeMs = STALE_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    let n = 0;
    for (const b of this.books.values()) if (b.updatedAt >= cutoff) n++;
    return n;
  }

  public pruneSymbolsExcept(keepSymbols: Set<string>) {
    for (const sym of Array.from(this.books.keys())) {
      if (!keepSymbols.has(sym)) this.books.delete(sym);
    }
  }
}

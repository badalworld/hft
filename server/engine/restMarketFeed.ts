import type { BinanceFuturesRestClient } from '../binance/restClient.js';
import type { BinanceWsStreamManager, Ticker24hStreamItem } from '../binance/wsStreamManager.js';
import type { CandleBuilder15s } from '../binance/candleBuilder15s.js';
import { logger } from '../utils/logger.js';

// Some networks blackhole fstream.binance.com: the WebSocket upgrade succeeds
// and Binance even ACKs SUBSCRIBE, but no market data frame ever arrives, while
// REST on fapi.binance.com stays perfectly healthy. This feed reconstructs the
// whole market data path over REST so the 15s engine keeps trading there.
//
// Weight budget (2400/min per host, P3 calls are gated at 78% by the governor):
//   /fapi/v1/ticker/price  all symbols  w2  every 1s   =  120/min
//   /fapi/v1/ticker/24hr   all symbols  w40 every 10s  =  240/min
//   /fapi/v1/trades        per symbol   w5  40 per 15s =  800/min
//                                                 total ~1160/min
const PRICE_POLL_MS = 1000;
const TICKER24H_POLL_MS = 10_000;
const TRADE_SWEEP_MS = 15_000;
const TRADES_LIMIT = 1000;

// Binance returns trades newest-last; only ids above the watermark are new, so
// overlapping polls cannot double-count volume into a 15s bar.
export class RestMarketFeed {
  private priceTimer: NodeJS.Timeout | null = null;
  private ticker24hTimer: NodeJS.Timeout | null = null;
  private tradeTimer: NodeJS.Timeout | null = null;

  private watchedSymbols: string[] = [];
  private lastTradeIdBySymbol = new Map<string, number>();
  private sweepCursor = 0;
  private active = false;
  private tradeSweepInFlight = false;

  constructor(
    private readonly restClient: BinanceFuturesRestClient,
    private readonly wsManager: BinanceWsStreamManager,
    private readonly candleBuilder: CandleBuilder15s
  ) {}

  public isActive(): boolean {
    return this.active;
  }

  public setWatchedSymbols(symbols: string[]) {
    this.watchedSymbols = symbols;
  }

  public start() {
    if (this.active) return;
    this.active = true;
    logger.warn(
      'NETWORK',
      'Binance fstream WebSocket is not delivering data — engaging REST market data feed ' +
        '(1s prices, 10s 24h ranking, 15s trade tape) so 15s candles and trading stay live.'
    );

    this.priceTimer = setInterval(() => {
      this.pollPrices().catch(() => {});
    }, PRICE_POLL_MS);
    this.ticker24hTimer = setInterval(() => {
      this.poll24hTickers().catch(() => {});
    }, TICKER24H_POLL_MS);
    this.tradeTimer = setInterval(() => {
      this.sweepTrades().catch(() => {});
    }, TRADE_SWEEP_MS);

    this.pollPrices().catch(() => {});
    this.poll24hTickers().catch(() => {});
    this.sweepTrades().catch(() => {});
  }

  public stop() {
    if (!this.active) return;
    this.active = false;
    for (const t of [this.priceTimer, this.ticker24hTimer, this.tradeTimer]) {
      if (t) clearInterval(t);
    }
    this.priceTimer = null;
    this.ticker24hTimer = null;
    this.tradeTimer = null;
    logger.success(
      'NETWORK',
      'Binance WebSocket market data restored — standing down the REST market data feed.'
    );
  }

  private async pollPrices() {
    const rows = await this.restClient.getAllSymbolPrices();
    const map = new Map<string, number>();
    for (const r of rows) {
      const px = parseFloat(r.price);
      if (px > 0) map.set(r.symbol, px);
    }
    this.wsManager.ingestRestPrices(map);
  }

  private async poll24hTickers() {
    const rows = await this.restClient.get24hrTickers();
    const items: Ticker24hStreamItem[] = rows.map((r) => ({
      symbol: r.symbol,
      priceChangePercent: parseFloat(r.priceChangePercent || '0'),
      lastPrice: parseFloat(r.lastPrice || '0'),
      highPrice: parseFloat(r.highPrice || '0'),
      lowPrice: parseFloat(r.lowPrice || '0'),
      quoteVolume: parseFloat(r.quoteVolume || '0'),
    }));
    this.wsManager.ingestRestTickerBatch(items);
  }

  // Walks the watched basket round-robin so one slow symbol cannot starve the
  // rest, and so a shrinking weight budget degrades coverage instead of failing.
  private async sweepTrades() {
    if (this.tradeSweepInFlight || this.watchedSymbols.length === 0) return;
    this.tradeSweepInFlight = true;
    const basket = [...this.watchedSymbols];

    try {
      for (let i = 0; i < basket.length; i++) {
        const symbol = basket[(this.sweepCursor + i) % basket.length];
        try {
          await this.ingestSymbolTrades(symbol);
        } catch (err) {
          // -9999 is the rate governor protecting the budget; stop the sweep and
          // resume from here next cycle rather than hammering a closed window.
          if ((err as { code?: number }).code === -9999) {
            this.sweepCursor = (this.sweepCursor + i) % basket.length;
            return;
          }
        }
      }
      this.sweepCursor = 0;
    } finally {
      this.tradeSweepInFlight = false;
    }
  }

  private async ingestSymbolTrades(symbol: string) {
    const trades = await this.restClient.getRecentTrades(symbol, TRADES_LIMIT);
    if (!trades || trades.length === 0) return;

    const watermark = this.lastTradeIdBySymbol.get(symbol) ?? 0;
    let maxId = watermark;
    let ingested = 0;

    for (const t of trades) {
      if (t.id <= watermark) continue;
      const price = parseFloat(t.price);
      const qty = parseFloat(t.qty);
      this.candleBuilder.ingestAggTrade(symbol, price, qty, t.time, t.isBuyerMaker, true);
      ingested++;
      if (t.id > maxId) maxId = t.id;
    }

    if (maxId > watermark) this.lastTradeIdBySymbol.set(symbol, maxId);

    // First poll of a symbol seeds the watermark from history, so no bar is
    // built from a partial window that would skew its orderflow ratio.
    if (watermark === 0 && ingested > 0) {
      this.lastTradeIdBySymbol.set(symbol, maxId);
    }
  }

  public pruneSymbolsExcept(keep: Set<string>) {
    for (const sym of this.lastTradeIdBySymbol.keys()) {
      if (!keep.has(sym)) this.lastTradeIdBySymbol.delete(sym);
    }
  }
}

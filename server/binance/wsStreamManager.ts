import WebSocket from 'ws';
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { BinanceRateGovernor } from './rateGovernor.js';
import type { BinanceFuturesRestClient } from './restClient.js';
import type { CandleBuilder15s } from './candleBuilder15s.js';
import { logger } from '../utils/logger.js';

export interface Ticker24hStreamItem {
  symbol: string;
  priceChangePercent: number;
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
}

export type DepthBookFrame = {
  symbol: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  eventTimeMs: number;
};

export type AggTradeFrame = {
  symbol: string;
  price: number;
  qty: number;
  tradeTimeMs: number;
  isBuyerMaker: boolean;
};

export class BinanceWsStreamManager {
  private marketWs: WebSocket | null = null;
  private aggTradeWs: WebSocket | null = null;
  private depthWs: WebSocket | null = null;
  private userWs: WebSocket | null = null;

  private subscribedAggSymbols = new Set<string>();
  private desiredAggSymbols = new Set<string>();
  private subscribedDepthSymbols = new Set<string>();
  private markPrices = new Map<string, number>();
  private lastPrices = new Map<string, number>();

  private running = false;
  private marketReconnectTimer: NodeJS.Timeout | null = null;
  private aggReconnectTimer: NodeJS.Timeout | null = null;
  private depthReconnectTimer: NodeJS.Timeout | null = null;
  private userReconnectTimer: NodeJS.Timeout | null = null;
  private listenKeyKeepaliveTimer: NodeJS.Timeout | null = null;
  private reqIdCounter = 1;
  private boundLocalAddress: string | null = null;

  private onTickerBatchCb: ((items: Ticker24hStreamItem[]) => void) | null = null;
  private onMarkPriceTickCb: ((markMap: Map<string, number>) => void) | null = null;
  private onAccountUpdateCb: (() => void) | null = null;
  private onAggTradeCb: ((frame: AggTradeFrame) => void) | null = null;
  private onDepthBookCb: ((frame: DepthBookFrame) => void) | null = null;

  // A blackholed edge completes the TLS upgrade and even ACKs SUBSCRIBE, then
  // never sends a frame. Such a socket emits neither 'close' nor 'error', so
  // without these timestamps the reconnect/edge-rotation path never fires and
  // the engine sits on frozen prices while reporting "connected".
  private lastMarketFrameAt = 0;
  private lastAggFrameAt = 0;
  private lastDepthFrameAt = 0;
  private staleWatchdogTimer: NodeJS.Timeout | null = null;
  private marketStaleStrikes = 0;
  private aggStaleStrikes = 0;
  private depthStaleStrikes = 0;

  // !markPrice@arr@1s publishes every second and the agg basket spans 40 liquid
  // symbols, so silence well past these windows means the feed is dead.
  private static readonly MARKET_STALE_MS = 15_000;
  private static readonly AGG_STALE_MS = 25_000;
  // depth20@500ms is the fastest feed in the set, so a few quiet seconds on an
  // illiquid symbol must not kill a socket that is working for 39 others.
  private static readonly DEPTH_STALE_MS = 12_000;

  constructor(
    private readonly rateGovernor: BinanceRateGovernor,
    private readonly restClient: BinanceFuturesRestClient,
    private readonly candleBuilder: CandleBuilder15s
  ) {}

  public setBoundLocalAddress(addr: string | null) {
    this.boundLocalAddress = addr;
  }

  public onTickerBatch(cb: (items: Ticker24hStreamItem[]) => void) {
    this.onTickerBatchCb = cb;
  }

  public onMarkPriceTick(cb: (markMap: Map<string, number>) => void) {
    this.onMarkPriceTickCb = cb;
  }

  public onAccountUpdate(cb: () => void) {
    this.onAccountUpdateCb = cb;
  }

  public onAggTrade(cb: (frame: AggTradeFrame) => void) {
    this.onAggTradeCb = cb;
  }

  public onDepthBook(cb: (frame: DepthBookFrame) => void) {
    this.onDepthBookCb = cb;
  }

  public isDepthDataLive(): boolean {
    return Date.now() - this.lastDepthFrameAt < BinanceWsStreamManager.DEPTH_STALE_MS;
  }

  public getWatchedSymbolCount(): number {
    return this.desiredAggSymbols.size;
  }

  public getMarkPrice(symbol: string): number | undefined {
    return this.markPrices.get(symbol);
  }

  public getLastPrice(symbol: string): number | undefined {
    return this.lastPrices.get(symbol);
  }

  public startMarketStreams() {
    if (this.running) return;
    this.running = true;
    this.connectMarketWs();
    this.connectAggTradeWs();
    this.connectDepthWs();
    this.startStaleWatchdog();
  }

  public isMarketDataLive(): boolean {
    return Date.now() - this.lastMarketFrameAt < BinanceWsStreamManager.MARKET_STALE_MS;
  }

  public isAggTradeDataLive(): boolean {
    return Date.now() - this.lastAggFrameAt < BinanceWsStreamManager.AGG_STALE_MS;
  }

  public ingestRestTickerBatch(items: Ticker24hStreamItem[]) {
    for (const item of items) {
      if (item.lastPrice > 0) this.lastPrices.set(item.symbol, item.lastPrice);
    }
    if (this.onTickerBatchCb && items.length > 0) this.onTickerBatchCb(items);
  }

  public ingestRestPrices(prices: Map<string, number>) {
    for (const [sym, px] of prices) {
      if (px > 0) {
        this.lastPrices.set(sym, px);
        this.markPrices.set(sym, px);
      }
    }
    if (this.onMarkPriceTickCb && prices.size > 0) this.onMarkPriceTickCb(this.markPrices);
  }

  private startStaleWatchdog() {
    if (this.staleWatchdogTimer) return;
    this.staleWatchdogTimer = setInterval(() => {
      if (!this.running) return;
      const now = Date.now();

      if (this.marketWs?.readyState === WebSocket.OPEN) {
        if (now - this.lastMarketFrameAt > BinanceWsStreamManager.MARKET_STALE_MS) {
          this.marketStaleStrikes++;
          this.rateGovernor.wsConnected = false;
          this.updateStreamCount();
          if (this.marketStaleStrikes <= 3 || this.marketStaleStrikes % 20 === 0) {
            logger.warn(
              'NETWORK',
              `Binance Market WS is open but has delivered no data for ${Math.round(
                (now - this.lastMarketFrameAt) / 1000
              )}s — dropping it to rotate onto another fstream edge (strike ${this.marketStaleStrikes}).`
            );
          }
          this.terminateSocket(this.marketWs);
        }
      }

      if (this.aggTradeWs?.readyState === WebSocket.OPEN) {
        if (now - this.lastAggFrameAt > BinanceWsStreamManager.AGG_STALE_MS) {
          this.aggStaleStrikes++;
          if (this.aggStaleStrikes <= 3 || this.aggStaleStrikes % 20 === 0) {
            logger.warn(
              'CANDLE_15S',
              `aggTrade WS is open but silent for ${Math.round(
                (now - this.lastAggFrameAt) / 1000
              )}s — dropping it to rotate onto another fstream edge (strike ${this.aggStaleStrikes}).`
            );
          }
          this.terminateSocket(this.aggTradeWs);
        }
      }

      if (this.depthWs?.readyState === WebSocket.OPEN) {
        if (now - this.lastDepthFrameAt > BinanceWsStreamManager.DEPTH_STALE_MS) {
          this.depthStaleStrikes++;
          if (this.depthStaleStrikes <= 3 || this.depthStaleStrikes % 20 === 0) {
            logger.warn(
              'ORDER_FLOW',
              `depth WS is open but silent for ${Math.round(
                (now - this.lastDepthFrameAt) / 1000
              )}s — dropping it to rotate onto another fstream edge (strike ${this.depthStaleStrikes}).`
            );
          }
          this.terminateSocket(this.depthWs);
        }
      }
    }, 5000);
  }

  private terminateSocket(ws: WebSocket | null) {
    if (!ws) return;
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }

  public async startUserDataStream() {
    if (!this.restClient.hasCredentials()) return;
    this.stopUserDataStream();
    await this.connectUserWs();
  }

  public stopUserDataStream() {
    if (this.listenKeyKeepaliveTimer) {
      clearInterval(this.listenKeyKeepaliveTimer);
      this.listenKeyKeepaliveTimer = null;
    }
    if (this.userReconnectTimer) {
      clearTimeout(this.userReconnectTimer);
      this.userReconnectTimer = null;
    }
    if (this.userWs) {
      try {
        this.userWs.removeAllListeners();
        this.userWs.close();
      } catch {
        // ignore
      }
      this.userWs = null;
    }
    this.rateGovernor.userDataStreamConnected = false;
  }

  public stopAll() {
    this.running = false;
    this.stopUserDataStream();

    if (this.staleWatchdogTimer) {
      clearInterval(this.staleWatchdogTimer);
      this.staleWatchdogTimer = null;
    }
    if (this.marketReconnectTimer) {
      clearTimeout(this.marketReconnectTimer);
      this.marketReconnectTimer = null;
    }
    if (this.aggReconnectTimer) {
      clearTimeout(this.aggReconnectTimer);
      this.aggReconnectTimer = null;
    }
    if (this.depthReconnectTimer) {
      clearTimeout(this.depthReconnectTimer);
      this.depthReconnectTimer = null;
    }
    if (this.marketWs) {
      try {
        this.marketWs.removeAllListeners();
        this.marketWs.close();
      } catch {
        // ignore
      }
      this.marketWs = null;
    }
    if (this.aggTradeWs) {
      try {
        this.aggTradeWs.removeAllListeners();
        this.aggTradeWs.close();
      } catch {
        // ignore
      }
      this.aggTradeWs = null;
    }
    if (this.depthWs) {
      try {
        this.depthWs.removeAllListeners();
        this.depthWs.close();
      } catch {
        // ignore
      }
      this.depthWs = null;
    }
    this.subscribedAggSymbols.clear();
    this.subscribedDepthSymbols.clear();
    this.rateGovernor.wsConnected = false;
    this.rateGovernor.wsStreamsCount = 0;
  }

  /** One watched set drives both the tape socket and the book socket. */
  public updateWatchedAggTradeSymbols(symbols: string[]) {
    const nextSet = new Set(symbols.map((s) => s.toUpperCase()));
    this.desiredAggSymbols = nextSet;
    this.syncAggSubscriptions();
    this.syncDepthSubscriptions();
  }

  private wsOptions(): WebSocket.ClientOptions {
    // ws spreads these straight into tls.connect, which honours `lookup` even
    // though ws does not declare it on ClientOptions.
    const opts: WebSocket.ClientOptions & { lookup: LookupFunction } = {
      handshakeTimeout: 8000,
      family: 4,
      lookup: this.rotatingLookup,
      ...(this.boundLocalAddress ? { localAddress: this.boundLocalAddress } : {}),
    };
    return opts;
  }

  // fstream.binance.com resolves to ~8 edge IPs and some networks blackhole a
  // subset of them: TCP connects but the upgrade handshake never completes.
  // The resolver returns them in a stable order, so a plain reconnect would retry
  // the same dead edge forever. Advancing the offset per attempt makes each retry
  // land on a different one.
  private lookupAttempt = 0;

  private rotatingLookup: LookupFunction = (hostname, options, callback) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        dns.lookup(hostname, options as dns.LookupOneOptions, callback);
        return;
      }
      const start = this.lookupAttempt++ % addresses.length;
      const rotated = [...addresses.slice(start), ...addresses.slice(0, start)];
      if (options && (options as dns.LookupOptions).all) {
        callback(
          null,
          rotated.map((address) => ({ address, family: 4 })) as never,
          4
        );
        return;
      }
      callback(null, rotated[0] as never, 4);
    });
  };

  private connectMarketWs() {
    if (!this.running) return;
    const url = 'wss://fstream.binance.com/stream?streams=!ticker@arr/!markPrice@arr@1s';

    try {
      const ws = new WebSocket(url, this.wsOptions());
      this.marketWs = ws;

      ws.on('open', () => {
        // Reset the staleness clock: the watchdog must measure silence since the
        // handshake, not since the last frame of a previous dead socket.
        this.lastMarketFrameAt = Date.now();
        this.updateStreamCount();
        logger.info(
          'BINANCE_API',
          'Binance Futures Market Multiplex WS handshake complete — awaiting first data frame.'
        );
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          const streamName: string = msg.stream || '';
          const payload = msg.data;

          if (streamName === '!ticker@arr' && Array.isArray(payload)) {
            this.markMarketFrame();
            const parsed: Ticker24hStreamItem[] = [];
            for (const item of payload) {
              if (!item?.s) continue;
              const lastPrice = parseFloat(item.c || '0');
              if (lastPrice > 0) this.lastPrices.set(item.s, lastPrice);
              parsed.push({
                symbol: item.s,
                priceChangePercent: parseFloat(item.P || '0'),
                lastPrice,
                highPrice: parseFloat(item.h || '0'),
                lowPrice: parseFloat(item.l || '0'),
                quoteVolume: parseFloat(item.q || '0'),
              });
            }
            if (this.onTickerBatchCb && parsed.length > 0) {
              this.onTickerBatchCb(parsed);
            }
          } else if (streamName === '!markPrice@arr@1s' && Array.isArray(payload)) {
            this.markMarketFrame();
            for (const item of payload) {
              if (item?.s && item?.p) {
                const mp = parseFloat(item.p);
                if (mp > 0) this.markPrices.set(item.s, mp);
              }
            }
            if (this.onMarkPriceTickCb) {
              this.onMarkPriceTickCb(this.markPrices);
            }
          }
        } catch {
          // ignore malformed frame
        }
      });

      ws.on('ping', (data) => {
        try {
          ws.pong(data);
        } catch {
          // ignore
        }
      });

      ws.on('close', () => {
        this.rateGovernor.wsConnected = false;
        this.scheduleMarketReconnect();
      });

      ws.on('error', (err) => {
        this.rateGovernor.wsConnected = false;
        logger.warn('NETWORK', `Binance Market WS unreachable/error: ${err.message}`);
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    } catch (err) {
      logger.warn('NETWORK', `Market WS init error: ${(err as Error).message}`);
      this.scheduleMarketReconnect();
    }
  }

  private markMarketFrame() {
    this.lastMarketFrameAt = Date.now();
    if (!this.rateGovernor.wsConnected) {
      this.rateGovernor.wsConnected = true;
      this.marketStaleStrikes = 0;
      this.updateStreamCount();
      logger.success(
        'BINANCE_API',
        'Binance Futures Market WS is delivering live data (!ticker@arr + !markPrice@arr@1s).'
      );
    }
  }

  private scheduleMarketReconnect() {
    if (!this.running || this.marketReconnectTimer) return;
    this.marketReconnectTimer = setTimeout(() => {
      this.marketReconnectTimer = null;
      this.connectMarketWs();
    }, 6000);
  }

  private connectAggTradeWs() {
    if (!this.running) return;
    const url = 'wss://fstream.binance.com/ws';

    try {
      const ws = new WebSocket(url, this.wsOptions());
      this.aggTradeWs = ws;
      this.subscribedAggSymbols.clear();

      ws.on('open', () => {
        this.lastAggFrameAt = Date.now();
        logger.info(
          'CANDLE_15S',
          'aggTrade WS handshake complete — subscribing 15s candle basket.'
        );
        this.syncAggSubscriptions();
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data?.e === 'aggTrade' && data.s) {
            if (this.aggStaleStrikes > 0) {
              this.aggStaleStrikes = 0;
              logger.success('CANDLE_15S', 'aggTrade WS is delivering live tape again.');
            }
            this.lastAggFrameAt = Date.now();
            const price = parseFloat(data.p);
            const qty = parseFloat(data.q);
            const tradeTime = Number(data.T) || Date.now();
            const isBuyerMaker = Boolean(data.m);
            this.lastPrices.set(data.s, price);
            this.candleBuilder.ingestAggTrade(data.s, price, qty, tradeTime, isBuyerMaker, true);
            if (this.onAggTradeCb) {
              this.onAggTradeCb({ symbol: data.s, price, qty, tradeTimeMs: tradeTime, isBuyerMaker });
            }
          }
        } catch {
          // ignore
        }
      });

      ws.on('ping', (data) => {
        try {
          ws.pong(data);
        } catch {
          // ignore
        }
      });

      ws.on('close', () => {
        this.subscribedAggSymbols.clear();
        this.updateStreamCount();
        this.scheduleAggReconnect();
      });

      ws.on('error', () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    } catch {
      this.scheduleAggReconnect();
    }
  }

  private scheduleAggReconnect() {
    if (!this.running || this.aggReconnectTimer) return;
    this.aggReconnectTimer = setTimeout(() => {
      this.aggReconnectTimer = null;
      this.connectAggTradeWs();
    }, 6000);
  }

  private syncAggSubscriptions() {
    if (!this.aggTradeWs || this.aggTradeWs.readyState !== WebSocket.OPEN) return;

    const toSub: string[] = [];
    const toUnsub: string[] = [];

    for (const sym of this.desiredAggSymbols) {
      if (!this.subscribedAggSymbols.has(sym)) {
        toSub.push(`${sym.toLowerCase()}@aggTrade`);
        this.subscribedAggSymbols.add(sym);
      }
    }

    for (const sym of Array.from(this.subscribedAggSymbols)) {
      if (!this.desiredAggSymbols.has(sym)) {
        toUnsub.push(`${sym.toLowerCase()}@aggTrade`);
        this.subscribedAggSymbols.delete(sym);
      }
    }

    if (toUnsub.length > 0) {
      this.sendWsCommand(this.aggTradeWs, 'UNSUBSCRIBE', toUnsub);
    }
    if (toSub.length > 0) {
      // Binance allows max ~200 streams per connection; we have ~40 scanner + open trades
      this.sendWsCommand(this.aggTradeWs, 'SUBSCRIBE', toSub);
    }
    this.updateStreamCount();
  }

  private connectDepthWs() {
    if (!this.running) return;
    const url = 'wss://fstream.binance.com/ws';

    try {
      const ws = new WebSocket(url, this.wsOptions());
      this.depthWs = ws;
      this.subscribedDepthSymbols.clear();

      ws.on('open', () => {
        this.lastDepthFrameAt = Date.now();
        logger.info(
          'ORDER_FLOW',
          'depth20@500ms WS handshake complete — subscribing top-20 book basket.'
        );
        this.syncDepthSubscriptions();
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data?.e === 'depthUpdate' && data.s && Array.isArray(data.b) && Array.isArray(data.a)) {
            if (this.depthStaleStrikes > 0) {
              this.depthStaleStrikes = 0;
              logger.success('ORDER_FLOW', 'depth WS is delivering live book again.');
            }
            const eventTimeMs = Number(data.T) || Number(data.E) || Date.now();
            this.lastDepthFrameAt = Date.now();
            if (this.onDepthBookCb) {
              this.onDepthBookCb({
                symbol: data.s,
                bids: this.parseLevels(data.b),
                asks: this.parseLevels(data.a),
                eventTimeMs,
              });
            }
          }
        } catch {
          // ignore
        }
      });

      ws.on('ping', (data) => {
        try {
          ws.pong(data);
        } catch {
          // ignore
        }
      });

      ws.on('close', () => {
        this.subscribedDepthSymbols.clear();
        this.updateStreamCount();
        this.scheduleDepthReconnect();
      });

      ws.on('error', (err) => {
        logger.warn('ORDER_FLOW', `depth WS error: ${err.message}`);
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    } catch {
      this.scheduleDepthReconnect();
    }
  }

  private parseLevels(rows: unknown[]): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const price = parseFloat(String(row[0]));
      const qty = parseFloat(String(row[1]));
      if (price > 0 && qty >= 0) out.push([price, qty]);
    }
    return out;
  }

  private scheduleDepthReconnect() {
    if (!this.running || this.depthReconnectTimer) return;
    this.depthReconnectTimer = setTimeout(() => {
      this.depthReconnectTimer = null;
      this.connectDepthWs();
    }, 6000);
  }

  private syncDepthSubscriptions() {
    if (!this.depthWs || this.depthWs.readyState !== WebSocket.OPEN) return;

    const toSub: string[] = [];
    const toUnsub: string[] = [];

    for (const sym of this.desiredAggSymbols) {
      if (!this.subscribedDepthSymbols.has(sym)) {
        toSub.push(`${sym.toLowerCase()}@depth20@500ms`);
        this.subscribedDepthSymbols.add(sym);
      }
    }

    for (const sym of Array.from(this.subscribedDepthSymbols)) {
      if (!this.desiredAggSymbols.has(sym)) {
        toUnsub.push(`${sym.toLowerCase()}@depth20@500ms`);
        this.subscribedDepthSymbols.delete(sym);
      }
    }

    if (toUnsub.length > 0) {
      this.sendWsCommand(this.depthWs, 'UNSUBSCRIBE', toUnsub);
    }
    if (toSub.length > 0) {
      this.sendWsCommand(this.depthWs, 'SUBSCRIBE', toSub);
    }
    this.updateStreamCount();
  }

  private sendWsCommand(ws: WebSocket, method: 'SUBSCRIBE' | 'UNSUBSCRIBE', params: string[]) {
    try {
      ws.send(
        JSON.stringify({
          method,
          params,
          id: this.reqIdCounter++,
        })
      );
    } catch {
      // ignore send errors
    }
  }

  private updateStreamCount() {
    const base = this.rateGovernor.wsConnected ? 2 : 0;
    const user = this.rateGovernor.userDataStreamConnected ? 1 : 0;
    this.rateGovernor.wsStreamsCount =
      base + user + this.subscribedAggSymbols.size + this.subscribedDepthSymbols.size;
  }

  private async connectUserWs() {
    if (!this.restClient.hasCredentials()) return;

    try {
      const listenKey = await this.restClient.createListenKey();
      // Portfolio Margin listen keys are routed under the /pm/ namespace, not the
      // classic Futures /ws/ one.
      const url = `wss://fstream.binance.com/pm/ws/${listenKey}`;
      const ws = new WebSocket(url, this.wsOptions());
      this.userWs = ws;

      ws.on('open', () => {
        this.rateGovernor.userDataStreamConnected = true;
        this.updateStreamCount();
        logger.success(
          'BINANCE_API',
          'Authenticated Binance Futures User Data Stream (listenKey) active.'
        );
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const ev = JSON.parse(raw.toString());
          if (ev?.e === 'ACCOUNT_UPDATE' || ev?.e === 'ORDER_TRADE_UPDATE') {
            if (this.onAccountUpdateCb) {
              this.onAccountUpdateCb();
            }
          } else if (ev?.e === 'listenKeyExpired') {
            logger.warn('BINANCE_API', 'User Data listenKey expired; refreshing stream...');
            this.startUserDataStream().catch(() => {});
          }
        } catch {
          // ignore
        }
      });

      ws.on('ping', (data) => {
        try {
          ws.pong(data);
        } catch {
          // ignore
        }
      });

      ws.on('close', () => {
        this.rateGovernor.userDataStreamConnected = false;
        this.updateStreamCount();
        if (this.running && this.restClient.hasCredentials()) {
          this.userReconnectTimer = setTimeout(() => {
            this.userReconnectTimer = null;
            this.connectUserWs().catch(() => {});
          }, 6000);
        }
      });

      ws.on('error', () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });

      // Keep listenKey alive every 25 minutes
      if (this.listenKeyKeepaliveTimer) clearInterval(this.listenKeyKeepaliveTimer);
      this.listenKeyKeepaliveTimer = setInterval(() => {
        this.restClient.keepAliveListenKey().catch(() => {});
      }, 25 * 60_000);
    } catch (err) {
      logger.warn(
        'BINANCE_API',
        `Could not start User Data Stream yet: ${(err as Error).message}`
      );
    }
  }
}

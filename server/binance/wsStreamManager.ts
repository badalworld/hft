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

export class BinanceWsStreamManager {
  private marketWs: WebSocket | null = null;
  private aggTradeWs: WebSocket | null = null;
  private userWs: WebSocket | null = null;

  private subscribedAggSymbols = new Set<string>();
  private desiredAggSymbols = new Set<string>();
  private markPrices = new Map<string, number>();
  private lastPrices = new Map<string, number>();

  private running = false;
  private marketReconnectTimer: NodeJS.Timeout | null = null;
  private aggReconnectTimer: NodeJS.Timeout | null = null;
  private userReconnectTimer: NodeJS.Timeout | null = null;
  private listenKeyKeepaliveTimer: NodeJS.Timeout | null = null;
  private reqIdCounter = 1;
  private boundLocalAddress: string | null = null;

  private onTickerBatchCb: ((items: Ticker24hStreamItem[]) => void) | null = null;
  private onMarkPriceTickCb: ((markMap: Map<string, number>) => void) | null = null;
  private onAccountUpdateCb: (() => void) | null = null;

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

    if (this.marketReconnectTimer) {
      clearTimeout(this.marketReconnectTimer);
      this.marketReconnectTimer = null;
    }
    if (this.aggReconnectTimer) {
      clearTimeout(this.aggReconnectTimer);
      this.aggReconnectTimer = null;
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
    this.subscribedAggSymbols.clear();
    this.rateGovernor.wsConnected = false;
    this.rateGovernor.wsStreamsCount = 0;
  }

  public updateWatchedAggTradeSymbols(symbols: string[]) {
    const nextSet = new Set(symbols.map((s) => s.toUpperCase()));
    this.desiredAggSymbols = nextSet;
    this.syncAggSubscriptions();
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
        this.rateGovernor.wsConnected = true;
        this.updateStreamCount();
        logger.success(
          'BINANCE_API',
          'Connected to Binance Futures Market Multiplex WS (!ticker@arr + !markPrice@arr@1s).'
        );
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          const streamName: string = msg.stream || '';
          const payload = msg.data;

          if (streamName === '!ticker@arr' && Array.isArray(payload)) {
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
        logger.info('CANDLE_15S', 'Connected to Binance Futures 15s aggTrade real-time builder WS.');
        this.syncAggSubscriptions();
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data?.e === 'aggTrade' && data.s) {
            const price = parseFloat(data.p);
            const qty = parseFloat(data.q);
            const tradeTime = Number(data.T) || Date.now();
            const isBuyerMaker = Boolean(data.m);
            this.lastPrices.set(data.s, price);
            this.candleBuilder.ingestAggTrade(data.s, price, qty, tradeTime, isBuyerMaker, true);
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
    this.rateGovernor.wsStreamsCount = base + user + this.subscribedAggSymbols.size;
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

import https from 'node:https';
import crypto from 'node:crypto';
import { URLSearchParams } from 'node:url';
import type { SymbolPrecisionFilter } from '../types.js';
import type { BinanceRateGovernor, RequestPriority, WeightBucket } from './rateGovernor.js';
import { countStepDecimals } from '../utils/format.js';
import { logger } from '../utils/logger.js';

// Public market data (time, exchangeInfo, tickers, aggTrades) only exists on the
// classic Futures hosts. Everything signed goes to papi, because this account is
// a Portfolio Margin account: its funds live in the unified PM wallet and the key
// carries enablePortfolioMarginTrading rather than enableFutures.
const BINANCE_FAPI_HOSTS = [
  'fapi.binance.com',
  'fapi1.binance.com',
  'fapi2.binance.com',
];

const BINANCE_PAPI_HOSTS = ['papi.binance.com'];

const API_HOSTS: Record<WeightBucket, string[]> = {
  FAPI: BINANCE_FAPI_HOSTS,
  PAPI: BINANCE_PAPI_HOSTS,
};

export interface BinanceApiError extends Error {
  code?: number;
  httpStatus?: number;
}

export interface RawAccountSummary {
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  availableBalance: number;
  totalInitialMargin: number;
  totalPositionInitialMargin: number;
  totalOpenOrderInitialMargin: number;
}

export interface RawPositionRisk {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  marginType: string;
  isolatedMargin: number;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  notional: number;
  initialMargin: number;
  updateTime: number;
}

export interface RawOrderResult {
  orderId: number;
  symbol: string;
  status: string;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQuote: string;
  side: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  type: string;
  updateTime: number;
}

export class BinanceFuturesRestClient {
  private apiKey = '';
  private apiSecret = '';
  private agent: https.Agent;
  private boundLocalAddress: string | null = null;
  private hostIndex: Record<WeightBucket, number> = { FAPI: 0, PAPI: 0 };
  private timeOffsetMs = 0;
  private symbolFilters = new Map<string, SymbolPrecisionFilter>();
  private commissionCache = new Map<string, { taker: number; maker: number; fetchedAt: number }>();
  private lastUniMmr = 0;
  private lastAccountStatus = 'UNKNOWN';

  constructor(private readonly rateGovernor: BinanceRateGovernor) {
    this.agent = this.createAgent(null);
  }

  private createAgent(localAddress: string | null): https.Agent {
    return new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30_000,
      maxSockets: 64,
      maxFreeSockets: 16,
      timeout: 9_000,
      family: 4, // Strictly IPv4 so whitelisted IPv4 is ALWAYS used!
      ...(localAddress ? { localAddress } : {}),
    });
  }

  public setCredentials(apiKey: string, apiSecret: string) {
    this.apiKey = apiKey.trim();
    this.apiSecret = apiSecret.trim();
  }

  public hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  public setBoundLocalAddress(localAddr: string | null) {
    if (this.boundLocalAddress !== localAddr) {
      this.boundLocalAddress = localAddr;
      this.agent.destroy();
      this.agent = this.createAgent(localAddr);
      logger.info(
        'NETWORK',
        localAddr
          ? `Pinned outbound Binance HTTPS sockets to local IPv4 ${localAddr}.`
          : 'Using default OS primary IPv4 route for Binance HTTPS sockets.'
      );
    }
  }

  public getSymbolFilter(symbol: string): SymbolPrecisionFilter | undefined {
    return this.symbolFilters.get(symbol);
  }

  public getAllTradableSymbols(): Set<string> {
    return new Set(this.symbolFilters.keys());
  }

  private signQuery(queryString: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  private async rawRequest<T>(options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    api?: WeightBucket;
    params?: Record<string, string | number | boolean | undefined>;
    signed?: boolean;
    apiKeyHeaderOnly?: boolean;
    priority: RequestPriority;
    weight?: number;
    isRetry?: boolean;
  }): Promise<T> {
    const {
      method,
      path,
      api = 'FAPI',
      params = {},
      signed = false,
      apiKeyHeaderOnly = false,
      priority,
      weight = 1,
      isRetry = false,
    } = options;

    if (signed && !this.hasCredentials()) {
      throw new Error('Binance API Key and Secret Key are not configured yet.');
    }

    const allowed = await this.rateGovernor.acquireSlot(priority, weight, api);
    if (!allowed) {
      const err: BinanceApiError = new Error(
        `Request skipped by Rate Governor to protect API weight budget (${path})`
      );
      err.code = -9999;
      throw err;
    }

    const cleanParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        cleanParams.append(k, String(v));
      }
    }

    if (signed) {
      const ts = Date.now() + this.timeOffsetMs;
      cleanParams.append('recvWindow', '6000');
      cleanParams.append('timestamp', String(ts));
      const sig = this.signQuery(cleanParams.toString());
      cleanParams.append('signature', sig);
    }

    const queryStr = cleanParams.toString();
    const fullPath = queryStr ? `${path}?${queryStr}` : path;
    const hosts = API_HOSTS[api];
    const hostname = hosts[this.hostIndex[api] % hosts.length];

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'HFT-TradingLifestyleQuant/1.0',
    };

    if ((signed || apiKeyHeaderOnly) && this.apiKey) {
      headers['X-MBX-APIKEY'] = this.apiKey;
    }

    const startedAt = performance.now();

    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          hostname,
          port: 443,
          path: fullPath,
          method,
          headers,
          agent: this.agent,
          timeout: 8500,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', async () => {
            const latencyMs = performance.now() - startedAt;
            this.rateGovernor.recordHeaders(res.headers, latencyMs, api);

            const bodyText = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 500;

            if (status === 429 || status === 418) {
              const retryAfter = parseInt(String(res.headers['retry-after'] || '10'), 10);
              this.rateGovernor.triggerRateLimitBackoff(
                Number.isFinite(retryAfter) ? retryAfter : 10,
                status
              );
            }

            let parsed: unknown = null;
            try {
              parsed = bodyText ? JSON.parse(bodyText) : {};
            } catch {
              const parseErr: BinanceApiError = new Error(
                `Non-JSON response from Binance (${status}): ${bodyText.slice(0, 180)}`
              );
              parseErr.httpStatus = status;
              reject(parseErr);
              return;
            }

            if (status >= 200 && status < 300) {
              resolve(parsed as T);
              return;
            }

            const errObj = parsed as { code?: number; msg?: string };
            const binanceCode = errObj?.code;
            const binanceMsg = errObj?.msg || `HTTP ${status}`;

            // Auto-recover from -1021 Timestamp outside recvWindow
            if (binanceCode === -1021 && !isRetry) {
              try {
                await this.syncServerTime();
                const retryRes = await this.rawRequest<T>({
                  ...options,
                  isRetry: true,
                });
                resolve(retryRes);
                return;
              } catch (syncError) {
                reject(syncError);
                return;
              }
            }

            const apiErr: BinanceApiError = new Error(
              `Binance Error [${binanceCode ?? status}]: ${binanceMsg}`
            );
            apiErr.code = binanceCode;
            apiErr.httpStatus = status;
            reject(apiErr);
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        this.hostIndex[api] = (this.hostIndex[api] + 1) % hosts.length;
        const err: BinanceApiError = new Error(`Binance request timeout on ${hostname}${path}`);
        err.code = -1001;
        reject(err);
      });

      req.on('error', (netErr) => {
        this.hostIndex[api] = (this.hostIndex[api] + 1) % hosts.length;
        reject(netErr);
      });

      req.end();
    });
  }

  public async syncServerTime(): Promise<number> {
    const localBefore = Date.now();
    const res = await this.rawRequest<{ serverTime: number }>({
      method: 'GET',
      path: '/fapi/v1/time',
      priority: 'P2_ACCOUNT_SYNC',
      weight: 1,
    });
    const localAfter = Date.now();
    const midpoint = Math.round((localBefore + localAfter) / 2);
    this.timeOffsetMs = res.serverTime - midpoint;
    this.rateGovernor.serverTimeOffsetMs = this.timeOffsetMs;
    return this.timeOffsetMs;
  }

  public async loadExchangeInfo(): Promise<number> {
    interface RawExchangeInfo {
      symbols: Array<{
        symbol: string;
        contractType: string;
        status: string;
        quoteAsset: string;
        marginAsset: string;
        pricePrecision: number;
        quantityPrecision: number;
        filters: Array<Record<string, string>>;
      }>;
    }

    const info = await this.rawRequest<RawExchangeInfo>({
      method: 'GET',
      path: '/fapi/v1/exchangeInfo',
      priority: 'P2_ACCOUNT_SYNC',
      weight: 1,
    });

    let count = 0;
    for (const s of info.symbols || []) {
      if (
        s.contractType !== 'PERPETUAL' ||
        s.status !== 'TRADING' ||
        s.quoteAsset !== 'USDT' ||
        s.marginAsset !== 'USDT'
      ) {
        continue;
      }

      let tickSize = Math.pow(10, -s.pricePrecision);
      let tickDecimals = s.pricePrecision;
      let lotStep = Math.pow(10, -s.quantityPrecision);
      let lotMin = lotStep;
      let lotMax = 1e9;
      let mktStep = 0;
      let mktMin = 0;
      let mktMax = 1e9;
      let minNotional = 5;

      for (const f of s.filters || []) {
        if (f.filterType === 'PRICE_FILTER' && f.tickSize) {
          tickSize = parseFloat(f.tickSize);
          tickDecimals = countStepDecimals(f.tickSize);
        } else if (f.filterType === 'LOT_SIZE') {
          if (f.stepSize) lotStep = parseFloat(f.stepSize);
          if (f.minQty) lotMin = parseFloat(f.minQty);
          if (f.maxQty) lotMax = parseFloat(f.maxQty);
        } else if (f.filterType === 'MARKET_LOT_SIZE') {
          if (f.stepSize) mktStep = parseFloat(f.stepSize);
          if (f.minQty) mktMin = parseFloat(f.minQty);
          if (f.maxQty) mktMax = parseFloat(f.maxQty);
        } else if (f.filterType === 'MIN_NOTIONAL' && f.notional) {
          minNotional = parseFloat(f.notional);
        }
      }

      const effectiveStep = Math.max(lotStep, mktStep || lotStep);
      const stepDecimals = countStepDecimals(effectiveStep);
      const effectiveMinQty = Math.max(lotMin, mktMin || lotMin);
      const effectiveMaxQty = Math.min(lotMax, mktMax || lotMax);

      this.symbolFilters.set(s.symbol, {
        symbol: s.symbol,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
        tickSize,
        tickDecimals,
        stepSize: effectiveStep,
        stepDecimals,
        minQty: effectiveMinQty,
        maxQty: effectiveMaxQty,
        minNotional,
      });
      count++;
    }

    logger.info(
      'BINANCE_API',
      `Loaded precision filters for ${count} active USDT-M Perpetual contracts.`
    );
    return count;
  }

  public async get24hrTickers(): Promise<
    Array<{
      symbol: string;
      priceChangePercent: string;
      lastPrice: string;
      highPrice: string;
      lowPrice: string;
      quoteVolume: string;
    }>
  > {
    return this.rawRequest({
      method: 'GET',
      path: '/fapi/v1/ticker/24hr',
      priority: 'P3_BACKGROUND_SCAN',
      weight: 40,
    });
  }

  public async getRecentAggTrades(
    symbol: string,
    limit = 500
  ): Promise<
    Array<{
      a: number;
      p: string;
      q: string;
      T: number;
      m: boolean;
    }>
  > {
    return this.rawRequest({
      method: 'GET',
      path: '/fapi/v1/aggTrades',
      params: { symbol, limit },
      priority: 'P3_BACKGROUND_SCAN',
      weight: 20,
    });
  }

  public async getDualPositionMode(): Promise<boolean> {
    const res = await this.rawRequest<{ dualSidePosition: boolean }>({
      method: 'GET',
      path: '/papi/v1/um/positionSide/dual',
      api: 'PAPI',
      signed: true,
      priority: 'P2_ACCOUNT_SYNC',
      weight: 30,
    });
    return Boolean(res.dualSidePosition);
  }

  public async getAccountSummary(): Promise<RawAccountSummary> {
    interface RawPmAccount {
      accountEquity: string;
      accountInitialMargin: string;
      accountMaintMargin: string;
      totalAvailableBalance: string;
      uniMMR: string;
      accountStatus: string;
    }

    interface RawPmAssetBalance {
      asset: string;
      totalWalletBalance: string;
      umWalletBalance: string;
      umUnrealizedPNL: string;
      cmWalletBalance: string;
      cmUnrealizedPNL: string;
      negativeBalance: string;
    }

    // Portfolio Margin exposes no single endpoint carrying both unified equity and
    // the per-asset wallet/PNL split, so both are needed. They are 20 weight and
    // ~300 bytes each; /papi/v1/um/account would be 5 weight but a 317 KB payload
    // because it inlines a row for every one of ~936 listed contracts.
    const [pm, usdt] = await Promise.all([
      this.rawRequest<RawPmAccount>({
        method: 'GET',
        path: '/papi/v1/account',
        api: 'PAPI',
        signed: true,
        priority: 'P2_ACCOUNT_SYNC',
        weight: 20,
      }),
      this.rawRequest<RawPmAssetBalance>({
        method: 'GET',
        path: '/papi/v1/balance',
        api: 'PAPI',
        params: { asset: 'USDT' },
        signed: true,
        priority: 'P2_ACCOUNT_SYNC',
        weight: 20,
      }),
    ]);

    const unrealized =
      parseFloat(usdt.umUnrealizedPNL || '0') + parseFloat(usdt.cmUnrealizedPNL || '0');
    const accountInitialMargin = parseFloat(pm.accountInitialMargin || '0');

    this.lastUniMmr = parseFloat(pm.uniMMR || '0');
    this.lastAccountStatus = pm.accountStatus || 'UNKNOWN';

    return {
      totalWalletBalance: parseFloat(usdt.totalWalletBalance || '0'),
      totalUnrealizedProfit: unrealized,
      totalMarginBalance: parseFloat(pm.accountEquity || '0'),
      availableBalance: parseFloat(pm.totalAvailableBalance || '0'),
      totalInitialMargin: accountInitialMargin,
      // PM reports one unified initial-margin figure covering positions and resting
      // orders together; the engine only ever consumes the sum of these two.
      totalPositionInitialMargin: accountInitialMargin,
      totalOpenOrderInitialMargin: 0,
    };
  }

  public getLastUniMmr(): number {
    return this.lastUniMmr;
  }

  public getLastAccountStatus(): string {
    return this.lastAccountStatus;
  }

  public async getPositionRisks(symbol?: string): Promise<RawPositionRisk[]> {
    interface RawPosItem {
      symbol: string;
      positionAmt: string;
      entryPrice: string;
      markPrice: string;
      unRealizedProfit: string;
      liquidationPrice: string;
      leverage: string;
      positionSide: 'BOTH' | 'LONG' | 'SHORT';
      notional: string;
      updateTime: number;
    }

    const rows = await this.rawRequest<RawPosItem[]>({
      method: 'GET',
      path: '/papi/v1/um/positionRisk',
      api: 'PAPI',
      params: symbol ? { symbol } : {},
      signed: true,
      priority: 'P1_EXECUTION_POSITION',
      weight: 5,
    });

    return (rows || []).map((r) => {
      const amt = parseFloat(r.positionAmt || '0');
      const entry = parseFloat(r.entryPrice || '0');
      const mark = parseFloat(r.markPrice || '0');
      const lev = Math.max(1, parseInt(r.leverage || '10', 10));
      const absNotional = Math.abs(parseFloat(r.notional || String(amt * mark)));
      const initMargin = absNotional > 0 ? absNotional / lev : (Math.abs(amt) * entry) / lev;

      return {
        symbol: r.symbol,
        positionAmt: amt,
        entryPrice: entry,
        markPrice: mark,
        unRealizedProfit: parseFloat(r.unRealizedProfit || '0'),
        liquidationPrice: parseFloat(r.liquidationPrice || '0'),
        leverage: lev,
        // Portfolio Margin is always unified cross margin; it has no isolated mode.
        marginType: 'cross',
        isolatedMargin: 0,
        positionSide: r.positionSide || 'BOTH',
        notional: absNotional,
        initialMargin: initMargin,
        updateTime: r.updateTime || Date.now(),
      };
    });
  }

  public async getTakerCommissionRate(symbol: string): Promise<number> {
    const cached = this.commissionCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < 30 * 60_000) {
      return cached.taker;
    }
    if (!this.hasCredentials()) return 0.0005; // Standard Binance USDⓈ-M Taker 0.05%

    try {
      const res = await this.rawRequest<{
        symbol: string;
        makerCommissionRate: string;
        takerCommissionRate: string;
      }>({
        method: 'GET',
        path: '/papi/v1/um/commissionRate',
        api: 'PAPI',
        params: { symbol },
        signed: true,
        priority: 'P2_ACCOUNT_SYNC',
        weight: 20,
      });
      const taker = parseFloat(res.takerCommissionRate || '0.0005');
      const maker = parseFloat(res.makerCommissionRate || '0.0002');
      this.commissionCache.set(symbol, { taker, maker, fetchedAt: Date.now() });
      return taker;
    } catch {
      return 0.0005;
    }
  }

  public async setLeverage(symbol: string, leverage: number): Promise<number> {
    const res = await this.rawRequest<{ leverage: number; maxNotionalValue: string; symbol: string }>(
      {
        method: 'POST',
        path: '/papi/v1/um/leverage',
        api: 'PAPI',
        params: { symbol, leverage },
        signed: true,
        priority: 'P1_EXECUTION_POSITION',
        weight: 1,
      }
    );
    return res.leverage;
  }

  public async placeMarketOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'BOTH' | 'LONG' | 'SHORT';
    quantity: string;
    isCloseOrder: boolean;
    hedgeMode: boolean;
  }): Promise<RawOrderResult> {
    const orderParams: Record<string, string | boolean | undefined> = {
      symbol: params.symbol,
      side: params.side,
      positionSide: params.positionSide,
      type: 'MARKET',
      quantity: params.quantity,
      newOrderRespType: 'RESULT',
    };

    // CRITICAL BINANCE FUTURES RULE:
    // In One-Way Mode (positionSide === 'BOTH'), reduceOnly='true' protects closing orders.
    // In Hedge Mode (positionSide === 'LONG' | 'SHORT'), sending reduceOnly throws -1106!
    if (params.isCloseOrder && !params.hedgeMode && params.positionSide === 'BOTH') {
      orderParams.reduceOnly = 'true';
    }

    return this.rawRequest<RawOrderResult>({
      method: 'POST',
      path: '/papi/v1/um/order',
      api: 'PAPI',
      params: orderParams,
      signed: true,
      priority: params.isCloseOrder ? 'P0_CRITICAL_EXIT' : 'P1_EXECUTION_POSITION',
      weight: 1,
    });
  }

  public async createListenKey(): Promise<string> {
    const res = await this.rawRequest<{ listenKey: string }>({
      method: 'POST',
      path: '/papi/v1/listenKey',
      api: 'PAPI',
      apiKeyHeaderOnly: true,
      priority: 'P2_ACCOUNT_SYNC',
      weight: 1,
    });
    return res.listenKey;
  }

  public async keepAliveListenKey(): Promise<void> {
    await this.rawRequest({
      method: 'PUT',
      path: '/papi/v1/listenKey',
      api: 'PAPI',
      apiKeyHeaderOnly: true,
      priority: 'P2_ACCOUNT_SYNC',
      weight: 1,
    });
  }
}

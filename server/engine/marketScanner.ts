import type { AdaptiveStyleParams, ScannerAsset } from '../types.js';
import type { BinanceFuturesRestClient } from '../binance/restClient.js';
import type { BinanceWsStreamManager, Ticker24hStreamItem } from '../binance/wsStreamManager.js';
import type { CandleBuilder15s } from '../binance/candleBuilder15s.js';
import { evaluate15sPullbackStrategy } from './strategy15s.js';
import { logger } from '../utils/logger.js';

interface RankResult {
  picks: Ticker24hStreamItem[];
  substitutedFor: Map<string, string>;
  cooledOut: string[];
}

export class MarketScanner40 {
  private positiveAssets: ScannerAsset[] = [];
  private negativeAssets: ScannerAsset[] = [];
  private latestTickers = new Map<string, Ticker24hStreamItem>();
  private warmedSymbols = new Set<string>();
  private warmupInFlight = false;
  private lastRankRefreshAt = 0;
  private coolingSignature = '';
  private lastSwapNotes = new Set<string>();

  constructor(
    private readonly restClient: BinanceFuturesRestClient,
    private readonly wsManager: BinanceWsStreamManager,
    private readonly candleBuilder: CandleBuilder15s
  ) {}

  public ingestTickerBatch(items: Ticker24hStreamItem[]) {
    for (const item of items) {
      this.latestTickers.set(item.symbol, item);
    }
  }

  public async fetchInitialSnapshotIfNeeded() {
    if (this.latestTickers.size > 0) return;
    const rows = await this.restClient.get24hrTickers();
    const mapped: Ticker24hStreamItem[] = rows.map((r) => ({
      symbol: r.symbol,
      priceChangePercent: parseFloat(r.priceChangePercent || '0'),
      lastPrice: parseFloat(r.lastPrice || '0'),
      highPrice: parseFloat(r.highPrice || '0'),
      lowPrice: parseFloat(r.lowPrice || '0'),
      quoteVolume: parseFloat(r.quoteVolume || '0'),
    }));
    this.ingestTickerBatch(mapped);
  }

  public refreshTop40Universe(params: {
    style: AdaptiveStyleParams;
    openPositionSymbols: Set<string>;
    cooldownUntilMap: Map<string, number>;
    scannerPausedForMargin: boolean;
  }): { positive: ScannerAsset[]; negative: ScannerAsset[]; watchedSymbols: string[] } {
    const now = Date.now();
    const tradableSet = this.restClient.getAllTradableSymbols();

    // Re-rank top 20 positive & top 20 negative every 4 seconds (keeps symbol basket
    // stable across 15s bars while staying fresh) — and immediately whenever the
    // cooldown set changes, so a cooled symbol leaves the list on the next tick
    // instead of sitting there untradeable for up to 4 seconds.
    const coolingNow = Array.from(params.cooldownUntilMap.entries())
      .filter(([, until]) => until > now)
      .map(([sym]) => sym)
      .sort()
      .join(',');

    const shouldReRank =
      now - this.lastRankRefreshAt >= 4000 ||
      coolingNow !== this.coolingSignature ||
      (this.positiveAssets.length === 0 && this.latestTickers.size > 0);

    if (shouldReRank && !params.scannerPausedForMargin) {
      this.lastRankRefreshAt = now;
      this.coolingSignature = coolingNow;
      const validTickers: Ticker24hStreamItem[] = [];

      for (const t of this.latestTickers.values()) {
        if (tradableSet.size > 0) {
          if (!tradableSet.has(t.symbol)) continue;
        } else {
          if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) continue;
        }
        if (t.lastPrice <= 0 || t.quoteVolume < 250_000) continue;
        validTickers.push(t);
      }

      const sortedPos = validTickers
        .filter((t) => t.priceChangePercent > 0)
        .sort((a, b) => b.priceChangePercent - a.priceChangePercent);

      const sortedNeg = validTickers
        .filter((t) => t.priceChangePercent < 0)
        .sort((a, b) => a.priceChangePercent - b.priceChangePercent);

      const posRanked = this.rankBucket(sortedPos, params, now, 20);
      const negRanked = this.rankBucket(sortedNeg, params, now, 20);
      this.logCooldownSwaps(posRanked, negRanked, params, now);

      this.positiveAssets = posRanked.picks.map((t, idx) =>
        this.buildScannerAsset(
          t,
          'POSITIVE_TOP20',
          'LONG',
          idx + 1,
          params,
          now,
          posRanked.substitutedFor.get(t.symbol) || null
        )
      );
      this.negativeAssets = negRanked.picks.map((t, idx) =>
        this.buildScannerAsset(
          t,
          'NEGATIVE_TOP20',
          'SHORT',
          idx + 1,
          params,
          now,
          negRanked.substitutedFor.get(t.symbol) || null
        )
      );
    } else if (!params.scannerPausedForMargin) {
      // Update live prices & 15s technicals on current 40 assets
      this.positiveAssets = this.positiveAssets.map((a, idx) => {
        const latest = this.latestTickers.get(a.symbol);
        const ticker: Ticker24hStreamItem = latest || {
          symbol: a.symbol,
          priceChangePercent: a.priceChangePercent24h,
          lastPrice: a.lastPrice,
          highPrice: a.high24h,
          lowPrice: a.low24h,
          quoteVolume: a.quoteVolume24h,
        };
        return this.buildScannerAsset(
          ticker,
          'POSITIVE_TOP20',
          'LONG',
          idx + 1,
          params,
          now,
          a.substitutedFor
        );
      });

      this.negativeAssets = this.negativeAssets.map((a, idx) => {
        const latest = this.latestTickers.get(a.symbol);
        const ticker: Ticker24hStreamItem = latest || {
          symbol: a.symbol,
          priceChangePercent: a.priceChangePercent24h,
          lastPrice: a.lastPrice,
          highPrice: a.high24h,
          lowPrice: a.low24h,
          quoteVolume: a.quoteVolume24h,
        };
        return this.buildScannerAsset(
          ticker,
          'NEGATIVE_TOP20',
          'SHORT',
          idx + 1,
          params,
          now,
          a.substitutedFor
        );
      });
    }

    const watchedSet = new Set<string>(params.openPositionSymbols);
    if (!params.scannerPausedForMargin) {
      for (const a of this.positiveAssets) watchedSet.add(a.symbol);
      for (const a of this.negativeAssets) watchedSet.add(a.symbol);
    }

    const watchedSymbols = Array.from(watchedSet);

    // Kick off gentle background aggTrade warmup for symbols lacking 4 closed 15s bars
    if (!params.scannerPausedForMargin) {
      this.backgroundWarmup15s(watchedSymbols).catch(() => {});
    }

    return {
      positive: this.positiveAssets,
      negative: this.negativeAssets,
      watchedSymbols,
    };
  }

  /**
   * Take the top `size` movers of one bucket, skipping symbols still in cooldown,
   * while keeping every symbol that currently holds a position on screen. Because
   * cooled symbols are dropped rather than left in place, the next-ranked mover
   * walks into the freed slot — that pairing is what `substitutedFor` records.
   */
  private rankBucket(
    sorted: Ticker24hStreamItem[],
    params: {
      openPositionSymbols: Set<string>;
      cooldownUntilMap: Map<string, number>;
    },
    now: number,
    size: number
  ): RankResult {
    const isCooling = (sym: string) => (params.cooldownUntilMap.get(sym) || 0) > now;
    const cut = sorted.slice(0, size);
    const picks: Ticker24hStreamItem[] = [];

    for (const t of sorted) {
      if (picks.length >= size) break;
      if (isCooling(t.symbol) && !params.openPositionSymbols.has(t.symbol)) continue;
      picks.push(t);
    }

    const cooledOut = cut.filter(
      (t) => isCooling(t.symbol) && !params.openPositionSymbols.has(t.symbol)
    );
    const dropped = cut.filter((t) => !picks.some((p) => p.symbol === t.symbol));
    const entrants = picks.filter((t) => !cut.some((p) => p.symbol === t.symbol));

    const substitutedFor = new Map<string, string>();
    entrants.forEach((entry, i) => {
      const freed = dropped[i];
      if (freed) substitutedFor.set(entry.symbol, freed.symbol);
    });

    return { picks, substitutedFor, cooledOut: cooledOut.map((t) => t.symbol) };
  }

  private logCooldownSwaps(
    pos: RankResult,
    neg: RankResult,
    params: { cooldownUntilMap: Map<string, number> },
    now: number
  ) {
    const notes = new Set<string>();
    const all = [pos, neg];

    for (const bucket of all) {
      for (const sym of bucket.cooledOut) {
        const until = params.cooldownUntilMap.get(sym) || 0;
        notes.add(
          `PULL:${sym}:${Math.max(0, Math.round((until - now) / 1000))}`
        );
      }
      for (const [entrant, freed] of bucket.substitutedFor) {
        notes.add(`ADD:${entrant}:${freed}`);
      }
    }

    for (const note of notes) {
      if (this.lastSwapNotes.has(note)) continue;
      const [kind, sym, rest] = note.split(':');
      if (kind === 'PULL') {
        logger.info(
          'SCANNER',
          `${sym} removed from scan list — cooling for ${rest}s. Slot opened for the next-ranked mover.`
        );
      } else {
        logger.success('SCANNER', `${sym} substituted into the scan list, replacing ${rest}.`);
      }
    }

    this.lastSwapNotes = notes;
  }

  private buildScannerAsset(
    t: Ticker24hStreamItem,
    bucket: 'POSITIVE_TOP20' | 'NEGATIVE_TOP20',
    side: 'LONG' | 'SHORT',
    rank: number,
    params: {
      style: AdaptiveStyleParams;
      openPositionSymbols: Set<string>;
      cooldownUntilMap: Map<string, number>;
    },
    now: number,
    substitutedFor: string | null
  ): ScannerAsset {
    const snap = this.candleBuilder.getTechnicalSnapshot(t.symbol, side);
    const liveLast = this.wsManager.getLastPrice(t.symbol) || t.lastPrice;
    const liveMark = this.wsManager.getMarkPrice(t.symbol) || liveLast;
    const inPos = params.openPositionSymbols.has(t.symbol);
    const cdUntil = params.cooldownUntilMap.get(t.symbol) || 0;
    const inCooldown = cdUntil > now;

    const eval15s = evaluate15sPullbackStrategy({
      side,
      absChange24hPct: Math.abs(t.priceChangePercent),
      snap,
      style: params.style,
      inPosition: inPos,
      inCooldown,
    });

    const filter = this.restClient.getSymbolFilter(t.symbol);
    const minLev = filter
      ? Math.min(15, Math.max(10, Math.ceil((filter.minNotional * 1.02) / params.style.baseMarginUsd)))
      : 10;

    return {
      symbol: t.symbol,
      directionBucket: bucket,
      intendedSide: side,
      rank,
      priceChangePercent24h: t.priceChangePercent,
      lastPrice: liveLast,
      markPrice: liveMark,
      high24h: t.highPrice,
      low24h: t.lowPrice,
      quoteVolume24h: t.quoteVolume,
      stage: eval15s.stage,
      rsi15s: snap.rsi7,
      ema9: snap.ema9,
      ema21: snap.ema21,
      pullbackDepthPct: eval15s.pullbackDepthPct,
      orderflowDeltaRatio: snap.orderflowDeltaRatio,
      aiConfidence: eval15s.triggered ? 0.72 : eval15s.stage === 'PULLBACK_DETECTED' ? 0.58 : 0.42,
      recommendedLeverage: minLev,
      candleCount15s: snap.candleCount,
      lastSignalReason: eval15s.reason,
      cooldownUntil: cdUntil,
      substitutedFor,
      updatedAt: now,
    };
  }

  private async backgroundWarmup15s(symbols: string[]) {
    if (this.warmupInFlight) return;
    const candidates = symbols.filter((s) => !this.warmedSymbols.has(s)).slice(0, 3);
    if (candidates.length === 0) return;

    this.warmupInFlight = true;
    try {
      for (const sym of candidates) {
        this.warmedSymbols.add(sym);
        try {
          const trades = await this.restClient.getRecentAggTrades(sym, 400);
          this.candleBuilder.warmupFromHistoricalAggTrades(sym, trades);
        } catch {
          // If rate-governed or offline, WebSocket live aggTrade fills bars organically within 60s
        }
      }
    } finally {
      this.warmupInFlight = false;
    }
  }

  public getCurrentLists() {
    return {
      positive: this.positiveAssets,
      negative: this.negativeAssets,
    };
  }
}

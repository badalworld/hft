import crypto from 'node:crypto';
import type {
  AdaptiveStyleParams,
  ClosedTradeRecord,
  DashboardSnapshot,
  EntryFeatureVector,
  LocalDecisionConfig,
  OpenTradePosition,
  ScannerOperatingState,
  ServerIpReport,
} from '../types.js';
import { BinanceRateGovernor } from '../binance/rateGovernor.js';
import { BinanceFuturesRestClient } from '../binance/restClient.js';
import { CandleBuilder15s } from '../binance/candleBuilder15s.js';
import { BinanceWsStreamManager } from '../binance/wsStreamManager.js';
import { AiAgentClubOrchestrator } from '../ai/agentClubGraph.js';
import { StateStore } from './stateStore.js';
import { MarketScanner40 } from './marketScanner.js';
import { PositionMonitor1s } from './positionMonitor1s.js';
import { evaluate15sPullbackStrategy } from './strategy15s.js';
import { f6, formatOrderQty, maskApiKey } from '../utils/format.js';
import { scanServerIpv4Addresses } from '../utils/ipDiscovery.js';
import { logger } from '../utils/logger.js';

export class HftBotEngine {
  public readonly stateStore = new StateStore();
  public readonly rateGovernor = new BinanceRateGovernor();
  public readonly restClient = new BinanceFuturesRestClient(this.rateGovernor);
  public readonly candleBuilder = new CandleBuilder15s();
  public readonly wsManager = new BinanceWsStreamManager(
    this.rateGovernor,
    this.restClient,
    this.candleBuilder
  );
  public readonly scanner: MarketScanner40;
  public readonly positionMonitor: PositionMonitor1s;
  public readonly aiClub: AiAgentClubOrchestrator;

  private engineRunning = false;
  private apiConnected = false;
  private hedgeMode = false;
  private exchangeInfoLoaded = false;

  private walletBalance = 0;
  private currentEquity = 0;
  private availableBalance = 0;
  private unrealizedPnlTotal = 0;
  private usedMarginTotal = 0;

  private ipReport: ServerIpReport = {
    whitelistPublicIpv4s: [],
    interfaces: [],
    boundLocalAddress: null,
    lastScannedAt: 0,
    environmentHint: 'LOCALHOST_NAT',
    notes: ['Scanning network interfaces...'],
  };

  private commissionMap = new Map<string, number>();
  private cooldownUntilMap = new Map<string, number>();
  private openingInFlight = new Set<string>();
  private closingInFlight = new Set<string>();
  private lastMarginPausedState = false;
  private tickCounter = 0;
  private mainLoopTimer: NodeJS.Timeout | null = null;
  private snapshotSubscribers = new Set<(snap: DashboardSnapshot) => void>();

  constructor() {
    this.scanner = new MarketScanner40(this.restClient, this.wsManager, this.candleBuilder);
    this.positionMonitor = new PositionMonitor1s(this.stateStore);
    this.aiClub = new AiAgentClubOrchestrator({
      styleParams: this.stateStore.getStyleParams(),
      system1Weights: this.stateStore.getSystem1Weights(),
      localConfig: this.stateStore.getLocalDecisionConfig(),
    });

    this.engineRunning = this.stateStore.getEngineRunning();

    const boundIp = this.stateStore.getBoundLocalAddress();
    if (boundIp) {
      this.restClient.setBoundLocalAddress(boundIp);
      this.wsManager.setBoundLocalAddress(boundIp);
    }

    const creds = this.stateStore.getCredentials();
    if (creds.apiKey && creds.apiSecret) {
      this.restClient.setCredentials(creds.apiKey, creds.apiSecret);
    }

    // Wire WS streams
    this.wsManager.onTickerBatch((items) => {
      this.scanner.ingestTickerBatch(items);
    });

    this.wsManager.onMarkPriceTick((markMap) => {
      const exits = this.positionMonitor.tickRealtimePrices(
        (sym) => markMap.get(sym),
        this.aiClub.getStyleParams()
      );
      for (const ex of exits) {
        this.closePositionNow(ex.position, ex.reason).catch(() => {});
      }
    });

    this.wsManager.onAccountUpdate(() => {
      this.syncAccountAndPositions().catch(() => {});
    });

    // Wire 15-second candle close trigger
    this.candleBuilder.onCandleClosed((symbol) => {
      this.handle15sCandleClosed(symbol).catch((err) => {
        logger.error('CANDLE_15S', `Error evaluating 15s close on ${symbol}: ${(err as Error).message}`);
      });
    });
  }

  public onSnapshot(cb: (snap: DashboardSnapshot) => void): () => void {
    this.snapshotSubscribers.add(cb);
    return () => this.snapshotSubscribers.delete(cb);
  }

  public async initialize() {
    logger.info(
      'ENGINE',
      'Booting HFT Engine (Developed by Trading Lifestyle Quant) — Production Binance USDⓈ-M Futures Mode.'
    );

    // 1. Discover all server IPv4s for Binance API whitelist
    this.refreshIpDiscovery().catch(() => {});

    // 2. Start 15s candle clock & WS market streams
    this.candleBuilder.start();
    this.wsManager.startMarketStreams();

    // 3. Attempt initial exchange metadata + account sync
    await this.bootstrapBinanceConnectivity();

    // 4. Start exact 1-second real-time loop
    if (!this.mainLoopTimer) {
      this.mainLoopTimer = setInterval(() => {
        this.runOneSecondHeartbeat().catch((err) => {
          logger.error('ENGINE', `1s Heartbeat exception: ${(err as Error).message}`);
        });
      }, 1000);
    }
  }

  public async refreshIpDiscovery(): Promise<ServerIpReport> {
    const bound = this.stateStore.getBoundLocalAddress();
    this.ipReport = await scanServerIpv4Addresses(bound);
    this.broadcastSnapshot();
    return this.ipReport;
  }

  public async setBoundLocalAddress(localAddr: string | null): Promise<ServerIpReport> {
    this.stateStore.setBoundLocalAddress(localAddr);
    this.restClient.setBoundLocalAddress(localAddr);
    this.wsManager.setBoundLocalAddress(localAddr);
    return this.refreshIpDiscovery();
  }

  private async bootstrapBinanceConnectivity() {
    try {
      const offset = await this.restClient.syncServerTime();
      logger.info('BINANCE_API', `Synchronized with Binance FAPI clock (offset ${offset}ms).`);

      if (!this.exchangeInfoLoaded) {
        await this.restClient.loadExchangeInfo();
        this.exchangeInfoLoaded = true;
      }

      await this.scanner.fetchInitialSnapshotIfNeeded();
    } catch (err) {
      logger.warn(
        'NETWORK',
        `Binance public FAPI awaiting connectivity: ${(err as Error).message}`
      );
    }

    if (this.restClient.hasCredentials()) {
      await this.connectAuthenticatedAccount();
    } else {
      logger.info(
        'ENGINE',
        'Awaiting Binance Futures API Key & Secret Key in Settings Vault to unlock live trading.'
      );
    }
  }

  public async saveAndConnectApiKeys(apiKey: string, apiSecret: string): Promise<{
    connected: boolean;
    message: string;
  }> {
    this.stateStore.setCredentials(apiKey, apiSecret);
    this.restClient.setCredentials(apiKey, apiSecret);

    if (!apiKey.trim() || !apiSecret.trim()) {
      this.apiConnected = false;
      this.engineRunning = false;
      this.stateStore.setEngineRunning(false);
      this.wsManager.stopUserDataStream();
      logger.warn('BINANCE_API', 'Binance API credentials cleared from Vault.');
      this.broadcastSnapshot();
      return { connected: false, message: 'Credentials cleared.' };
    }

    logger.info('BINANCE_API', 'Validating Binance USDⓈ-M Futures API credentials...');
    const ok = await this.connectAuthenticatedAccount();
    this.broadcastSnapshot();
    return ok;
  }

  private async connectAuthenticatedAccount(): Promise<{ connected: boolean; message: string }> {
    try {
      await this.restClient.syncServerTime();
      if (!this.exchangeInfoLoaded) {
        await this.restClient.loadExchangeInfo();
        this.exchangeInfoLoaded = true;
      }

      this.hedgeMode = await this.restClient.getDualPositionMode();
      await this.syncAccountAndPositions();
      await this.wsManager.startUserDataStream();

      this.apiConnected = true;
      logger.success(
        'BINANCE_API',
        `Binance USDⓈ-M Futures Connected! Mode: ${
          this.hedgeMode ? 'HEDGE MODE (Dual-Side)' : 'ONE-WAY MODE'
        } | Equity: $${f6(this.currentEquity)} USDT`
      );
      return {
        connected: true,
        message: `Connected to Binance Futures (${
          this.hedgeMode ? 'Hedge Mode' : 'One-Way Mode'
        }). Equity: $${f6(this.currentEquity)} USDT`,
      };
    } catch (err) {
      this.apiConnected = false;
      const msg = (err as Error).message;
      logger.error(
        'BINANCE_API',
        `Binance Futures authentication/network error: ${msg}. Verify API Key, Secret, 'Enable Futures' permission, and IPv4 Whitelist in Settings.`
      );
      return {
        connected: false,
        message: msg,
      };
    }
  }

  public async setEngineRunning(running: boolean): Promise<{ running: boolean; message: string }> {
    if (running && !this.restClient.hasCredentials()) {
      return {
        running: false,
        message: 'Please configure your Binance API Key and Secret Key in Settings first.',
      };
    }

    if (running && !this.apiConnected) {
      const conn = await this.connectAuthenticatedAccount();
      if (!conn.connected) {
        return {
          running: false,
          message: `Cannot arm bot until Binance API connects: ${conn.message}`,
        };
      }
    }

    this.engineRunning = running;
    this.stateStore.setEngineRunning(running);

    if (running) {
      logger.success(
        'ENGINE',
        '🚀 HFT Automated Trading Engine ARMED & LIVE! Scanning 40 assets on 15s candles | $2.000000 margin | 10x→15x ladder | 5.000000% ROI Trailing Stop.'
      );
    } else {
      logger.warn(
        'ENGINE',
        '⏸ HFT New-Entry Engine PAUSED by operator. 1-second monitoring of any existing open positions remains active.'
      );
    }

    this.broadcastSnapshot();
    return {
      running: this.engineRunning,
      message: running ? 'HFT Engine Armed & Live' : 'HFT Engine Paused',
    };
  }

  public resetStartBalance(): { startBalance: number; locked: boolean } {
    if (this.apiConnected && this.walletBalance > 0) {
      this.stateStore.resetStartBalance(this.walletBalance);
      logger.info(
        'ENGINE',
        `Start Balance manually reset and re-locked to current Binance Wallet Balance: $${f6(
          this.walletBalance
        )} USDT.`
      );
    } else {
      this.stateStore.resetStartBalance();
      logger.info(
        'ENGINE',
        'Start Balance lock cleared — will automatically capture and fix balance upon next Binance API connection.'
      );
    }
    this.broadcastSnapshot();
    const info = this.stateStore.getStartBalanceInfo();
    return { startBalance: info.startBalance, locked: info.startBalanceLocked };
  }

  public updateLocalDecisionConfig(cfg: Partial<LocalDecisionConfig>) {
    this.aiClub.setLocalDecisionConfig(cfg);
    this.stateStore.setLocalDecisionConfig(this.aiClub.getLocalDecisionConfig());
    logger.ai(
      'AI_CLUB',
      `Updated System-1 Decision Runtime to ${this.aiClub.getLocalDecisionConfig().provider} (${
        this.aiClub.getLocalDecisionConfig().endpointUrl
      }).`
    );
    this.broadcastSnapshot();
  }

  public updateStyleParams(partial: Partial<AdaptiveStyleParams>) {
    this.aiClub.updateStyleParams(partial);
    this.stateStore.setStyleParams(this.aiClub.getStyleParams());
    logger.ai('AI_CLUB', 'Updated HFT style parameters.', partial as Record<string, unknown>);
    this.broadcastSnapshot();
  }

  private isMarginExhausted95(): boolean {
    if (!this.apiConnected) return false;
    const style = this.aiClub.getStyleParams();
    const maxPool95 = this.currentEquity * (style.capitalUtilizationCapPct / 100);
    const remaining95 = Math.min(this.availableBalance, maxPool95 - this.usedMarginTotal);
    return remaining95 < style.baseMarginUsd + 0.03;
  }

  private async runOneSecondHeartbeat() {
    this.tickCounter++;

    // Retry exchangeInfo periodically if offline at startup
    if (!this.exchangeInfoLoaded && this.tickCounter % 15 === 0) {
      this.bootstrapBinanceConnectivity().catch(() => {});
    }

    // 1. Every 1 second: check open positions & account state when credentials exist
    if (this.restClient.hasCredentials()) {
      const openCount = this.positionMonitor.getOpenPositionsList().length;
      // Poll /fapi/v2/positionRisk EVERY 1 SECOND when any trade is open, or every 3 seconds when flat!
      if (openCount > 0 || this.tickCounter % 3 === 0) {
        await this.syncPositions1s();
      }
      // Sync full wallet / equity every 3 seconds
      if (this.tickCounter % 3 === 0) {
        await this.syncAccountSummaryOnly();
      }
    }

    // Tick running time & live WS mark prices every single second
    const tickExits = this.positionMonitor.tickRealtimePrices(
      (sym) => this.wsManager.getMarkPrice(sym) ?? this.wsManager.getLastPrice(sym),
      this.aiClub.getStyleParams()
    );
    for (const ex of tickExits) {
      this.closePositionNow(ex.position, ex.reason).catch(() => {});
    }

    // 2. Check 95% Capital Utilization Cap
    const marginPaused = this.isMarginExhausted95();
    if (marginPaused !== this.lastMarginPausedState) {
      this.lastMarginPausedState = marginPaused;
      if (marginPaused) {
        logger.warn(
          'SCANNER',
          '95.000000% Balance Utilization Reached — Market Scanner PAUSED. Focusing 100% of resources on open positions for maximum profit capture!'
        );
      } else {
        logger.success(
          'SCANNER',
          'Available margin restored below 95.000000% cap — Market Scanner RESUMED across 40 movers!'
        );
      }
    }

    // 3. Refresh Top-40 Scanner (auto-pauses scanning when 95% balance deployed!)
    const openSymbols = this.positionMonitor.getOpenSymbolSet();
    const { watchedSymbols } = this.scanner.refreshTop40Universe({
      style: this.aiClub.getStyleParams(),
      openPositionSymbols: openSymbols,
      cooldownUntilMap: this.cooldownUntilMap,
      scannerPausedForMargin: marginPaused,
    });

    this.wsManager.updateWatchedAggTradeSymbols(watchedSymbols);

    if (this.tickCounter % 60 === 0) {
      this.candleBuilder.pruneSymbolsExcept(new Set(watchedSymbols));
    }

    // 4. Push real-time 1s snapshot to UI
    this.broadcastSnapshot();
  }

  private async syncAccountAndPositions() {
    await Promise.all([this.syncAccountSummaryOnly(), this.syncPositions1s()]);
  }

  private async syncAccountSummaryOnly() {
    try {
      const summary = await this.restClient.getAccountSummary();
      this.apiConnected = true;
      this.walletBalance = summary.totalWalletBalance;
      this.unrealizedPnlTotal = summary.totalUnrealizedProfit;
      this.currentEquity = summary.totalMarginBalance;
      this.availableBalance = summary.availableBalance;
      this.usedMarginTotal =
        summary.totalPositionInitialMargin + summary.totalOpenOrderInitialMargin;

      // Lock Start Balance on 1st connection!
      const newlyLocked = this.stateStore.lockStartBalanceIfUnset(summary.totalWalletBalance);
      if (newlyLocked) {
        logger.success(
          'ENGINE',
          `🔒 Initial Start Balance captured & fixed at $${f6(
            summary.totalWalletBalance
          )} USDT (remains fixed until manual reset).`
        );
      }
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== -9999) {
        // Log real errors (not rate-governor skips)
        if (this.tickCounter % 15 === 1) {
          logger.warn('BINANCE_API', `Account sync warning: ${(err as Error).message}`);
        }
      }
    }
  }

  private async syncPositions1s() {
    try {
      const risks = await this.restClient.getPositionRisks();
      this.apiConnected = true;

      // Ensure commission rates are cached asynchronously for active positions
      for (const r of risks) {
        if (Math.abs(r.positionAmt) > 0 && !this.commissionMap.has(r.symbol)) {
          this.restClient
            .getTakerCommissionRate(r.symbol)
            .then((rate) => this.commissionMap.set(r.symbol, rate))
            .catch(() => {});
        }
      }

      const { exitsToExecute, externallyClosedPositions } =
        this.positionMonitor.syncFromBinanceRisks(
          risks,
          (sym) => this.wsManager.getMarkPrice(sym),
          (sym) => this.commissionMap.get(sym) ?? 0.0005,
          this.aiClub.getStyleParams()
        );

      for (const extClosed of externallyClosedPositions) {
        if (!this.closingInFlight.has(`${extClosed.symbol}:${extClosed.positionSide}`)) {
          this.finalizeClosedTradePostMortem(
            extClosed,
            extClosed.markPrice,
            'EXTERNAL_OR_EXCHANGE_CLOSE'
          ).catch(() => {});
        }
      }

      for (const ex of exitsToExecute) {
        this.closePositionNow(ex.position, ex.reason).catch(() => {});
      }
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== -9999 && this.tickCounter % 15 === 1) {
        logger.warn('MONITOR_1S', `1s Position sync warning: ${(err as Error).message}`);
      }
    }
  }

  private async handle15sCandleClosed(symbol: string) {
    if (!this.engineRunning || !this.apiConnected) return;
    if (this.isMarginExhausted95()) return;
    if (this.openingInFlight.has(symbol)) return;
    if (this.positionMonitor.getOpenSymbolSet().has(symbol)) return;

    const now = Date.now();
    const cd = this.cooldownUntilMap.get(symbol) || 0;
    if (cd > now) return;

    const { positive, negative } = this.scanner.getCurrentLists();
    const posMatch = positive.find((a) => a.symbol === symbol);
    const negMatch = negative.find((a) => a.symbol === symbol);
    const scannerAsset = posMatch || negMatch;
    if (!scannerAsset) return;

    const side = scannerAsset.intendedSide; // POSITIVE -> LONG, NEGATIVE -> SHORT
    const style = this.aiClub.getStyleParams();
    const snap = this.candleBuilder.getTechnicalSnapshot(symbol, side);

    const stratEval = evaluate15sPullbackStrategy({
      side,
      absChange24hPct: Math.abs(scannerAsset.priceChangePercent24h),
      snap,
      style,
      inPosition: false,
      inCooldown: false,
    });

    if (!stratEval.triggered) return;

    const filter = this.restClient.getSymbolFilter(symbol);
    const minNotional = filter?.minNotional ?? 5;

    // Consult LangGraph 5-Agent Self-Learning Club
    const consensus = await this.aiClub.evaluateEntryCandidate({
      symbol,
      side,
      features: stratEval.features,
      minNotional,
    });

    stratEval.features.aiConfidence = consensus.confidence;

    if (!consensus.approved) {
      logger.ai(
        'AI_CLUB',
        `AI Club filtered ${symbol} ${side} 15s signal: ${consensus.reason}`
      );
      return;
    }

    // Re-check 95% capital ceiling right before order placement
    if (this.isMarginExhausted95()) return;

    await this.executeEntryWithLeverageLadder(symbol, side, stratEval.features);
  }

  /**
   * Executes trade with $2.000000 base margin and sequential leverage fallback:
   * Try 10x -> if failed try 11x -> 12x -> 13x -> 14x -> max 15x!
   */
  private async executeEntryWithLeverageLadder(
    symbol: string,
    side: 'LONG' | 'SHORT',
    features: EntryFeatureVector
  ) {
    if (this.openingInFlight.has(symbol)) return;
    this.openingInFlight.add(symbol);

    const style = this.aiClub.getStyleParams();
    const baseMarginUsd = style.baseMarginUsd; // $2.000000
    const filter = this.restClient.getSymbolFilter(symbol);

    if (!filter) {
      this.openingInFlight.delete(symbol);
      logger.warn('EXECUTION', `Missing exchangeInfo precision filter for ${symbol}; skipping.`);
      return;
    }

    const orderSide: 'BUY' | 'SELL' = side === 'LONG' ? 'BUY' : 'SELL';
    const positionSide: 'BOTH' | 'LONG' | 'SHORT' = this.hedgeMode ? side : 'BOTH';

    try {
      const ladder = [10, 11, 12, 13, 14, 15];
      let lastErrorMsg = '';

      for (const lev of ladder) {
        try {
          logger.exec(
            'EXECUTION',
            `Attempting ${side} entry on ${symbol} | Base Margin: $${f6(
              baseMarginUsd
            )} | Trying Leverage: ${lev}x...`
          );

          await this.restClient.setLeverage(symbol, lev);

          const livePrice =
            this.wsManager.getLastPrice(symbol) ||
            this.wsManager.getMarkPrice(symbol) ||
            0;

          if (livePrice <= 0) {
            throw new Error(`No live price available for ${symbol}`);
          }

          const targetNotional = baseMarginUsd * lev;
          const rawQty = targetNotional / livePrice;
          const qtyStr = formatOrderQty(rawQty, filter.stepSize, filter.stepDecimals);
          const qtyNum = parseFloat(qtyStr);
          const actualNotional = qtyNum * livePrice;

          if (qtyNum < filter.minQty) {
            throw new Error(
              `Rounded qty ${qtyStr} < Binance minQty ${filter.minQty} at ${lev}x ($${f6(
                targetNotional
              )} notional)`
            );
          }

          if (actualNotional < filter.minNotional) {
            throw new Error(
              `Order notional $${f6(actualNotional)} < Binance MIN_NOTIONAL $${f6(
                filter.minNotional
              )} at ${lev}x`
            );
          }

          const orderRes = await this.restClient.placeMarketOrder({
            symbol,
            side: orderSide,
            positionSide,
            quantity: qtyStr,
            isCloseOrder: false,
            hedgeMode: this.hedgeMode,
          });

          const executedQty = parseFloat(orderRes.executedQty || qtyStr) || qtyNum;
          const fillPrice = parseFloat(orderRes.avgPrice || '0') || livePrice;
          const takerRate = await this.restClient.getTakerCommissionRate(symbol);
          this.commissionMap.set(symbol, takerRate);

          const initialMargin = (executedQty * fillPrice) / lev;
          const estFees = executedQty * fillPrice * takerRate * 2;
          features.leverageUsed = lev;

          const newPos: OpenTradePosition = {
            symbol,
            side,
            positionSide,
            quantity: executedQty,
            leverage: lev,
            entryPrice: fillPrice,
            markPrice: fillPrice,
            initialMargin,
            notionalValue: executedQty * fillPrice,
            roiPct: 0,
            grossPnl: 0,
            binanceFees: estFees,
            netPnl: -estFees,
            commissionRate: takerRate,
            openedAt: Date.now(),
            runningTimeSec: 0,
            trailingActive: false,
            peakRoiPct: 0,
            worstRoiPct: 0,
            trailingStopRoiPct: null,
            protectiveStopRoiPct: style.protectiveStopRoiPct,
            lastCheckedAt: Date.now(),
            entryFeatures: features,
          };

          this.positionMonitor.registerNewlyOpenedPosition(newPos);
          this.cooldownUntilMap.set(symbol, Date.now() + 45_000);

          logger.success(
            'EXECUTION',
            `✅ EXECUTED ${side} ${symbol} @ $${f6(fillPrice)} | Qty: ${f6(
              executedQty
            )} | Leverage: ${lev}x | Margin: $${f6(initialMargin)} | OrderID: ${
              orderRes.orderId
            }`
          );

          await this.syncAccountSummaryOnly();
          this.broadcastSnapshot();
          return;
        } catch (stepErr) {
          lastErrorMsg = (stepErr as Error).message;
          if (lev < 15) {
            logger.warn(
              'EXECUTION',
              `⚠️ ${symbol} ${lev}x failed (${lastErrorMsg}) → Escalating immediately to ${
                lev + 1
              }x...`
            );
          }
        }
      }

      // All 10x..15x attempts failed (e.g., symbol requires $100 MIN_NOTIONAL like BTCUSDT while max $2 * 15x = $30)
      this.cooldownUntilMap.set(symbol, Date.now() + 5 * 60_000);
      logger.error(
        'EXECUTION',
        `❌ ${symbol} (${side}) failed across full 10x→15x ladder. Final reason: ${lastErrorMsg}. Placed ${symbol} on 5m cooldown to protect API rate limit.`
      );
    } finally {
      this.openingInFlight.delete(symbol);
    }
  }

  public async closePositionNow(pos: OpenTradePosition, reason: string): Promise<boolean> {
    const posKey = `${pos.symbol}:${pos.positionSide}`;
    if (this.closingInFlight.has(posKey)) return false;
    this.closingInFlight.add(posKey);

    try {
      const filter = this.restClient.getSymbolFilter(pos.symbol);
      const qtyStr = filter
        ? formatOrderQty(pos.quantity, filter.stepSize, filter.stepDecimals)
        : String(pos.quantity);

      const closeSide: 'BUY' | 'SELL' = pos.side === 'LONG' ? 'SELL' : 'BUY';

      logger.exec(
        'EXECUTION',
        `Closing ${pos.side} ${pos.symbol} (Qty=${qtyStr}) | Reason: ${reason}`
      );

      const res = await this.restClient.placeMarketOrder({
        symbol: pos.symbol,
        side: closeSide,
        positionSide: pos.positionSide,
        quantity: qtyStr,
        isCloseOrder: true,
        hedgeMode: this.hedgeMode,
      });

      const exitPrice = parseFloat(res.avgPrice || '0') || pos.markPrice;
      this.positionMonitor.removePosition(pos.symbol, pos.positionSide);

      await this.finalizeClosedTradePostMortem(pos, exitPrice, reason);
      await this.syncAccountSummaryOnly();
      this.broadcastSnapshot();
      return true;
    } catch (err) {
      logger.error(
        'EXECUTION',
        `Failed to close ${pos.symbol} (${pos.side}): ${(err as Error).message}`
      );
      return false;
    } finally {
      this.closingInFlight.delete(posKey);
    }
  }

  private async finalizeClosedTradePostMortem(
    pos: OpenTradePosition,
    exitPrice: number,
    exitReason: string
  ) {
    const now = Date.now();
    const durationSec = Math.max(1, (now - pos.openedAt) / 1000);
    const grossPnl =
      pos.side === 'LONG'
        ? (exitPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - exitPrice) * pos.quantity;
    const binanceFees =
      pos.quantity * pos.entryPrice * pos.commissionRate +
      pos.quantity * exitPrice * pos.commissionRate;
    const netPnl = grossPnl - binanceFees;
    const finalRoiPct = pos.initialMargin > 0 ? (grossPnl / pos.initialMargin) * 100 : 0;

    if (netPnl <= 0) {
      const cdSec = this.aiClub.getStyleParams().cooldownSecondsAfterLoss;
      this.cooldownUntilMap.set(pos.symbol, now + cdSec * 1000);
    } else {
      this.cooldownUntilMap.set(pos.symbol, now + 30_000);
    }

    const fallbackFeatures: EntryFeatureVector = pos.entryFeatures || {
      rsi15s: 50,
      emaSpreadPct: 0,
      pullbackDepthPct: 0.2,
      orderflowDeltaRatio: 1.2,
      candleBodyRatio: 0.4,
      wickRejectionRatio: 0.2,
      absChange24hPct: 12,
      volatilityAtrPct: 0.15,
      aiConfidence: 0.6,
      leverageUsed: pos.leverage,
    };

    const { analysis, mutationRecord } = await this.aiClub.runTradePostMortem({
      symbol: pos.symbol,
      side: pos.side,
      netPnl,
      grossPnl,
      binanceFees,
      finalRoiPct,
      peakRoiPct: Math.max(pos.peakRoiPct, finalRoiPct),
      worstRoiPct: Math.min(pos.worstRoiPct, finalRoiPct),
      durationSec,
      exitReason,
      features: fallbackFeatures,
    });

    const record: ClosedTradeRecord = {
      id: crypto.randomUUID(),
      symbol: pos.symbol,
      side: pos.side,
      leverage: pos.leverage,
      quantity: pos.quantity,
      entryPrice: pos.entryPrice,
      exitPrice,
      initialMargin: pos.initialMargin,
      grossPnl,
      binanceFees,
      netPnl,
      finalRoiPct,
      peakRoiPct: Math.max(pos.peakRoiPct, finalRoiPct),
      worstRoiPct: Math.min(pos.worstRoiPct, finalRoiPct),
      openedAt: pos.openedAt,
      closedAt: now,
      durationSec,
      exitReason,
      entryFeatures: fallbackFeatures,
      postMortem: analysis,
    };

    this.stateStore.recordClosedTrade(
      record,
      mutationRecord,
      this.aiClub.getStyleParams(),
      this.aiClub.getSystem1Weights()
    );

    logger.success(
      'EXECUTION',
      `🏁 CLOSED ${pos.side} ${pos.symbol} @ $${f6(exitPrice)} | Gross PNL: $${f6(
        grossPnl
      )} | Fees: $${f6(binanceFees)} | Net PNL: $${f6(netPnl)} | ROI: ${f6(
        finalRoiPct
      )}% | Time: ${f6(durationSec)}s`
    );
  }

  public getSnapshot(): DashboardSnapshot {
    const creds = this.stateStore.getCredentials();
    const startInfo = this.stateStore.getStartBalanceInfo();
    const style = this.aiClub.getStyleParams();
    const stats = this.stateStore.getStatsSummary();
    const { positive, negative } = this.scanner.getCurrentLists();
    const openPositions = this.positionMonitor.getOpenPositionsList();

    const maxDeployable95 = this.currentEquity * (style.capitalUtilizationCapPct / 100);
    const remaining95 = Math.max(
      0,
      Math.min(this.availableBalance, maxDeployable95 - this.usedMarginTotal)
    );
    const capUtilPct =
      this.currentEquity > 0 ? (this.usedMarginTotal / this.currentEquity) * 100 : 0;

    const marginFull = this.isMarginExhausted95();
    let scannerState: ScannerOperatingState = 'ACTIVE_SCANNING';
    let scannerPauseReason: string | null = null;

    if (!this.rateGovernor.wsConnected && positive.length === 0 && negative.length === 0) {
      scannerState = 'DISCONNECTED';
      scannerPauseReason =
        'Waiting for Binance Futures market stream connectivity (connects automatically on your PC / Online Server).';
    } else if (marginFull) {
      scannerState = 'PAUSED_MARGIN_FULL';
      scannerPauseReason = `95.000000% Balance Utilized (Remaining Tradable Margin $${f6(
        remaining95
      )} < $${f6(
        style.baseMarginUsd
      )}). Scanner paused — focusing 100% on open running positions!`;
    } else if (!this.engineRunning) {
      scannerState = 'PAUSED_BOT_STOPPED';
      scannerPauseReason =
        'Market Scanner live in preview mode — flip MASTER ENGINE ON to execute 15s pullback trades.';
    }

    return {
      botName: 'HFT',
      copyright: 'Copyright © Trading Lifestyle Quant. Developed by Trading Lifestyle Quant.',
      timestamp: Date.now(),
      engineRunning: this.engineRunning,
      apiConfigured: Boolean(creds.apiKey && creds.apiSecret),
      apiConnected: this.apiConnected,
      maskedApiKey: maskApiKey(creds.apiKey),
      hedgeMode: this.hedgeMode,

      startBalance: startInfo.startBalance,
      startBalanceLocked: startInfo.startBalanceLocked,
      startBalanceLockedAt: startInfo.startBalanceLockedAt,
      currentEquity: this.currentEquity,
      walletBalance: this.walletBalance,
      availableBalance: this.availableBalance,
      unrealizedPnlTotal: this.unrealizedPnlTotal,
      usedMarginTotal: this.usedMarginTotal,
      maxDeployable95Margin: maxDeployable95,
      remainingDeployable95Margin: remaining95,
      capitalUtilizationPct: capUtilPct,

      scannerState,
      scannerPauseReason,
      openPositions,
      positiveAssets: positive,
      negativeAssets: negative,

      styleParams: style,
      system1Weights: this.aiClub.getSystem1Weights(),
      localDecisionConfig: this.aiClub.getLocalDecisionConfig(),
      agents: this.aiClub.getAgents(),
      recentClosedTrades: stats.closedTrades,
      styleMutations: stats.styleMutations,
      winCount: stats.winCount,
      lossCount: stats.lossCount,
      winRatePct: stats.winRatePct,
      realizedNetPnlTotal: stats.realizedNetPnlTotal,

      rateTelemetry: this.rateGovernor.getTelemetry(),
      ipReport: this.ipReport,
    };
  }

  private broadcastSnapshot() {
    if (this.snapshotSubscribers.size === 0) return;
    const snap = this.getSnapshot();
    for (const sub of this.snapshotSubscribers) {
      try {
        sub(snap);
      } catch {
        // ignore
      }
    }
  }
}

import crypto from 'node:crypto';
import type {
  ClosedTradeRecord,
  DashboardSnapshot,
  EntryFeatureVector,
  LocalDecisionConfig,
  LocalDecisionProvider,
  OpenTradePosition,
  OperatorDirective,
  OperatorNote,
  ScannerOperatingState,
  ServerIpReport,
} from '../types.js';
import { BinanceRateGovernor } from '../binance/rateGovernor.js';
import { BinanceFuturesRestClient, type RawOrderResult } from '../binance/restClient.js';
import { CandleBuilder15s } from '../binance/candleBuilder15s.js';
import { BinanceWsStreamManager } from '../binance/wsStreamManager.js';
import { AiAgentClubOrchestrator } from '../ai/agentClubGraph.js';
import { StateStore } from './stateStore.js';
import { MarketScanner40 } from './marketScanner.js';
import { RestMarketFeed } from './restMarketFeed.js';
import { IncomeLedger } from './incomeLedger.js';
import { buildPnlLedger } from './pnlLedger.js';
import { aggregateLessonPatterns } from '../ai/lessonMemory.js';
import { describeDirective, findVetoingDirective } from '../ai/operatorDirectives.js';
import { PositionMonitor1s, type StopLevelChange } from './positionMonitor1s.js';
import { evaluate15sPullbackStrategy } from './strategy15s.js';
import { f6, formatOrderQty, maskApiKey } from '../utils/format.js';
import { clearsFeeHurdle } from '../utils/feeHurdle.js';
import { sanitizeStyleParams } from '../utils/styleGuard.js';
import {
  checkDecisionEndpoint,
  LOCAL_DECISION_PROVIDERS,
  providerNeedsEndpoint,
} from '../utils/netGuard.js';
import { decideStop, priceForRoi, roundStopPrice } from '../utils/stops.js';
import {
  isAmbiguousOrderFailure,
  isUnfilledOrderStatus,
  makeEntryClientOrderId,
} from '../utils/orderSafety.js';
import { isValidIpv4, scanServerIpv4Addresses } from '../utils/ipDiscovery.js';
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
  public readonly restMarketFeed: RestMarketFeed;
  public readonly incomeLedger: IncomeLedger;
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
  /** posKey -> working exchange stop orderId, so exactly one stop protects a position. */
  private exchangeStopOrderIds = new Map<string, number>();
  /** Positions whose stop was deliberately skipped, so the skip is logged once, not per second. */
  private exchangeStopSkips = new Set<string>();
  private pendingStopCancels: { symbol: string; orderId: number; attempts: number }[] = [];
  private exchangeStopFailures = 0;
  private exchangeStopsDisabled = false;
  private lastMarginPausedState = false;
  private tickCounter = 0;
  private pendingBroadcast: NodeJS.Timeout | null = null;
  private mainLoopTimer: NodeJS.Timeout | null = null;
  private snapshotSubscribers = new Set<(snap: DashboardSnapshot) => void>();

  constructor() {
    this.scanner = new MarketScanner40(this.restClient, this.wsManager, this.candleBuilder);
    this.restMarketFeed = new RestMarketFeed(this.restClient, this.wsManager, this.candleBuilder);
    this.incomeLedger = new IncomeLedger(this.restClient, this.stateStore);
    this.positionMonitor = new PositionMonitor1s(this.stateStore);
    this.aiClub = new AiAgentClubOrchestrator({
      styleParams: this.stateStore.getStyleParams(),
      system1Weights: this.stateStore.getSystem1Weights(),
      localConfig: this.stateStore.getLocalDecisionConfig(),
      lessons: this.stateStore.getLessons(),
      operatorNotes: this.stateStore.getOperatorNotes(),
    });

    this.engineRunning = this.stateStore.getEngineRunning();

    const boundIp = this.stateStore.getBoundLocalAddress();
    if (boundIp && !isValidIpv4(boundIp)) {
      this.stateStore.setBoundLocalAddress(null);
      logger.warn(
        'STATE',
        `Discarded bound local address "${boundIp}" from the vault — it is not an IPv4 address, and every signed request would fail to leave the machine.`
      );
    } else if (boundIp) {
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
      const { exits, stopLevelChanges } = this.positionMonitor.tickRealtimePrices(
        (sym) => markMap.get(sym),
        this.aiClub.getStyleParams()
      );
      this.handleStopLevelChanges(stopLevelChanges);
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

    // Pull the settled income ledger before the first snapshot goes out. Throttled
    // internally, so the 1s heartbeat can call it freely afterwards.
    await this.incomeLedger.sync(true);

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

    logger.info('BINANCE_API', 'Validating Binance Portfolio Margin (UM) API credentials...');
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
        `Binance Portfolio Margin (UM) Connected! Mode: ${
          this.hedgeMode ? 'HEDGE MODE (Dual-Side)' : 'ONE-WAY MODE'
        } | Equity: $${f6(this.currentEquity)} USDT | uniMMR: ${f6(
          this.restClient.getLastUniMmr()
        )} | Status: ${this.restClient.getLastAccountStatus()}`
      );
      return {
        connected: true,
        message: `Connected to Binance Portfolio Margin (${
          this.hedgeMode ? 'Hedge Mode' : 'One-Way Mode'
        }). Equity: $${f6(this.currentEquity)} USDT`,
      };
    } catch (err) {
      this.apiConnected = false;
      const msg = (err as Error).message;
      logger.error(
        'BINANCE_API',
        `Binance Portfolio Margin authentication/network error: ${msg}. Verify API Key, Secret, 'Enable Portfolio Margin Trading' permission, and IPv4 Whitelist in Settings.`
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

  public updateLocalDecisionConfig(cfg: Partial<LocalDecisionConfig>): { rejected: string[] } {
    const current = this.aiClub.getLocalDecisionConfig();
    const provider = (cfg.provider ?? current.provider) as LocalDecisionProvider;
    const rawEndpoint =
      cfg.endpointUrl !== undefined ? String(cfg.endpointUrl).trim() : current.endpointUrl;
    const rejected: string[] = [];
    let endpointUrl = rawEndpoint;

    if (!LOCAL_DECISION_PROVIDERS.includes(provider)) {
      rejected.push(`"${String(cfg.provider)}" is not a supported decision provider`);
    }
    if (providerNeedsEndpoint(provider)) {
      const check = checkDecisionEndpoint(rawEndpoint);
      if (!check.ok) rejected.push(check.reason);
      else endpointUrl = check.normalizedUrl;
    }

    if (rejected.length > 0) {
      logger.warn(
        'AI_CLUB',
        `Rejected System-1 runtime change — nothing was stored: ${rejected.join('; ')}`,
        { provider: String(cfg.provider), endpointUrl: rawEndpoint }
      );
      return { rejected };
    }

    const modelName =
      typeof cfg.modelName === 'string' ? cfg.modelName.trim().slice(0, 96) : current.modelName;
    this.aiClub.setLocalDecisionConfig({ provider, endpointUrl, modelName });
    this.stateStore.setLocalDecisionConfig(this.aiClub.getLocalDecisionConfig());
    logger.ai(
      'AI_CLUB',
      `Updated System-1 Decision Runtime to ${this.aiClub.getLocalDecisionConfig().provider} (${
        this.aiClub.getLocalDecisionConfig().endpointUrl
      }).`
    );
    this.broadcastSnapshot();
    return { rejected: [] };
  }

  public updateStyleParams(input: unknown): { accepted: string[]; rejected: string[] } {
    const { accepted, rejected } = sanitizeStyleParams(this.aiClub.getStyleParams(), input);
    const keys = Object.keys(accepted);
    if (keys.length > 0) {
      this.aiClub.updateStyleParams(accepted);
      this.stateStore.setStyleParams(this.aiClub.getStyleParams());
      logger.ai('AI_CLUB', 'Updated HFT style parameters.', accepted as Record<string, unknown>);
    }
    if (rejected.length > 0) {
      logger.warn('AI_CLUB', `Refused unsafe style parameters: ${rejected.join('; ')}`, {
        accepted: keys,
      });
    }
    this.broadcastSnapshot();
    return { accepted: keys, rejected };
  }

  public getOperatorDirectives(): OperatorDirective[] {
    return this.stateStore.getOperatorDirectives();
  }

  public addOperatorDirective(input: {
    kind: OperatorDirective['kind'];
    symbol?: string;
    value?: number;
    reason?: string;
  }) {
    const directive = this.stateStore.addOperatorDirective(input);
    logger.ai(
      'AI_CLUB',
      `Operator standing order accepted and now binding on every entry: ${describeDirective(
        directive
      )}${directive.reason ? ` — ${directive.reason}` : ''}`
    );
    this.broadcastSnapshot();
    return directive;
  }

  public setOperatorDirectiveActive(id: string, active: boolean): boolean {
    const ok = this.stateStore.setOperatorDirectiveActive(id, active);
    if (ok) {
      logger.ai(
        'AI_CLUB',
        `Operator standing order ${active ? 're-armed' : 'lifted'} (${id.slice(0, 8)}).`
      );
      this.broadcastSnapshot();
    }
    return ok;
  }

  public addOperatorNote(text: string): OperatorNote | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const note = this.stateStore.addOperatorNote(trimmed);
    this.aiClub.setOperatorNotes(this.stateStore.getOperatorNotes());
    logger.ai('AI_CLUB', `Operator briefing passed to the agent club: ${note.text}`);
    this.broadcastSnapshot();
    return note;
  }

  public removeOperatorNote(id: string): boolean {
    const ok = this.stateStore.removeOperatorNote(id);
    if (ok) {
      this.aiClub.setOperatorNotes(this.stateStore.getOperatorNotes());
      this.broadcastSnapshot();
    }
    return ok;
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
      // Settled income (real commissions + funding) refreshes once a minute.
      this.incomeLedger.sync().catch(() => {});
    }

    // Tick running time & live WS mark prices every single second
    const { exits: tickExits, stopLevelChanges: tickStopChanges } =
      this.positionMonitor.tickRealtimePrices(
        (sym) => this.wsManager.getMarkPrice(sym) ?? this.wsManager.getLastPrice(sym),
        this.aiClub.getStyleParams()
      );
    this.handleStopLevelChanges(tickStopChanges);
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
    this.restMarketFeed.setWatchedSymbols(watchedSymbols);

    // Fail over to the REST market data feed when the aggTrade stream is dead,
    // and stand it down the moment the WebSocket tape returns. The 20s grace
    // period lets a healthy stream prove itself before boot engages the fallback.
    if (this.tickCounter > 20) {
      const wsTapeLive = this.wsManager.isAggTradeDataLive();
      if (!wsTapeLive && !this.restMarketFeed.isActive()) {
        this.restMarketFeed.start();
      } else if (wsTapeLive && this.restMarketFeed.isActive()) {
        this.restMarketFeed.stop();
      }
    }

    if (this.tickCounter % 60 === 0) {
      const keep = new Set(watchedSymbols);
      this.candleBuilder.pruneSymbolsExcept(keep);
      this.restMarketFeed.pruneSymbolsExcept(keep);
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
    await this.drainPendingStopCancels();
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

      const { exitsToExecute, externallyClosedPositions, stopLevelChanges } =
        this.positionMonitor.syncFromBinanceRisks(
          risks,
          (sym) => this.wsManager.getMarkPrice(sym),
          (sym) => this.commissionMap.get(sym) ?? 0.0005,
          this.aiClub.getStyleParams()
        );

      this.handleStopLevelChanges(stopLevelChanges);

      // Positions that survived a restart have no tracked stop: re-arm from the live level.
      const liveKeys = new Set<string>();
      const style = this.aiClub.getStyleParams();
      for (const pos of this.positionMonitor.getOpenPositionsList()) {
        const key = `${pos.symbol}:${pos.positionSide}`;
        liveKeys.add(key);
        if (this.exchangeStopOrderIds.has(key) || this.closingInFlight.has(key)) continue;
        const decision = decideStop(
          pos.roiPct,
          pos.trailingActive,
          pos.trailingStopRoiPct,
          style.protectiveStopRoiPct
        );
        this.armExchangeStop(pos, decision.levelRoiPct, decision.kind).catch(() => {});
      }
      for (const key of Array.from(this.exchangeStopOrderIds.keys())) {
        if (!liveKeys.has(key)) this.exchangeStopOrderIds.delete(key);
      }
      for (const key of Array.from(this.exchangeStopSkips)) {
        if (!liveKeys.has(key)) this.exchangeStopSkips.delete(key);
      }

      for (const extClosed of externallyClosedPositions) {
        // The exchange stop closing the position IS the success case; withdraw whatever is left
        // so it cannot flatten the next trade on the same symbol.
        this.disarmExchangeStop(extClosed.symbol, extClosed.positionSide);
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

  /**
   * Cached taker rate for the entry-side fee maths. Falls back to the standard omnibus rate
   * and refreshes in the background: a cold cache must never block an entry, and the true
   * rate is re-read before a fill is booked anyway.
   */
  private takerRateFor(symbol: string): number {
    const cached = this.commissionMap.get(symbol);
    if (cached) return cached;
    this.restClient
      .getTakerCommissionRate(symbol)
      .then((rate) => this.commissionMap.set(symbol, rate))
      .catch(() => {});
    return 0.0005;
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

    // Fee-hurdle gate. This is the arithmetic behind most scalping books that lose: the
    // round trip costs a fixed share of margin ROI, and the 15s structure has to be bigger
    // than that twice over before the trade can end green. Leverage cancels out of the
    // ratio, so no rung of the ladder can rescue a move too small to pay for itself.
    const hurdle = clearsFeeHurdle(
      stratEval.features.volatilityAtrPct,
      this.takerRateFor(symbol),
      Math.round(style.minLeverage),
      style.minFeeHurdleMultiple
    );
    if (!hurdle.ok) {
      this.cooldownUntilMap.set(symbol, Date.now() + 20_000);
      logger.ai(
        'EXECUTION',
        `⛔ FEE HURDLE ${symbol} ${side}: 15s ATR excursion ${f6(
          hurdle.expectedRoiPct
        )}% ROI is only ${f6(
          hurdle.ratio
        )}x the ${f6(hurdle.hurdleRoiPct)}% round-trip taker cost (needs ${f6(
          hurdle.requiredRatio
        )}x) — skipping, the move cannot pay for its own exit.`
      );
      return;
    }

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

    // Log what the shared memory contributed to this approval, so a lesson that
    // changed an entry decision is visible in the tape rather than implied.
    if (consensus.lessonKey) {
      logger.ai('AI_CLUB', `Shared memory [${consensus.lessonKey}]: ${consensus.lessonGuidance}`);
    }

    // Operator standing orders sit above the council: an entry the club approved is
    // still blocked, and the veto is recorded against the rule that made it.
    const directiveVeto = findVetoingDirective(this.stateStore.getOperatorDirectives(), {
      symbol,
      side,
      features: stratEval.features,
      openPositionCount: this.positionMonitor.getOpenPositionsList().length,
    });
    if (directiveVeto) {
      this.stateStore.recordDirectiveApplied(directiveVeto.id);
      logger.ai(
        'AI_CLUB',
        `OPERATOR RULE vetoed ${symbol} ${side} that the AI Club approved — ${describeDirective(
          directiveVeto
        )}${directiveVeto.reason ? ` (${directiveVeto.reason})` : ''}`
      );
      return;
    }

    // Re-check 95% capital ceiling right before order placement
    if (this.isMarginExhausted95()) return;

    await this.executeEntryWithLeverageLadder(
      symbol,
      side,
      stratEval.features,
      consensus.recommendedStartLeverage
    );
  }

  /**
   * Executes trade with $2.000000 base margin and sequential leverage fallback:
   * Start from the leverage System-1 says clears MIN_NOTIONAL, then step upward to 15x!
   */
  private async executeEntryWithLeverageLadder(
    symbol: string,
    side: 'LONG' | 'SHORT',
    features: EntryFeatureVector,
    startLeverage: number
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
      const first = Math.min(
        Math.max(Math.round(startLeverage), Math.round(style.minLeverage)),
        Math.round(style.maxLeverage)
      );
      const ladder: number[] = [];
      for (let lev = first; lev <= style.maxLeverage; lev++) ladder.push(lev);
      let lastErrorMsg = '';
      let fill: { order: RawOrderResult; leverage: number } | null = null;

      for (const lev of ladder) {
        // Deterministic per attempt and unique per send: it is the only handle that can
        // answer "did the POST that timed out actually fill?" without placing a second order.
        const clientOrderId = makeEntryClientOrderId(symbol, side, lev);
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
            newClientOrderId: clientOrderId,
          });

          if (isUnfilledOrderStatus(orderRes.status)) {
            // The exchange answered, and the answer was "no position". Safe to step up.
            lastErrorMsg = `${symbol} ${lev}x order came back ${orderRes.status} with ${orderRes.executedQty} filled`;
            continue;
          }

          fill = { order: orderRes, leverage: lev };
          break;
        } catch (stepErr) {
          lastErrorMsg = (stepErr as Error).message;

          if (!isAmbiguousOrderFailure(stepErr)) {
            if (lev < style.maxLeverage) {
              logger.warn(
                'EXECUTION',
                `⚠️ ${symbol} ${lev}x rejected before it could reach the book (${lastErrorMsg}) → Escalating to ${
                  lev + 1
                }x...`
              );
            }
            continue;
          }

          // The request may have been booked. Ask Binance; never re-send blind.
          const outcome = await this.resolveAmbiguousEntry(symbol, clientOrderId);
          if (outcome.status === 'FILLED' && outcome.order) {
            logger.warn(
              'EXECUTION',
              `⚠️ ${symbol} ${lev}x POST did not answer (${lastErrorMsg}), but Binance confirms ${clientOrderId} = ${outcome.order.status}. Adopting that fill instead of re-sending.`
            );
            fill = { order: outcome.order, leverage: lev };
            break;
          }
          if (outcome.status === 'ABSENT') {
            if (lev < style.maxLeverage) {
              logger.warn(
                'EXECUTION',
                `⚠️ ${symbol} ${lev}x never reached the book (${lastErrorMsg}) → Escalating to ${
                  lev + 1
                }x...`
              );
            }
            continue;
          }
          // Unknown. If the order landed, the 1s position sync adopts it; re-sending at the
          // next rung is how a real-money account ends up holding twice the intended size.
          logger.error(
            'EXECUTION',
            `❌ ${symbol} ${lev}x entry outcome unknown (${lastErrorMsg}). Stopping the ladder without re-sending; position sync will adopt the fill if it landed.`
          );
          this.cooldownUntilMap.set(symbol, Date.now() + 60_000);
          return;
        }
      }

      if (!fill) {
        // Every rung failed before reaching the book (e.g. the symbol requires $100
        // MIN_NOTIONAL like BTCUSDT while max $2 * 15x = $30).
        this.cooldownUntilMap.set(symbol, Date.now() + 5 * 60_000);
        logger.error(
          'EXECUTION',
          `❌ ${symbol} (${side}) failed across the ${first}x→${Math.round(
            style.maxLeverage
          )}x ladder. Final reason: ${lastErrorMsg}. Placed ${symbol} on 5m cooldown to protect API rate limit.`
        );
        return;
      }

      // A fill is confirmed. Nothing below this line may re-send an order.
      const orderRes = fill.order;
      const filledLeverage = fill.leverage;
      const executedQty = parseFloat(orderRes.executedQty || '0') || 0;
      const marketPrice =
        this.wsManager.getLastPrice(symbol) || this.wsManager.getMarkPrice(symbol) || 0;
      const fillPrice =
        parseFloat(orderRes.avgPrice || '0') || parseFloat(orderRes.price || '0') || marketPrice;

      if (!(executedQty > 0) || !(fillPrice > 0)) {
        logger.error(
          'EXECUTION',
          `❌ ${symbol} reported ${orderRes.status} with no usable fill (qty ${orderRes.executedQty}, avg ${orderRes.avgPrice}). Leaving reconciliation to the 1s position sync.`
        );
        return;
      }

      const takerRate = await this.restClient.getTakerCommissionRate(symbol);
      this.commissionMap.set(symbol, takerRate);

      const initialMargin = (executedQty * fillPrice) / filledLeverage;
      const estFees = executedQty * fillPrice * takerRate * 2;
      features.leverageUsed = filledLeverage;

      const newPos: OpenTradePosition = {
        symbol,
        side,
        positionSide,
        quantity: executedQty,
        leverage: filledLeverage,
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
        entryProtectiveStopRoiPct: style.protectiveStopRoiPct,
        lastCheckedAt: Date.now(),
        entryFeatures: features,
      };

      this.positionMonitor.registerNewlyOpenedPosition(newPos);
      this.cooldownUntilMap.set(symbol, Date.now() + 45_000);

      // Exchange-side protection: if this process stalls, the stop still lives on Binance.
      await this.armExchangeStop(newPos, style.protectiveStopRoiPct, 'GUARD');

      logger.success(
        'EXECUTION',
        `✅ EXECUTED ${side} ${symbol} @ $${f6(fillPrice)} | Qty: ${f6(
          executedQty
        )} | Leverage: ${filledLeverage}x | Margin: $${f6(initialMargin)} | OrderID: ${
          orderRes.orderId
        }`
      );

      await this.syncAccountSummaryOnly();
      this.broadcastSnapshot();
    } finally {
      this.openingInFlight.delete(symbol);
    }
  }

  /**
   * Resolve an entry POST whose answer we never got. Querying the client order id is the
   * only safe move: -2013 (unknown order) proves it was never booked, a FILLED/PARTIALLY_FILLED
   * status proves it was, and anything else stays UNKNOWN — which stops the ladder rather than
   * risking a second position.
   */
  private async resolveAmbiguousEntry(
    symbol: string,
    clientOrderId: string
  ): Promise<{ status: 'FILLED' | 'ABSENT' | 'UNKNOWN'; order?: RawOrderResult }> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const order = await this.restClient.queryOrderByClientId(symbol, clientOrderId);
        const status = (order?.status || '').toUpperCase();
        const executedQty = parseFloat(order?.executedQty || '0');
        if (status === 'FILLED' || status === 'PARTIALLY_FILLED' || executedQty > 0) {
          return { status: 'FILLED', order };
        }
        if (status === 'REJECTED' || status === 'CANCELED' || status === 'EXPIRED') {
          return { status: 'ABSENT' };
        }
      } catch (err) {
        // -2013 / -2011: the order is unknown to Binance, so nothing was booked and the
        // next rung of the ladder is safe.
        const code = (err as { code?: number }).code;
        if (code === -2013 || code === -2011) return { status: 'ABSENT' };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { status: 'UNKNOWN' };
  }

  /**
   * Put the protective exit on the exchange instead of only in this process. Placed
   * before the older stop is withdrawn so there is never an unprotected window; the
   * software 1 Hz guard keeps running as a backstop. Never throws — a failed arm must
   * never look like a failed entry to the leverage ladder.
   */
  private async armExchangeStop(
    pos: OpenTradePosition,
    roiLevelPct: number,
    kind: 'GUARD' | 'TRAIL'
  ): Promise<void> {
    const key = `${pos.symbol}:${pos.positionSide}`;
    if (this.exchangeStopsDisabled || !this.restClient.hasCredentials()) return;

    try {
      const filter = this.restClient.getSymbolFilter(pos.symbol);
      const raw = priceForRoi(pos.side, pos.entryPrice, pos.initialMargin, pos.quantity, roiLevelPct);
      if (!(raw > 0)) throw new Error('computed stop price is not positive');
      const stopPrice = filter
        ? roundStopPrice(raw, filter.tickSize, filter.tickDecimals, pos.side)
        : raw.toFixed(8);

      const mark = pos.markPrice > 0 ? pos.markPrice : pos.entryPrice;
      const onWrongSide =
        pos.side === 'LONG' ? Number(stopPrice) >= mark : Number(stopPrice) <= mark;
      if (onWrongSide) {
        if (!this.exchangeStopSkips.has(key)) {
          this.exchangeStopSkips.add(key);
          logger.exec(
            'EXCHANGE_STOP',
            `${pos.symbol} ${kind} stop skipped: trigger ${stopPrice} is not beyond mark ${f6(
              mark
            )} — the live 1s guard owns this exit.`
          );
        }
        return;
      }

      const res = await this.restClient.placeStopMarketClosePosition({
        symbol: pos.symbol,
        closeSide: pos.side === 'LONG' ? 'SELL' : 'BUY',
        positionSide: pos.positionSide,
        stopPrice,
        hedgeMode: this.hedgeMode,
      });

      const previousId = this.exchangeStopOrderIds.get(key);
      this.exchangeStopOrderIds.set(key, res.orderId);
      this.exchangeStopSkips.delete(key);
      if (previousId && previousId !== res.orderId) {
        this.requestStopCancel(pos.symbol, previousId);
      }

      this.exchangeStopFailures = 0;
      logger.success(
        'EXCHANGE_STOP',
        `🛡️ Binance-side ${kind} stop LIVE on ${pos.symbol} (${pos.side}) @ ${stopPrice} = ${f6(
          roiLevelPct
        )}% ROI | OrderID: ${res.orderId}`
      );
    } catch (err) {
      const code = (err as { code?: number }).code;
      this.exchangeStopFailures += 1;
      // A parameter this endpoint will never accept: stop asking and rely on the software guard.
      if (code === -1106 || code === -1117 || code === -4040 || code === -4062) {
        this.exchangeStopsDisabled = true;
        logger.error(
          'EXCHANGE_STOP',
          `Binance Portfolio Margin rejected stop orders (${code}: ${(err as Error).message}). Exchange-side stops disabled; the 1s software guard stays the only exit trigger.`
        );
        return;
      }
      if (this.exchangeStopFailures <= 3 || this.exchangeStopFailures % 25 === 0) {
        logger.warn(
          'EXCHANGE_STOP',
          `Failed to arm ${kind} stop on ${pos.symbol}: ${(err as Error).message}`
        );
      }
    }
  }

  private requestStopCancel(symbol: string, orderId: number): void {
    this.pendingStopCancels.push({ symbol, orderId, attempts: 0 });
  }

  /** Stop orders must not outlive the position they protected, or they can flatten a later entry. */
  private disarmExchangeStop(symbol: string, positionSide: string): void {
    const key = `${symbol}:${positionSide}`;
    this.exchangeStopSkips.delete(key);
    const orderId = this.exchangeStopOrderIds.get(key);
    if (!orderId) return;
    this.exchangeStopOrderIds.delete(key);
    this.requestStopCancel(symbol, orderId);
  }

  private async drainPendingStopCancels(): Promise<void> {
    if (!this.pendingStopCancels.length || !this.restClient.hasCredentials()) return;
    const queue = this.pendingStopCancels.splice(0, this.pendingStopCancels.length);

    for (const item of queue) {
      try {
        await this.restClient.cancelOpenOrder(item.symbol, item.orderId);
      } catch (err) {
        const code = (err as { code?: number }).code;
        // -2011: cancel of an unknown order. The stop already triggered or was cleared.
        if (code === -2011) continue;
        item.attempts += 1;
        if (item.attempts < 5) {
          this.pendingStopCancels.push(item);
        } else {
          logger.error(
            'EXCHANGE_STOP',
            `Could not withdraw stop ${item.orderId} on ${item.symbol} after 5 attempts: ${(err as Error).message}`
          );
        }
      }
    }
  }

  private handleStopLevelChanges(changes: StopLevelChange[]): void {
    for (const change of changes) {
      this.armExchangeStop(change.position, change.roiLevelPct, change.kind).catch(() => {});
    }
  }

  public async closePositionNow(pos: OpenTradePosition, reason: string): Promise<boolean> {
    const posKey = `${pos.symbol}:${pos.positionSide}`;
    if (this.closingInFlight.has(posKey)) return false;
    this.closingInFlight.add(posKey);

    // Withdraw the exchange stop before flattening so a late trigger cannot chase an
    // already-closed position; re-armed in the catch if this close does not land.
    this.disarmExchangeStop(pos.symbol, pos.positionSide);

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
      // The position is still open and now has no exchange stop — put the guard back.
      await this.armExchangeStop(
        pos,
        this.aiClub.getStyleParams().protectiveStopRoiPct,
        'GUARD'
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

    const { analysis, mutationRecord, lesson } = await this.aiClub.runTradePostMortem({
      symbol: pos.symbol,
      side: pos.side,
      netPnl,
      grossPnl,
      binanceFees,
      initialMargin: pos.initialMargin,
      leverage: pos.leverage,
      entryPrice: pos.entryPrice,
      exitPrice,
      finalRoiPct,
      peakRoiPct: Math.max(pos.peakRoiPct, finalRoiPct),
      worstRoiPct: Math.min(pos.worstRoiPct, finalRoiPct),
      durationSec,
      exitReason,
      features: fallbackFeatures,
      entryGuardRoiPct:
        pos.entryProtectiveStopRoiPct ?? this.aiClub.getStyleParams().protectiveStopRoiPct,
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
    this.stateStore.recordLesson(lesson);

    logger.success(
      'EXECUTION',
      `🏁 CLOSED ${pos.side} ${pos.symbol} @ $${f6(exitPrice)} | Gross PNL: $${f6(
        grossPnl
      )} | Fees: $${f6(binanceFees)} | Net PNL: $${f6(netPnl)} | ROI: ${f6(
        finalRoiPct
      )}% | Time: ${f6(durationSec)}s`
    );
    logger.ai('AI_CLUB', `Council next step: ${analysis.nextStep}`);
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

    // Ledger covers EVERY trade the engine ever closed, not just the last 40 shown.
    const history = this.stateStore.getClosedTradeHistory();
    const botSymbols = new Set<string>(history.map((t) => t.symbol));
    for (const p of openPositions) botSymbols.add(p.symbol);
    const lessons = this.stateStore.getLessons();
    const pnlLedger = buildPnlLedger(history, this.incomeLedger.getSummary(botSymbols));

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

      ledgerVersion: this.stateStore.getLedgerVersion(),
      pnlLedger,
      lessons,
      lessonPatterns: aggregateLessonPatterns(lessons),
      operatorDirectives: this.stateStore.getOperatorDirectives(),
      operatorNotes: this.stateStore.getOperatorNotes(),

      rateTelemetry: this.rateGovernor.getTelemetry(),
      ipReport: this.ipReport,
    };
  }

  private broadcastSnapshot() {
    if (this.snapshotSubscribers.size === 0) return;
    // Several events land inside one tick (mark price, account update, style change) and the
    // dashboard cannot tell them apart, so publish the merged state once per window instead of
    // re-serialising the whole snapshot per event.
    if (this.pendingBroadcast) return;
    this.pendingBroadcast = setTimeout(() => {
      this.pendingBroadcast = null;
      this.emitSnapshot();
    }, 120);
    this.pendingBroadcast.unref?.();
  }

  private emitSnapshot() {
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

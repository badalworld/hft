import fs from 'node:fs';
import path from 'node:path';
import type {
  AdaptiveStyleParams,
  ClosedTradeRecord,
  EntryFeatureVector,
  LocalDecisionConfig,
  StyleMutationRecord,
  System1Weights,
  TradeLesson,
} from '../types.js';
import { createDefaultStyleParams } from '../ai/agentClubGraph.js';
import { createDefaultSystem1Weights } from '../ai/system1Primitives.js';
import { prependLesson } from '../ai/lessonMemory.js';
import { decryptSecret, encryptSecret } from '../utils/cryptoVault.js';

export interface PersistedPositionMeta {
  symbol: string;
  openedAt: number;
  trailingActive: boolean;
  peakRoiPct: number;
  worstRoiPct: number;
  entryFeatures?: EntryFeatureVector;
}

export interface PersistedIncomeLedger {
  sinceMs: number;
  cursorMs: number;
  fundingFeeTotal: number;
  commissionTotal: number;
  realizedPnlTotal: number;
  otherIncomeTotal: number;
  fundingBySymbol: Record<string, number>;
  recordCount: number;
  lastSyncAt: number;
  available: boolean;
  status: string;
  seenTranIds: number[];
}

interface RawVaultData {
  encryptedApiKey: string;
  encryptedApiSecret: string;
  engineRunning: boolean;
  startBalance: number;
  startBalanceLocked: boolean;
  startBalanceLockedAt: number | null;
  boundLocalAddress: string | null;
  styleParams: AdaptiveStyleParams;
  system1Weights: System1Weights;
  localDecisionConfig: LocalDecisionConfig;
  closedTrades: ClosedTradeRecord[];
  styleMutations: StyleMutationRecord[];
  winCount: number;
  lossCount: number;
  realizedNetPnlTotal: number;
  openPositionMeta: Record<string, PersistedPositionMeta>;
  incomeLedger: PersistedIncomeLedger;
  lessons: TradeLesson[];
}

export class StateStore {
  private readonly filePath = path.resolve(process.cwd(), 'data', 'hft_vault.json');
  private data: RawVaultData;

  constructor() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = this.loadFromDisk();
  }

  private defaultData(): RawVaultData {
    return {
      encryptedApiKey: '',
      encryptedApiSecret: '',
      engineRunning: false,
      startBalance: 0,
      startBalanceLocked: false,
      startBalanceLockedAt: null,
      boundLocalAddress: null,
      styleParams: createDefaultStyleParams(),
      system1Weights: createDefaultSystem1Weights(),
      localDecisionConfig: {
        provider:
          (process.env.LOCAL_DECISION_PROVIDER as LocalDecisionConfig['provider']) || 'builtin',
        endpointUrl: process.env.LOCAL_DECISION_ENDPOINT || 'http://127.0.0.1:11434',
        modelName: process.env.LOCAL_DECISION_MODEL || 'nimble',
        lastLatencyMs: 0.18,
        lastStatus: 'Ready (Calibrated System-1 RLCD, $0 API cost)',
      },
      closedTrades: [],
      styleMutations: [],
      winCount: 0,
      lossCount: 0,
      realizedNetPnlTotal: 0,
      openPositionMeta: {},
      incomeLedger: {
        sinceMs: 0,
        cursorMs: 0,
        fundingFeeTotal: 0,
        commissionTotal: 0,
        realizedPnlTotal: 0,
        otherIncomeTotal: 0,
        fundingBySymbol: {},
        recordCount: 0,
        lastSyncAt: 0,
        available: false,
        status: 'Not synced yet',
        seenTranIds: [],
      },
      lessons: [],
    };
  }

  private loadFromDisk(): RawVaultData {
    const def = this.defaultData();
    try {
      if (!fs.existsSync(this.filePath)) return def;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RawVaultData>;
      return {
        ...def,
        ...parsed,
        styleParams: { ...def.styleParams, ...(parsed.styleParams || {}) },
        system1Weights: { ...def.system1Weights, ...(parsed.system1Weights || {}) },
        localDecisionConfig: {
          ...def.localDecisionConfig,
          ...(parsed.localDecisionConfig || {}),
        },
        openPositionMeta: parsed.openPositionMeta || {},
        incomeLedger: { ...def.incomeLedger, ...(parsed.incomeLedger || {}) },
        lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
      };
    } catch {
      return def;
    }
  }

  public save() {
    try {
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // ignore disk write race
    }
  }

  public getCredentials(): { apiKey: string; apiSecret: string } {
    return {
      apiKey: decryptSecret(this.data.encryptedApiKey),
      apiSecret: decryptSecret(this.data.encryptedApiSecret),
    };
  }

  public setCredentials(apiKey: string, apiSecret: string) {
    this.data.encryptedApiKey = apiKey ? encryptSecret(apiKey.trim()) : '';
    this.data.encryptedApiSecret = apiSecret ? encryptSecret(apiSecret.trim()) : '';
    this.save();
  }

  public getEngineRunning(): boolean {
    return this.data.engineRunning;
  }

  public setEngineRunning(running: boolean) {
    this.data.engineRunning = running;
    this.save();
  }

  public getStartBalanceInfo() {
    return {
      startBalance: this.data.startBalance,
      startBalanceLocked: this.data.startBalanceLocked,
      startBalanceLockedAt: this.data.startBalanceLockedAt,
    };
  }

  /**
   * Locks Start Balance ONLY on 1st Binance API connection when not yet locked!
   */
  public lockStartBalanceIfUnset(walletBalance: number): boolean {
    if (!this.data.startBalanceLocked && Number.isFinite(walletBalance) && walletBalance >= 0) {
      this.data.startBalance = walletBalance;
      this.data.startBalanceLocked = true;
      this.data.startBalanceLockedAt = Date.now();
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Explicit user action to reset Start Balance to current live balance (or re-arm for next fetch)
   */
  public resetStartBalance(newCurrentBalance?: number) {
    if (typeof newCurrentBalance === 'number' && Number.isFinite(newCurrentBalance) && newCurrentBalance > 0) {
      this.data.startBalance = newCurrentBalance;
      this.data.startBalanceLocked = true;
      this.data.startBalanceLockedAt = Date.now();
    } else {
      this.data.startBalance = 0;
      this.data.startBalanceLocked = false;
      this.data.startBalanceLockedAt = null;
    }
    this.save();
  }

  public getBoundLocalAddress(): string | null {
    return this.data.boundLocalAddress;
  }

  public setBoundLocalAddress(addr: string | null) {
    this.data.boundLocalAddress = addr;
    this.save();
  }

  public getStyleParams(): AdaptiveStyleParams {
    return this.data.styleParams;
  }

  public setStyleParams(params: AdaptiveStyleParams) {
    this.data.styleParams = params;
    this.save();
  }

  public getSystem1Weights(): System1Weights {
    return this.data.system1Weights;
  }

  public setSystem1Weights(weights: System1Weights) {
    this.data.system1Weights = weights;
    this.save();
  }

  public getLocalDecisionConfig(): LocalDecisionConfig {
    return this.data.localDecisionConfig;
  }

  public setLocalDecisionConfig(cfg: LocalDecisionConfig) {
    this.data.localDecisionConfig = cfg;
    this.save();
  }

  public getOpenPositionMeta(key: string): PersistedPositionMeta | undefined {
    return this.data.openPositionMeta[key];
  }

  public setOpenPositionMeta(key: string, meta: PersistedPositionMeta) {
    this.data.openPositionMeta[key] = meta;
    this.save();
  }

  public removeOpenPositionMeta(key: string) {
    if (key in this.data.openPositionMeta) {
      delete this.data.openPositionMeta[key];
      this.save();
    }
  }

  public recordClosedTrade(
    trade: ClosedTradeRecord,
    mutation: StyleMutationRecord | null,
    updatedStyle: AdaptiveStyleParams,
    updatedWeights: System1Weights
  ) {
    this.data.closedTrades.unshift(trade);
    if (this.data.closedTrades.length > 150) {
      this.data.closedTrades.length = 150;
    }

    if (mutation) {
      this.data.styleMutations.unshift(mutation);
      if (this.data.styleMutations.length > 100) {
        this.data.styleMutations.length = 100;
      }
    }

    if (trade.netPnl > 0) {
      this.data.winCount += 1;
    } else {
      this.data.lossCount += 1;
    }
    this.data.realizedNetPnlTotal += trade.netPnl;
    this.data.styleParams = updatedStyle;
    this.data.system1Weights = updatedWeights;
    this.save();
  }

  public getIncomeLedger(): PersistedIncomeLedger {
    return this.data.incomeLedger;
  }

  public updateIncomeLedger(patch: Partial<PersistedIncomeLedger>) {
    this.data.incomeLedger = { ...this.data.incomeLedger, ...patch };
    this.save();
  }

  public getClosedTradeHistory(): ClosedTradeRecord[] {
    return this.data.closedTrades;
  }

  public getLessons(): TradeLesson[] {
    return this.data.lessons;
  }

  public recordLesson(lesson: TradeLesson) {
    this.data.lessons = prependLesson(this.data.lessons, lesson);
    this.save();
  }

  public getStatsSummary() {
    const total = this.data.winCount + this.data.lossCount;
    return {
      closedTrades: this.data.closedTrades.slice(0, 40),
      styleMutations: this.data.styleMutations.slice(0, 30),
      winCount: this.data.winCount,
      lossCount: this.data.lossCount,
      winRatePct: total > 0 ? (this.data.winCount / total) * 100 : 0,
      realizedNetPnlTotal: this.data.realizedNetPnlTotal,
    };
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AdaptiveStyleParams,
  ClosedTradeRecord,
  EntryFeatureVector,
  LocalDecisionConfig,
  OperatorDirective,
  OperatorNote,
  StyleMutationRecord,
  System1Weights,
  TradeLesson,
} from '../types.js';
import { createDefaultStyleParams } from '../ai/agentClubGraph.js';
import { createDefaultSystem1Weights } from '../ai/system1Primitives.js';
import { prependLesson } from '../ai/lessonMemory.js';
import { decryptSecret, encryptSecret } from '../utils/cryptoVault.js';
import { f6 } from '../utils/format.js';
import { logger } from '../utils/logger.js';

export interface PersistedPositionMeta {
  symbol: string;
  openedAt: number;
  trailingActive: boolean;
  peakRoiPct: number;
  worstRoiPct: number;
  entryProtectiveStopRoiPct?: number;
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
  operatorDirectives: OperatorDirective[];
  operatorNotes: OperatorNote[];
}

export class StateStore {
  private readonly filePath = path.resolve(process.cwd(), 'data', 'hft_vault.json');
  private data: RawVaultData;
  private pendingWrite: NodeJS.Timeout | null = null;
  private saveFailures = 0;
  private dataWritten = false;
  private needsMigrationSave = false;
  private needsRecoverySave = false;
  private ledgerVersion = 0;

  constructor() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = this.loadFromDisk();
    // Persist a repair immediately so it runs once, and a crash cannot replay it forever.
    if (this.needsMigrationSave || this.needsRecoverySave) this.save();
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
      operatorDirectives: [],
      operatorNotes: [],
    };
  }

  private loadFromDisk(): RawVaultData {
    const def = this.defaultData();
    if (!fs.existsSync(this.filePath)) return def;

    // The vault holds the API keys for a live account. A truncated or half-written file must
    // never resolve to "no credentials" and then be saved back over the real ones, so a parse
    // failure falls through to the last good backup and quarantines the damaged file instead.
    const candidates = [this.filePath, `${this.filePath}.bak`];
    for (const [index, file] of candidates.entries()) {
      let parsed: Partial<RawVaultData>;
      try {
        if (!fs.existsSync(file)) continue;
        parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RawVaultData>;
      } catch (err) {
        if (index === 0) {
          this.quarantineCorrupt(file);
          logger.error(
            'STATE',
            `⚠️ ${path.basename(file)} is unreadable (${(err as Error).message}). Quarantined it and trying the backup — credentials were NOT reset.`
          );
        }
        continue;
      }
      if (index === 1) {
        logger.warn(
          'STATE',
          'Recovered state from hft_vault.json.bak after the primary vault failed to parse.'
        );
        // Write the recovered copy straight back. Leaving the primary missing would hand the
        // next boot an empty vault — the keys would survive only in a file nobody reads.
        this.needsRecoverySave = true;
      }
      const merged: RawVaultData = {
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
        closedTrades: Array.isArray(parsed.closedTrades) ? parsed.closedTrades : [],
        styleMutations: Array.isArray(parsed.styleMutations) ? parsed.styleMutations : [],
        lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
        operatorDirectives: Array.isArray(parsed.operatorDirectives)
          ? parsed.operatorDirectives
          : [],
        operatorNotes: Array.isArray(parsed.operatorNotes) ? parsed.operatorNotes : [],
      };
      this.migrateRetiredDefaults(merged);
      return merged;
    }
    return def;
  }

  private quarantineCorrupt(file: string): void {
    try {
      const dest = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, dest);
      logger.error('STATE', `Damaged vault kept for inspection as ${path.basename(dest)}.`);
    } catch {
      // If even the rename fails, the next save() will overwrite; nothing else to try.
    }
  }

  /**
   * One-time repair of parameters whose shipped default was retired because it was wrong
   * money-wise. The old protective guard sat at -9.5% ROI, which on a 10x book is a 0.95%
   * price move — wider than most of the 15s structures this bot trades, so it was never a
   * stop, only a liquidation race. A value the council or the operator moved to anything
   * else is left alone.
   */
  private migrateRetiredDefaults(data: RawVaultData): void {
    const retiredGuard = -9.5;
    if (data.styleParams.protectiveStopRoiPct === retiredGuard) {
      data.styleParams.protectiveStopRoiPct = createDefaultStyleParams().protectiveStopRoiPct;
      this.needsMigrationSave = true;
      logger.warn(
        'STATE',
        `Migrated the stored protective guard from ${f6(
          retiredGuard
        )}% to ${f6(
          data.styleParams.protectiveStopRoiPct
        )}% ROI and armed an exchange-side STOP_MARKET to match.`
      );
    }
  }

  public save() {
    // A concurrent writer would otherwise race on a shared temp name and rename half of
    // someone else's payload over the vault.
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const json = JSON.stringify(this.data, null, 2);
      fs.writeFileSync(tmpPath, json, 'utf8');
      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
      }
      fs.renameSync(tmpPath, this.filePath);
      if (this.pendingWrite) {
        clearTimeout(this.pendingWrite);
        this.pendingWrite = null;
      }
      this.dataWritten = true;
    } catch (err) {
      this.saveFailures += 1;
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best effort
      }
      logger.error(
        'STATE',
        `❌ Vault write FAILED (${(err as Error).message}). State kept in memory only — attempt #${
          this.saveFailures
        }. Trades, lessons and credentials are NOT durable until this clears.`
      );
    }
  }

  /** Coalesces the 1 Hz position bookkeeping into one disk write per window. */
  private scheduleSave(delayMs = 1500): void {
    if (this.pendingWrite) return;
    this.pendingWrite = setTimeout(() => {
      this.pendingWrite = null;
      this.save();
    }, delayMs);
    this.pendingWrite.unref?.();
  }

  /** Flush a debounced window immediately — call before anything reads the file or exits. */
  public flushNow(): void {
    if (!this.pendingWrite) return;
    clearTimeout(this.pendingWrite);
    this.pendingWrite = null;
    this.save();
  }

  public getSaveFailures(): number {
    return this.saveFailures;
  }

  public hasWrittenSinceLoad(): boolean {
    return this.dataWritten;
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

  public getOperatorDirectives(): OperatorDirective[] {
    return this.data.operatorDirectives;
  }

  public addOperatorDirective(input: {
    kind: OperatorDirective['kind'];
    symbol?: string;
    value?: number;
    reason?: string;
  }): OperatorDirective {
    const directive: OperatorDirective = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      kind: input.kind,
      symbol: input.symbol?.toUpperCase(),
      value: input.value,
      reason: (input.reason || '').trim().slice(0, 240),
      active: true,
      appliedCount: 0,
      lastAppliedAt: null,
    };
    this.data.operatorDirectives = [directive, ...this.data.operatorDirectives];
    this.save();
    return directive;
  }

  /** Revoking keeps the record so the operator can see what the club was told earlier. */
  public setOperatorDirectiveActive(id: string, active: boolean): boolean {
    const found = this.data.operatorDirectives.find((d) => d.id === id);
    if (!found) return false;
    found.active = active;
    this.save();
    return true;
  }

  public recordDirectiveApplied(id: string) {
    const found = this.data.operatorDirectives.find((d) => d.id === id);
    if (!found) return;
    found.appliedCount += 1;
    found.lastAppliedAt = Date.now();
    this.save();
  }

  public getOperatorNotes(): OperatorNote[] {
    return this.data.operatorNotes;
  }

  public addOperatorNote(text: string): OperatorNote {
    const note: OperatorNote = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      text: text.trim().slice(0, 600),
    };
    this.data.operatorNotes = [note, ...this.data.operatorNotes].slice(0, 20);
    this.save();
    return note;
  }

  public removeOperatorNote(id: string): boolean {
    const before = this.data.operatorNotes.length;
    this.data.operatorNotes = this.data.operatorNotes.filter((n) => n.id !== id);
    if (this.data.operatorNotes.length === before) return false;
    this.save();
    return true;
  }

  public getOpenPositionMeta(key: string): PersistedPositionMeta | undefined {
    return this.data.openPositionMeta[key];
  }

  public setOpenPositionMeta(key: string, meta: PersistedPositionMeta) {
    this.data.openPositionMeta[key] = meta;
    // Runs on the 1 Hz tick for every open position. Writing the whole vault once per second
    // put a synchronous disk write inside the exit-decision path; coalesce it instead.
    this.scheduleSave();
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
    this.ledgerVersion += 1;
    this.save();
  }

  public getIncomeLedger(): PersistedIncomeLedger {
    return this.data.incomeLedger;
  }

  public updateIncomeLedger(patch: Partial<PersistedIncomeLedger>) {
    this.data.incomeLedger = { ...this.data.incomeLedger, ...patch };
    this.ledgerVersion += 1;
    this.save();
  }

  /**
   * Bumped whenever settled-trade analytics change. The live stream carries these blocks only
   * to a client that has not yet seen the current version, so a dashboard polling once a
   * second does not re-download the whole trade history on every tick.
   */
  public getLedgerVersion(): number {
    return this.ledgerVersion;
  }

  public getClosedTradeHistory(): ClosedTradeRecord[] {
    return this.data.closedTrades;
  }

  public getLessons(): TradeLesson[] {
    return this.data.lessons;
  }

  public recordLesson(lesson: TradeLesson) {
    this.data.lessons = prependLesson(this.data.lessons, lesson);
    this.ledgerVersion += 1;
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

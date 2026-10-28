import type { IncomeLedgerSummary } from '../types.js';
import type { BinanceFuturesRestClient, UmIncomeRecord } from '../binance/restClient.js';
import type { PersistedIncomeLedger, StateStore } from './stateStore.js';
import { logger } from '../utils/logger.js';

const SYNC_INTERVAL_MS = 60_000;
const PAGE_LIMIT = 1000;
const MAX_PAGES_PER_SYNC = 6;
const SEEN_TRAN_ID_CAP = 3000;
const BACKFILL_WINDOW_MS = 7 * 24 * 3600_000;

/**
 * Pulls settled income from Binance Portfolio Margin (`/papi/v1/um/income`) so the
 * ledger can report what the exchange ACTUALLY charged and paid out, instead of the
 * engine's taker-rate estimate. Funding is the notable one: it accrues on every open
 * perpetual whether the bot is watching or not, and it is the only PNL component the
 * position monitor cannot know about.
 */
export class IncomeLedger {
  private inFlight = false;
  private lastAttemptAt = 0;

  constructor(
    private readonly restClient: BinanceFuturesRestClient,
    private readonly stateStore: StateStore
  ) {}

  public async sync(force = false): Promise<void> {
    const now = Date.now();
    if (this.inFlight) return;
    if (!force && now - this.lastAttemptAt < SYNC_INTERVAL_MS) return;
    if (!this.restClient.hasCredentials()) return;
    this.inFlight = true;
    this.lastAttemptAt = now;

    try {
      await this.runBackfillAndCatchUp();
    } catch (err) {
      const code = (err as { code?: number }).code;
      const status =
        code === -9999
          ? 'Skipped — Binance rate governor protected the weight budget'
          : `Binance income unavailable: ${(err as Error).message}`.slice(0, 160);
      this.stateStore.updateIncomeLedger({ available: false, status });
      logger.warn('BINANCE_API', `Income ledger sync failed — ${status}`);
    } finally {
      this.inFlight = false;
    }
  }

  private async runBackfillAndCatchUp() {
    const persisted = this.stateStore.getIncomeLedger();
    const anchorMs =
      persisted.sinceMs ||
      this.stateStore.getStartBalanceInfo().startBalanceLockedAt ||
      Date.now() - BACKFILL_WINDOW_MS;

    const seen = new Set(persisted.seenTranIds);
    let cursor = persisted.cursorMs || anchorMs;
    let funding = persisted.fundingFeeTotal;
    let commission = persisted.commissionTotal;
    let realized = persisted.realizedPnlTotal;
    let other = persisted.otherIncomeTotal;
    let count = persisted.recordCount;
    const fundingBySymbol = { ...persisted.fundingBySymbol };
    let progressed = false;

    for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const rows: UmIncomeRecord[] = await this.restClient.getUmIncome({
        startTime: cursor,
        endTime: Date.now(),
        limit: PAGE_LIMIT,
      });
      if (!rows || rows.length === 0) break;

      let newest = cursor;
      for (const r of rows) {
        if (r.time > newest) newest = r.time;
        if (seen.has(r.tranId)) continue;
        seen.add(r.tranId);

        const amount = parseFloat(r.income);
        if (!Number.isFinite(amount)) continue;
        progressed = true;
        count += 1;

        if (r.incomeType === 'FUNDING_FEE') {
          funding += amount;
          fundingBySymbol[r.symbol] = (fundingBySymbol[r.symbol] || 0) + amount;
        } else if (r.incomeType === 'COMMISSION') {
          commission += amount;
        } else if (r.incomeType === 'REALIZED_PNL') {
          realized += amount;
        } else {
          other += amount;
        }
      }

      // Advance past the newest timestamp; Binance is inclusive on startTime.
      cursor = newest + 1;
      if (rows.length < PAGE_LIMIT) break;
    }

    const tranIds = Array.from(seen);
    const trimmed = tranIds.length > SEEN_TRAN_ID_CAP
      ? tranIds.slice(tranIds.length - SEEN_TRAN_ID_CAP)
      : tranIds;

    const next: Partial<PersistedIncomeLedger> = {
      sinceMs: anchorMs,
      cursorMs: cursor,
      fundingFeeTotal: funding,
      commissionTotal: commission,
      realizedPnlTotal: realized,
      otherIncomeTotal: other,
      fundingBySymbol,
      recordCount: count,
      lastSyncAt: Date.now(),
      available: true,
      status: progressed
        ? `Settled income synced from /papi/v1/um/income`
        : this.stateStore.getIncomeLedger().status || 'Synced — no new settled income',
      seenTranIds: trimmed,
    };

    this.stateStore.updateIncomeLedger(next);
  }

  public getSummary(botSymbols: Set<string>): IncomeLedgerSummary {
    const p = this.stateStore.getIncomeLedger();
    let fundingBot = 0;
    for (const sym of botSymbols) fundingBot += p.fundingBySymbol[sym] || 0;

    return {
      available: p.available,
      status: p.status,
      lastSyncAt: p.lastSyncAt,
      sinceMs: p.sinceMs,
      fundingFeeTotal: fundingBot,
      fundingFeeAccountTotal: p.fundingFeeTotal,
      commissionTotal: p.commissionTotal,
      realizedPnlTotal: p.realizedPnlTotal,
      otherIncomeTotal: p.otherIncomeTotal,
      recordCount: p.recordCount,
    };
  }
}

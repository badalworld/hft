import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClosedTradeRecord } from '../server/types.js';
import type { BinanceFuturesRestClient } from '../server/binance/restClient.js';
import type { BinanceWsStreamManager } from '../server/binance/wsStreamManager.js';
import { CandleBuilder15s } from '../server/binance/candleBuilder15s.js';
import { evaluate15sPullbackStrategy } from '../server/engine/strategy15s.js';
import {
  AiAgentClubOrchestrator,
  createDefaultStyleParams,
} from '../server/ai/agentClubGraph.js';
import { buildTradeLesson } from '../server/ai/lessonMemory.js';
import { createDefaultSystem1Weights } from '../server/ai/system1Primitives.js';
import { MarketScanner40 } from '../server/engine/marketScanner.js';
import { buildPnlLedger } from '../server/engine/pnlLedger.js';
import { PositionMonitor1s } from '../server/engine/positionMonitor1s.js';
import { StateStore } from '../server/engine/stateStore.js';
import { f6, formatOrderQty } from '../server/utils/format.js';

async function runSelfTests() {
  const originalCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hft-test-'));
  process.chdir(tmpDir);

  try {
    console.log('1. Verifying 0.000000 formatting & Binance LOT_SIZE step precision...');
    assert.equal(f6(2), '2.000000');
    assert.equal(f6(123.45678912), '123.456789');
    assert.equal(formatOrderQty(0.14899, 0.001, 3), '0.148');
    assert.equal(formatOrderQty(22.9 / 0.008412, 1, 0), '2722');

    console.log('2. Verifying Start Balance Lock (locks on 1st connect, immutable until reset)...');
    const store = new StateStore();
    assert.equal(store.getStartBalanceInfo().startBalanceLocked, false);
    const locked1 = store.lockStartBalanceIfUnset(150.25);
    assert.equal(locked1, true);
    assert.equal(f6(store.getStartBalanceInfo().startBalance), '150.250000');

    // Second balance update must NOT change fixed Start Balance
    const locked2 = store.lockStartBalanceIfUnset(210.88);
    assert.equal(locked2, false);
    assert.equal(f6(store.getStartBalanceInfo().startBalance), '150.250000');

    // Explicit manual reset updates fixed Start Balance
    store.resetStartBalance(210.88);
    assert.equal(f6(store.getStartBalanceInfo().startBalance), '210.880000');

    console.log('3. Verifying 15-Second Candle Builder & Pullback + Confirmation Strategy...');
    const cb = new CandleBuilder15s();
    const baseTs = 1_730_000_010_000; // aligned into 15s buckets
    // Construct 5 bars of uptrend + pullback + strong bullish confirmation with buyer delta
    const barsSpec = [
      { bucket: 0, o: 10.0, h: 10.08, l: 9.99, c: 10.06, buyQ: 500, sellQ: 200 },
      { bucket: 1, o: 10.06, h: 10.15, l: 10.05, c: 10.14, buyQ: 600, sellQ: 200 },
      { bucket: 2, o: 10.14, h: 10.22, l: 10.13, c: 10.20, buyQ: 650, sellQ: 250 },
      // Bar 3: Pullback dip from 10.22 down to 10.11
      { bucket: 3, o: 10.20, h: 10.20, l: 10.11, c: 10.12, buyQ: 200, sellQ: 450 },
      // Bar 4: Bullish confirmation bar reclaiming structure with strong aggressive buyer delta
      { bucket: 4, o: 10.12, h: 10.19, l: 10.11, c: 10.18, buyQ: 900, sellQ: 250 },
      // Touch bucket 5 to close Bar 4
      { bucket: 5, o: 10.18, h: 10.18, l: 10.18, c: 10.18, buyQ: 10, sellQ: 5 },
    ];

    for (const b of barsSpec) {
      const t0 = baseTs + b.bucket * 15_000;
      cb.ingestAggTrade('TESTUSDT', b.o, b.buyQ * 0.25, t0 + 100, false, false);
      cb.ingestAggTrade('TESTUSDT', b.h, b.buyQ * 0.25, t0 + 2000, false, false);
      cb.ingestAggTrade('TESTUSDT', b.l, b.sellQ, t0 + 5000, true, false);
      cb.ingestAggTrade('TESTUSDT', b.c, b.buyQ * 0.5, t0 + 12000, false, false);
    }

    const snap = cb.getTechnicalSnapshot('TESTUSDT', 'LONG');
    assert.ok(snap.candleCount >= 5, `Expected >=5 closed 15s bars, got ${snap.candleCount}`);

    const style = createDefaultStyleParams();
    const stratEval = evaluate15sPullbackStrategy({
      side: 'LONG',
      absChange24hPct: 18.5,
      snap,
      style,
      inPosition: false,
      inCooldown: false,
    });
    assert.equal(stratEval.stage, 'CONFIRMED_SIGNAL');
    assert.equal(stratEval.triggered, true);

    console.log('4. Verifying LangGraph 5-Agent Club Entry Gate & Post-Mortem Self-Learning...');
    const club = new AiAgentClubOrchestrator({
      styleParams: style,
      system1Weights: createDefaultSystem1Weights(),
      localConfig: {
        provider: 'builtin',
        endpointUrl: 'http://127.0.0.1:11434',
        modelName: 'nimble',
        lastLatencyMs: 0,
        lastStatus: 'Ready',
      },
    });

    const entryDecision = await club.evaluateEntryCandidate({
      symbol: 'TESTUSDT',
      side: 'LONG',
      features: stratEval.features,
      minNotional: 5,
    });
    assert.equal(entryDecision.approved, true);
    assert.ok(entryDecision.confidence >= style.minAiConfidenceScore);

    // Simulate a Premature Pullback Loss and verify AI Club evolves trading style parameters
    const beforeDeltaMin = club.getStyleParams().minOrderflowDeltaRatio;
    const pmLoss = await club.runTradePostMortem({
      symbol: 'TESTUSDT',
      side: 'LONG',
      netPnl: -0.22,
      grossPnl: -0.20,
      binanceFees: 0.02,
      finalRoiPct: -10.0,
      peakRoiPct: 0.8,
      worstRoiPct: -10.2,
      durationSec: 42,
      exitReason: 'PROTECTIVE_STOP_LOSS',
      features: { ...stratEval.features, aiConfidence: entryDecision.confidence },
    });
    assert.equal(pmLoss.analysis.verdict, 'LOSS_PREMATURE_PULLBACK');
    assert.ok(club.getStyleParams().minOrderflowDeltaRatio > beforeDeltaMin);
    assert.equal(club.getSystem1Weights().totalUpdates, 1);

    console.log('5. Verifying 1-Second Position Monitor, Fees, Net PNL & >=5% ROI Trailing Stop...');
    const monitor = new PositionMonitor1s(store);
    // Open 10x LONG on $2.00 margin: qty=2, entry=10.00 -> notional=$20, initialMargin=$2.00
    // Mark rises to 10.06 -> grossPnl = +$0.12 -> ROI = +6.000000% (>= 5.000000%!) -> Trailing Stop Arms!
    const step1 = monitor.syncFromBinanceRisks(
      [
        {
          symbol: 'SOLUSDT',
          positionAmt: 2,
          entryPrice: 10.0,
          markPrice: 10.06,
          unRealizedProfit: 0.12,
          liquidationPrice: 9.1,
          leverage: 10,
          marginType: 'cross',
          isolatedMargin: 0,
          positionSide: 'BOTH',
          notional: 20.12,
          initialMargin: 2.0,
          updateTime: Date.now(),
        },
      ],
      () => 10.06,
      () => 0.0005,
      style
    );
    assert.equal(step1.exitsToExecute.length, 0);
    const activePos = monitor.getOpenPositionsList()[0];
    assert.equal(activePos.trailingActive, true);
    assert.equal(f6(activePos.roiPct), '6.000000');
    assert.equal(f6(activePos.grossPnl), '0.120000');
    // Entry fee = 20 * 0.0005 = 0.01; Exit fee = 20.12 * 0.0005 = 0.01006 -> Total fee = 0.020060
    assert.equal(f6(activePos.binanceFees), '0.020060');
    assert.equal(f6(activePos.netPnl), '0.099940');

    // Next 1s tick: mark retraces to 10.085 after peaking at 10.10 (+10% ROI -> trail ~8.85% -> retrace to +4.25% fires exit!)
    monitor.tickRealtimePrices(() => 10.10, style); // Peak +10.000000% ROI
    const exits = monitor.tickRealtimePrices(() => 10.08, style); // +8.000000% ROI <= trail ~8.85%
    assert.equal(exits.length, 1);
    assert.ok(exits[0].reason.includes('TRAILING_STOP_HIT'));

    console.log('6. Verifying Improvement Council ballots, lesson memory & shared-memory veto...');
    assert.ok(pmLoss.analysis.councilBallots && pmLoss.analysis.councilBallots.length > 0);
    const approvedBallots = (pmLoss.analysis.councilBallots || []).filter((b) => b.approved);
    // Only consensus-approved proposals may reach the live parameter set.
    assert.equal(approvedBallots.length, pmLoss.analysis.styleAdjustments.length);
    for (const m of approvedBallots) {
      assert.ok(m.forCount >= 2, `${m.change} applied without a quorum`);
      assert.equal(m.votes.length, 3, `${m.change} was not voted by three seats`);
    }
    assert.ok(pmLoss.analysis.agentConsensusSummary.includes('APPROVED'));
    assert.ok(pmLoss.analysis.nextStep!.includes('LONG'));
    assert.equal(club.getLessons().length, 1);

    // Four losing closes of the SAME setup must make the club poorer that setup's
    // probability by 0.06 — shared memory actually moving the entry gate.
    const memoryClub = new AiAgentClubOrchestrator({
      styleParams: createDefaultStyleParams(),
      system1Weights: createDefaultSystem1Weights(),
      localConfig: {
        provider: 'builtin',
        endpointUrl: 'http://127.0.0.1:11434',
        modelName: 'nimble',
        lastLatencyMs: 0,
        lastStatus: 'Ready',
      },
    });
    const plainDecision = await memoryClub.evaluateEntryCandidate({
      symbol: 'MEMOUSDT',
      side: 'LONG',
      features: stratEval.features,
      minNotional: 5,
    });
    const lessonSeed = {
      closedAt: Date.now(),
      symbol: 'MEMOUSDT',
      side: 'LONG' as const,
      netPnl: -0.3,
      entryFeatures: stratEval.features,
    };
    const losingAnalysis = {
      verdict: 'LOSS_PREMATURE_PULLBACK' as const,
      whatWorkedBest: 'x',
      whatWeMissed: 'Entry fired before the pullback exhausted.',
      styleAdjustments: [],
      mfeCaptureRatio: 0,
      brierLoss: 0.5,
      agentConsensusSummary: 'no changes',
    };
    for (let i = 0; i < 4; i++) {
      memoryClub.absorbLesson(buildTradeLesson(lessonSeed, losingAnalysis));
    }
    const recalled = await memoryClub.evaluateEntryCandidate({
      symbol: 'MEMOUSDT',
      side: 'LONG',
      features: stratEval.features,
      minNotional: 5,
    });
    assert.ok(recalled.lessonGuidance.includes('HISTORICAL BLEED'));
    assert.ok(
      Math.abs(recalled.confidence - (plainDecision.confidence - 0.06)) < 1e-9,
      `memory did not discount the probability: ${plainDecision.confidence} -> ${recalled.confidence}`
    );

    console.log('7. Verifying cooldown swaps the scanner basket and PNL ledger maths...');
    const universe = Array.from({ length: 22 }, (_, i) => `S${String(i).padStart(2, '0')}USDT`);
    const stubRest = {
      getAllTradableSymbols: () => new Set(universe),
      getSymbolFilter: () => null,
      getRecentAggTrades: async () => [],
    } as unknown as BinanceFuturesRestClient;
    const stubWs = {
      getLastPrice: () => 1,
      getMarkPrice: () => 0,
    } as unknown as BinanceWsStreamManager;
    const stubCandles = {
      getTechnicalSnapshot: () => ({
        candleCount: 10,
        rsi7: 44,
        ema9: 1,
        ema21: 1,
        pullbackDepthPct: 0.3,
        orderflowDeltaRatio: 1.3,
      }),
      warmupFromHistoricalAggTrades: () => {},
    } as unknown as CandleBuilder15s;
    const scan = new MarketScanner40(stubRest, stubWs, stubCandles);
    scan.ingestTickerBatch(
      universe.map((symbol, i) => ({
        symbol,
        priceChangePercent: 100 - i,
        lastPrice: 1,
        highPrice: 1,
        lowPrice: 1,
        quoteVolume: 9_000_000,
      }))
    );
    const coolMap = new Map<string, number>([['S00USDT', Date.now() + 120_000]]);
    const scanParams = {
      style: createDefaultStyleParams(),
      openPositionSymbols: new Set<string>(),
      cooldownUntilMap: coolMap,
      scannerPausedForMargin: false,
    };
    const basket1 = scan.refreshTop40Universe(scanParams);
    const longs1 = basket1.positive.map((a) => a.symbol);
    assert.equal(basket1.positive.length, 20, 'basket shrank instead of backfilling');
    assert.ok(!longs1.includes('S00USDT'), 'cooling symbol stayed in the scan list');
    assert.equal(longs1[0], 'S01USDT');
    const lastEntry = basket1.positive[19];
    assert.equal(lastEntry.symbol, 'S20USDT', 'next-ranked mover did not backfill the freed slot');
    assert.equal(lastEntry.substitutedFor, 'S00USDT');
    assert.equal(lastEntry.cooldownUntil, 0);

    // Cooldown expiring must pull the symbol straight back into rank 1 and drop S20USDT.
    coolMap.delete('S00USDT');
    const longs2 = scan.refreshTop40Universe(scanParams).positive.map((a) => a.symbol);
    assert.ok(longs2.includes('S00USDT'), 'recovered symbol did not return to the scan list');
    assert.ok(!longs2.includes('S20USDT'), 'substitute was not displaced when the slot reopened');

    const mk = (
      sym: string,
      side: 'LONG' | 'SHORT',
      net: number,
      gross: number,
      fees: number,
      closedAt: number
    ): ClosedTradeRecord => ({
      id: `${sym}-${closedAt}`,
      symbol: sym,
      side,
      leverage: 10,
      quantity: 1,
      entryPrice: 1,
      exitPrice: 1,
      initialMargin: 2,
      grossPnl: gross,
      binanceFees: fees,
      netPnl: net,
      finalRoiPct: 1,
      peakRoiPct: 2,
      worstRoiPct: -1,
      openedAt: closedAt - 30_000,
      closedAt,
      durationSec: 30,
      exitReason: 'TRAILING_STOP_HIT',
      entryFeatures: stratEval.features,
      postMortem: losingAnalysis,
    });
    const t0 = 1_700_000_000_000;
    const ledger = buildPnlLedger(
      [
        mk('AUSDT', 'LONG', 0.1, 0.12, 0.02, t0),
        mk('BUSDT', 'LONG', -0.05, -0.03, 0.02, t0 + 1000),
        mk('CUSDT', 'SHORT', 0.2, 0.22, 0.02, t0 + 2000),
        mk('BUSDT', 'SHORT', -0.08, -0.06, 0.02, t0 + 3000),
      ],
      {
        available: true,
        status: 'synced',
        lastSyncAt: t0,
        sinceMs: t0,
        fundingFeeTotal: -0.014,
        fundingFeeAccountTotal: -0.02,
        commissionTotal: -0.08,
        realizedPnlTotal: 0.17,
        otherIncomeTotal: 0,
        recordCount: 12,
      }
    );
    assert.equal(ledger.stats.totalTrades, 4);
    assert.equal(ledger.stats.winTrades, 2);
    assert.equal(f6(ledger.stats.winRatePct), '50.000000');
    assert.equal(ledger.stats.longTrades, 2);
    assert.equal(ledger.stats.shortTrades, 2);
    assert.equal(ledger.stats.longWinTrades, 1);
    assert.equal(ledger.stats.shortWinTrades, 1);
    assert.equal(f6(ledger.stats.longWinRatePct), '50.000000');
    assert.equal(f6(ledger.stats.shortWinRatePct), '50.000000');
    assert.equal(f6(ledger.stats.totalBinanceFees), '0.080000');
    // Funding is the exchange-settled number, not the engine's taker estimate.
    assert.equal(f6(ledger.stats.totalFundingFees), '-0.014000');
    assert.equal(f6(ledger.stats.totalNetPnl + ledger.stats.totalFundingFees), '0.156000');
    assert.equal(ledger.points.length, 4);
    assert.equal(f6(ledger.points[0].cumulativeNet), '0.100000');
    assert.equal(f6(ledger.points[1].cumulativeNet), '0.050000');
    assert.equal(f6(ledger.points[3].cumulativeNet), '0.170000');
    assert.equal(f6(ledger.points[2].cumulativeSideNet), '0.200000');
    assert.equal(ledger.points[0].symbol, 'AUSDT', 'points must be oldest-close first');

    console.log('✅ ALL HFT QUANTITATIVE & EXECUTION ENGINE SELF-TESTS PASSED!');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runSelfTests().catch((err) => {
  console.error('Self-test failed:', err);
  process.exit(1);
});

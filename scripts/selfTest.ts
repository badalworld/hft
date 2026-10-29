import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AdaptiveStyleParams,
  ClosedTradeRecord,
  OperatorDirective,
  OperatorDirectiveKind,
  OrderBookSnapshot,
  OrderFlowSnapshot,
} from '../server/types.js';
import type { BinanceFuturesRestClient } from '../server/binance/restClient.js';
import type { BinanceWsStreamManager } from '../server/binance/wsStreamManager.js';
import { CandleBuilder15s } from '../server/binance/candleBuilder15s.js';
import { evaluate15sPullbackStrategy } from '../server/engine/strategy15s.js';
import {
  AiAgentClubOrchestrator,
  createDefaultStyleParams,
} from '../server/ai/agentClubGraph.js';
import { describeDirective, findVetoingDirective } from '../server/ai/operatorDirectives.js';
import {
  castBallots,
  type CouncilContext,
  type MutationProposal,
} from '../server/ai/improvementCouncil.js';
import { diagnoseLoss } from '../server/ai/lossAutopsy.js';
import { buildTradeLesson } from '../server/ai/lessonMemory.js';
import { createDefaultSystem1Weights } from '../server/ai/system1Primitives.js';
import { MarketScanner40 } from '../server/engine/marketScanner.js';
import { OrderBookTracker } from '../server/engine/orderBookTracker.js';
import { OrderFlowTracker } from '../server/engine/orderFlowTracker.js';
import { evaluateOrderFlow } from '../server/engine/orderFlowStrategy.js';
import { buildPnlLedger } from '../server/engine/pnlLedger.js';
import { PositionMonitor1s } from '../server/engine/positionMonitor1s.js';
import { StateStore } from '../server/engine/stateStore.js';
import { f6, formatOrderQty } from '../server/utils/format.js';
import {
  clearsFeeHurdle,
  expectedExcursionRoiPct,
  roundTripFeeHurdleRoiPct,
} from '../server/utils/feeHurdle.js';
import {
  isAmbiguousOrderFailure,
  isUnfilledOrderStatus,
  makeEntryClientOrderId,
} from '../server/utils/orderSafety.js';
import { decideStop, priceForRoi, roundStopPrice } from '../server/utils/stops.js';
import { sanitizeStyleParams } from '../server/utils/styleGuard.js';
import {
  checkDecisionEndpoint,
  LOCAL_DECISION_PROVIDERS,
  providerNeedsEndpoint,
} from '../server/utils/netGuard.js';
import { isValidIpv4 } from '../server/utils/ipDiscovery.js';
import { HEAVY_SNAPSHOT_KEYS, lightenSnapshot } from '../server/utils/streamFrame.js';

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

    console.log('3b. Verifying the round-trip fee hurdle gate...');
    // Fees charge notional, ROI measures margin, so the break-even hurdle is 2*taker*leverage.
    // At 10x / 0.05% that is +1.000000% ROI — a +0.6% spike is not a near miss, it is a loss.
    assert.equal(f6(roundTripFeeHurdleRoiPct(0.0005, 10)), '1.000000');
    assert.equal(f6(roundTripFeeHurdleRoiPct(0.0005, 15)), '1.500000');
    assert.equal(f6(expectedExcursionRoiPct(0.1, 10)), '1.000000');
    const thinMove = clearsFeeHurdle(0.1, 0.0005, 10, style.minFeeHurdleMultiple);
    assert.equal(thinMove.ok, false, 'a one-round-trip move must never clear a two-round-trip bar');
    assert.equal(f6(thinMove.ratio), '1.000000');
    const realMove = clearsFeeHurdle(0.3, 0.0005, 10, style.minFeeHurdleMultiple);
    assert.equal(realMove.ok, true);
    assert.equal(f6(realMove.ratio), '3.000000');
    // Leverage cancels: stepping the ladder upward never made a small move affordable, it
    // only raised the chance of being liquidated on the way to the same fee loss.
    assert.equal(
      f6(clearsFeeHurdle(0.3, 0.0005, 10, 2).ratio),
      f6(clearsFeeHurdle(0.3, 0.0005, 15, 2).ratio)
    );

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
      initialMargin: 2.0,
      leverage: 10,
      entryPrice: 10.0,
      exitPrice: 9.98,
      finalRoiPct: -10.0,
      peakRoiPct: 0.8,
      worstRoiPct: -10.2,
      durationSec: 42,
      exitReason: 'PROTECTIVE_STOP_LOSS',
      features: { ...stratEval.features, aiConfidence: entryDecision.confidence },
      entryGuardRoiPct: club.getStyleParams().protectiveStopRoiPct,
    });
    assert.equal(pmLoss.analysis.verdict, 'LOSS_PREMATURE_PULLBACK');
    assert.equal(pmLoss.analysis.autopsy?.rootCause, 'ENTRY_TOO_EARLY');
    assert.ok(pmLoss.analysis.autopsy?.avoidanceRule.includes('15s'));
    assert.ok(club.getStyleParams().minOrderflowDeltaRatio > beforeDeltaMin);
    assert.equal(club.getSystem1Weights().totalUpdates, 1);

    // The autopsy rule has to be recallable by the next trade in the same setup band,
    // otherwise the post-mortem is a report and not a change in behaviour.
    const recallAfterLoss = await club.evaluateEntryCandidate({
      symbol: 'TESTUSDT2',
      side: 'LONG',
      features: stratEval.features,
      minNotional: 5,
    });
    assert.ok(
      recallAfterLoss.lessonGuidance.includes('STANDING RULE'),
      'expected the loss autopsy rule to be recalled on the next entry in the band'
    );

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
    const peakTick = monitor.tickRealtimePrices(() => 10.10, style); // Peak +10.000000% ROI
    assert.equal(peakTick.exits.length, 0);
    const trailTick = monitor.tickRealtimePrices(() => 10.08, style); // +8.000000% ROI <= trail ~8.85%
    assert.equal(trailTick.exits.length, 1);
    assert.ok(trailTick.exits[0].reason.includes('TRAILING_STOP_HIT'));

    console.log('5b. Verifying the capital guard is live even after the trail arms...');
    // A crash to -40% ROI on an ARMED position must be labelled as the guard it actually
    // breached, not as a profit trail — the loss autopsy classifies on this string.
    const crashTick = monitor.tickRealtimePrices(() => 9.6, style);
    assert.equal(crashTick.exits.length, 1);
    assert.ok(crashTick.exits[0].reason.includes('PROTECTIVE_STOP_LOSS'));
    assert.ok(!crashTick.exits[0].reason.includes('TRAILING'));

    // Guard precedence math, independent of the monitor:
    const armedBelowGuard = decideStop(-12, true, -0.5, style.protectiveStopRoiPct);
    assert.equal(armedBelowGuard.triggered, true);
    assert.equal(armedBelowGuard.kind, 'GUARD');
    assert.equal(armedBelowGuard.levelRoiPct, -0.5);
    // The hole that used to leave a position with no exit: armed, but no trail level.
    const armedNoTrailLevel = decideStop(-12, true, null, style.protectiveStopRoiPct);
    assert.equal(armedNoTrailLevel.triggered, true);
    assert.equal(armedNoTrailLevel.kind, 'GUARD');
    const stillRunning = decideStop(9.5, true, 8.85, style.protectiveStopRoiPct);
    assert.equal(stillRunning.triggered, false);
    const armedTrailHit = decideStop(8, true, 8.85, style.protectiveStopRoiPct);
    assert.equal(armedTrailHit.triggered, true);
    assert.equal(armedTrailHit.kind, 'TRAIL');
    const guardHitUnarmed = decideStop(-7, false, null, style.protectiveStopRoiPct);
    assert.equal(guardHitUnarmed.triggered, true);
    assert.equal(guardHitUnarmed.kind, 'GUARD');

    // ROI -> trigger price must invert exactly, and tick-rounding must never cross the mark.
    const longTrigger = priceForRoi('LONG', 10.0, 2.0, 2, -6.0);
    assert.equal(f6(longTrigger), '9.940000');
    assert.equal(f6(priceForRoi('SHORT', 10.0, 2.0, 2, -6.0)), '10.060000');
    assert.equal(roundStopPrice(9.9437, 0.001, 3, 'LONG'), '9.943');
    assert.equal(roundStopPrice(10.0562, 0.001, 3, 'SHORT'), '10.057');

    console.log('5c. Verifying ladder retry safety and entry-guard attribution...');
    // A client order id is the only handle that can answer "did the POST that timed out fill?"
    // Binance caps it at 36 chars of [A-Za-z0-9_-], and the uniqueness lives in the tail, so a
    // long symbol must lose characters from its name and never from its timestamp.
    const cid = makeEntryClientOrderId('1000000BOBUSDT', 'LONG', 12);
    assert.ok(cid.length <= 36, `clientOrderId too long: ${cid.length}`);
    assert.ok(/^hft[A-Za-z0-9_-]+$/.test(cid), `bad charset: ${cid}`);
    assert.ok(cid.includes('-L12x-'), `leverage tag lost: ${cid}`);
    const longCid = makeEntryClientOrderId('1000000HOTUSDTABCDE', 'SHORT', 15);
    assert.equal(longCid.length, 36);
    assert.ok(/-[LS]\d+x-[0-9a-z]{6,8}$/.test(longCid), `timestamp tail lost: ${longCid}`);
    assert.notEqual(makeEntryClientOrderId('BTCUSDT', 'LONG', 10), makeEntryClientOrderId('BTCUSDT', 'SHORT', 10));

    assert.equal(isAmbiguousOrderFailure({ code: -1013 }), false, 'filter rejection must be safe to escalate');
    assert.equal(isAmbiguousOrderFailure({ code: -2019 }), false, 'margin rejection must be safe to escalate');
    assert.equal(isAmbiguousOrderFailure({ code: -9999 }), false, 'local governor never reached Binance');
    assert.equal(isAmbiguousOrderFailure({ code: -2010 }), true, 'unknown code must be resolved by query');
    assert.equal(isAmbiguousOrderFailure(new Error('socket hang up')), true, 'timeout must never blind-retry');

    assert.equal(isUnfilledOrderStatus('FILLED'), false);
    assert.equal(isUnfilledOrderStatus('PARTIALLY_FILLED'), false);
    assert.equal(isUnfilledOrderStatus('EXPIRED'), true);
    assert.equal(isUnfilledOrderStatus('REJECTED'), true);
    assert.equal(isUnfilledOrderStatus(''), true);

    // The same -12% fill is a depth failure under a -6% guard and an entry failure under the
    // -9.5% guard that was live when the trade was booked. Judging old exits on new levels
    // invents slippage that never happened, so the autopsy must use the entry-time guard.
    const slipFill = {
      symbol: 'SLIPUSDT',
      side: 'LONG' as const,
      netPnl: -0.24,
      grossPnl: -0.24,
      binanceFees: 0.02,
      initialMargin: 2.0,
      leverage: 10,
      entryPrice: 10.0,
      exitPrice: 9.88,
      finalRoiPct: -12.0,
      peakRoiPct: 0.4,
      worstRoiPct: -12.0,
      durationSec: 18,
      exitReason: 'PROTECTIVE_STOP_LOSS (ROI -12.000000% <= Guard -6.000000%)',
      features: stratEval.features,
      params: style,
    };
    assert.equal(
      diagnoseLoss({ ...slipFill, entryGuardRoiPct: -6.0 }).rootCause,
      'EXIT_SLIPPAGE',
      'a real hole through the live guard must be called slippage'
    );
    assert.equal(
      diagnoseLoss({ ...slipFill, entryGuardRoiPct: -9.5 }).rootCause,
      'ENTRY_TOO_EARLY',
      'a 2.5% ROI overshoot is 0.25% of price at 10x — that is the entry, not the book'
    );

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

    console.log('6b. Verifying the council can actually approve a risk reduction...');
    // Three traps used to freeze the riskest levers in the book: the guard lives on a
    // negative scale (so -9.5 -> -6.0 was scored as a LOOSENING and refused), maxLeverage
    // had no step cap and no verdict ever listed it, and the capital seat vetoed the word
    // "maxLeverage" regardless of which way the number moved.
    const councilParams: AdaptiveStyleParams = {
      ...createDefaultStyleParams(),
      protectiveStopRoiPct: -9.5,
      maxLeverage: 15,
    };
    const slippageCtx: CouncilContext = {
      params: councilParams,
      verdict: 'LOSS_MOMENTUM_REVERSAL',
      side: 'LONG',
      patterns: [],
      lessonKey: 'L',
      recentLessons: [],
      rootCause: 'EXIT_SLIPPAGE',
    };
    const ballotFor = (prop: MutationProposal) =>
      castBallots([prop], slippageCtx)[0];
    const levCut = ballotFor({
      param: 'maxLeverage',
      target: 14,
      min: 5,
      max: 15,
      reason: 'stop filled through the guard',
    });
    assert.equal(levCut.approved, true, `leverage cut denied: ${JSON.stringify(levCut.votes)}`);
    assert.equal(levCut.forCount, 3);
    const guardTighten = ballotFor({
      param: 'protectiveStopRoiPct',
      target: -8.0,
      min: -12,
      max: -3,
      reason: 'halve the loss tail',
    });
    assert.equal(guardTighten.approved, true, `guard tightening denied: ${JSON.stringify(guardTighten.votes)}`);
    // Widening the same guard is a genuine risk increase and must stay blocked without history.
    assert.equal(
      ballotFor({ param: 'protectiveStopRoiPct', target: -12.0, min: -12, max: -3, reason: 'give it room' })
        .approved,
      false,
      'loosening the capital guard passed with no earned history'
    );
    // A reckless step is refused even when the direction is right — the council moves in stages.
    const guardLeap = ballotFor({
      param: 'protectiveStopRoiPct',
      target: -6.0,
      min: -12,
      max: -3,
      reason: 'jump three points at once',
    });
    assert.equal(guardLeap.approved, false, 'a 3.5-point guard leap passed the owner step cap');
    // Doubling the size of every trade is the one thing a losing post-mortem may not do.
    assert.equal(
      ballotFor({ param: 'baseMarginUsd', target: 4.0, min: 1, max: 5, reason: 'make it back faster' })
        .approved,
      false,
      'the capital seat allowed a size increase'
    );
    const hermesOn = (ctx: CouncilContext) =>
      castBallots(
        [{ param: 'maxLeverage', target: 14, min: 5, max: 15, reason: 'fee hurdle is the loss' }],
        ctx
      )[0].votes.find((v) => v.agent === 'hermes-evolver');
    assert.equal(hermesOn(slippageCtx)?.vote, 'FOR', 'autopsy cause did not justify its own lever');
    assert.equal(
      hermesOn({ ...slippageCtx, rootCause: undefined })?.vote,
      'AGAINST',
      'a verdict that does not blame sizing let a maxLeverage rewrite pass its coherence seat'
    );
    // Hermes owns the trailing family and also always occupies a panel seat. Building the
    // panel as a set of [owner, hermes, peer] collapsed it to two seats for exactly those
    // money parameters, turning "two of three" into "two of two" with no independent judge.
    for (const param of [
      'trailingTriggerRoiPct',
      'trailingFloorRoiPct',
      'trailingCallbackRoiPct',
    ] as const) {
      const b = ballotFor({
        param,
        target: councilParams[param] + 0.05,
        min: -10,
        max: 20,
        reason: 'profit floor is giving back captured gains',
      });
      assert.equal(b.votes.length, 3, `${param} ballot did not seat three agents`);
      assert.equal(
        new Set(b.votes.map((v) => v.agent)).size,
        3,
        `${param} ballot seated the same agent twice`
      );
    }

    // The order-flow thresholds are governed by the same council. OBI moves in 0.02
    // stages, and the absorption multiple is inverted: demanding a bigger aggression
    // multiple before calling a book absorbed means *fewer* blocks, i.e. looser.
    const flowCtx: CouncilContext = { ...slippageCtx, rootCause: 'ADVERSE_TAKER_FLOW' };
    const flowBallot = (
      param: keyof AdaptiveStyleParams,
      target: number,
      min: number,
      max: number
    ) =>
      castBallots([{ param, target, min, max, reason: 'tape leaned against the entry' }], flowCtx)[0];
    assert.equal(
      flowBallot('orderFlowMinObi', 0.22, 0.05, 0.6).approved,
      true,
      'a one-step OBI tightening was refused'
    );
    assert.equal(
      flowBallot('orderFlowMinObi', 0.5, 0.05, 0.6).approved,
      false,
      'the OBI step cap did not hold'
    );
    assert.equal(
      flowBallot('orderFlowAbsorptionMultiple', 1.7, 1.1, 4).approved,
      false,
      'raising the absorption multiple was scored as a tightening'
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

    console.log('8. Verifying operator standing orders veto entries while briefings stay advisory...');
    const candidateFor = (
      symbol: string,
      side: 'LONG' | 'SHORT',
      openPositionCount: number
    ) => ({ symbol, side, features: stratEval.features, openPositionCount });

    const rsiGate = store.addOperatorDirective({
      kind: 'RSI_GATE',
      value: stratEval.features.rsi15s - 0.5,
      reason: 'dip has not reset',
    });
    assert.equal(rsiGate.active, true);
    assert.equal(rsiGate.appliedCount, 0);
    assert.ok(describeDirective(rsiGate).includes('LONG needs RSI <='));

    // The club approved this exact setup in step 4; a standing order still stops it.
    const vetoed = findVetoingDirective(store.getOperatorDirectives(), candidateFor('TESTUSDT', 'LONG', 0));
    assert.equal(vetoed?.id, rsiGate.id, 'RSI gate did not veto an otherwise-approved LONG');
    store.recordDirectiveApplied(rsiGate.id);
    assert.equal(store.getOperatorDirectives()[0].appliedCount, 1);
    assert.ok(store.getOperatorDirectives()[0].lastAppliedAt);

    // SHORT is on the far side of the same gate, so the gate leaves it alone.
    assert.equal(
      findVetoingDirective(store.getOperatorDirectives(), candidateFor('TESTUSDT', 'SHORT', 0)),
      null
    );

    // A lifted rule must be invisible to the entry path, not merely grey in the UI.
    assert.equal(store.setOperatorDirectiveActive(rsiGate.id, false), true);
    assert.equal(
      findVetoingDirective(store.getOperatorDirectives(), candidateFor('TESTUSDT', 'LONG', 0)),
      null
    );

    const raw = (
      kind: OperatorDirectiveKind,
      extra: Partial<{ symbol: string; value: number; active: boolean }> = {}
    ): OperatorDirective => ({
      id: kind,
      createdAt: 0,
      kind,
      reason: '',
      active: true,
      appliedCount: 0,
      lastAppliedAt: null,
      ...extra,
    });

    const standDown = store.addOperatorDirective({ kind: 'STAND_DOWN_SYMBOL', symbol: 'testusdt' });
    // Symbol is normalised on the way in, and only that name is affected.
    assert.equal(standDown.symbol, 'TESTUSDT');
    assert.equal(findVetoingDirective([standDown], candidateFor('DOGEUSDT', 'LONG', 0)), null);
    assert.equal(findVetoingDirective([standDown], candidateFor('TESTUSDT', 'SHORT', 0))?.id, standDown.id);

    assert.equal(
      findVetoingDirective([raw('MAX_24H_OVEREXTENSION', { value: 12 })], candidateFor('XUSDT', 'LONG', 0))
        ?.kind,
      'MAX_24H_OVEREXTENSION',
      'a 18.5% 24h move slipped past the overextension cap'
    );
    assert.equal(
      findVetoingDirective([raw('MIN_24H_MOVE', { value: 25 })], candidateFor('XUSDT', 'LONG', 0))?.kind,
      'MIN_24H_MOVE',
      'a move too flat to clear fees was allowed'
    );
    assert.equal(
      findVetoingDirective(
        [raw('MAX_CONCURRENT_POSITIONS', { value: 2 })],
        candidateFor('XUSDT', 'LONG', 2)
      )?.kind,
      'MAX_CONCURRENT_POSITIONS'
    );
    assert.equal(
      findVetoingDirective(
        [raw('MAX_CONCURRENT_POSITIONS', { value: 2 })],
        candidateFor('XUSDT', 'LONG', 1)
      ),
      null
    );
    assert.equal(
      findVetoingDirective([raw('STAND_DOWN_ALL')], candidateFor('XUSDT', 'SHORT', 5))?.kind,
      'STAND_DOWN_ALL'
    );
    assert.equal(findVetoingDirective([raw('BLOCK_LONG')], candidateFor('XUSDT', 'SHORT', 0)), null);
    // First active match wins, and a lifted rule in front of it must be skipped.
    assert.equal(
      findVetoingDirective(
        [raw('BLOCK_LONG', { active: false }), raw('STAND_DOWN_ALL')],
        candidateFor('XUSDT', 'LONG', 0)
      )?.kind,
      'STAND_DOWN_ALL'
    );

    // Briefings are read by the agents but must not change the gate outcome.
    const note = store.addOperatorNote('BTC is bleeding into the US cash open — half size longs.');
    club.setOperatorNotes(store.getOperatorNotes());
    const briefedDecision = await club.evaluateEntryCandidate({
      symbol: 'TESTUSDT',
      side: 'LONG',
      features: stratEval.features,
      minNotional: 5,
    });
    assert.equal(briefedDecision.approved, true, 'a briefing vetoed an entry it should only inform');
    assert.ok(
      briefedDecision.reason.includes('OPERATOR BRIEFING'),
      `briefing was not quoted into the agents: ${briefedDecision.reason}`
    );
    assert.equal(store.removeOperatorNote(note.id), true);
    assert.equal(store.getOperatorNotes().length, 0);

    console.log('9. Verifying vault quarantine, guard migration and off-path persistence...');
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hft-vault-'));
    process.chdir(vaultDir);
    try {
      const vaultPath = path.resolve(vaultDir, 'data', 'hft_vault.json');
      const readVault = () => JSON.parse(fs.readFileSync(vaultPath, 'utf8'));

      const storeA = new StateStore();
      storeA.setCredentials('AK-1234567890', 'SK-abcdefghij');
      storeA.setStyleParams({ ...createDefaultStyleParams(), protectiveStopRoiPct: -9.5 });
      assert.equal(readVault().styleParams.protectiveStopRoiPct, -9.5);

      // The -9.5% guard is a retired default, not an operator decision: on a 10x book it is a
      // 0.95% price move, wider than most 15s structures, so it has to migrate or the
      // tightened stop never reaches the instance that is actually trading.
      const storeB = new StateStore();
      assert.equal(
        storeB.getStyleParams().protectiveStopRoiPct,
        -6.0,
        'stored -9.5% guard was not migrated to the new default'
      );
      assert.equal(storeB.getCredentials().apiKey, 'AK-1234567890', 'migration lost the vault keys');
      assert.equal(readVault().styleParams.protectiveStopRoiPct, -6.0, 'migration was not made durable');
      assert.equal(
        new StateStore().getStyleParams().protectiveStopRoiPct,
        -6.0,
        'migration replayed on a second boot'
      );

      // A level anybody chose deliberately must survive untouched.
      storeB.setStyleParams({ ...createDefaultStyleParams(), protectiveStopRoiPct: -7.25 });
      assert.equal(new StateStore().getStyleParams().protectiveStopRoiPct, -7.25);

      // Half-written vault (crash mid-save) must never resolve to "no credentials" and then
      // be written back over the real keys.
      fs.copyFileSync(vaultPath, `${vaultPath}.bak`);
      fs.writeFileSync(vaultPath, '{"encryptedApiKey": "trunc', 'utf8');
      const storeC = new StateStore();
      assert.equal(
        storeC.getCredentials().apiKey,
        'AK-1234567890',
        'a corrupt vault wiped the stored API keys'
      );
      assert.equal(storeC.getStyleParams().protectiveStopRoiPct, -7.25);
      const vaultFiles = fs.readdirSync(path.dirname(vaultPath));
      assert.equal(
        vaultFiles.filter((f) => f.includes('.corrupt-')).length,
        1,
        'damaged vault was destroyed instead of quarantined'
      );
      assert.equal(readVault().styleParams.protectiveStopRoiPct, -7.25, 'recovery was not rewritten');

      // The 1 Hz bookkeeping must not put a synchronous whole-vault write on the exit path.
      const storeD = new StateStore();
      storeD.setOpenPositionMeta('METAUSDT:BOTH', {
        symbol: 'METAUSDT',
        openedAt: 1,
        trailingActive: false,
        peakRoiPct: 0,
        worstRoiPct: 0,
        entryFeatures: stratEval.features,
      });
      assert.equal(
        readVault().openPositionMeta['METAUSDT:BOTH'],
        undefined,
        'a 1 Hz position tick wrote the vault synchronously'
      );
      storeD.flushNow();
      assert.ok(readVault().openPositionMeta['METAUSDT:BOTH'], 'flushNow did not persist the meta');
      storeD.removeOpenPositionMeta('METAUSDT:BOTH');
      assert.equal(readVault().openPositionMeta['METAUSDT:BOTH'], undefined);
      assert.equal(storeD.getSaveFailures(), 0);

      // The live stream resends the settled-trade blocks only to a client that has not seen the
      // current version, so every writer of that history has to bump it.
      const versionBefore = storeD.getLedgerVersion();
      storeD.recordClosedTrade(
        mk('VERUSDT', 'LONG', 0.1, 0.2, 0.1, t0),
        null,
        createDefaultStyleParams(),
        createDefaultSystem1Weights()
      );
      assert.equal(storeD.getLedgerVersion(), versionBefore + 1, 'a settled trade did not bump the ledger version');
      storeD.updateIncomeLedger({ fundingFeeTotal: 0.01 });
      assert.equal(storeD.getLedgerVersion(), versionBefore + 2, 'an income refresh did not bump the ledger version');
      storeD.setCredentials('AK-1234567890', 'SK-abcdefghij');
      assert.equal(storeD.getLedgerVersion(), versionBefore + 2, 'a light-only change bumped the ledger version');
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }

    console.log(
      '10. Verifying the settings-route guards (style-parameter bounds + decision-endpoint SSRF)...'
    );
    {
      const style = createDefaultStyleParams();
      const ok = sanitizeStyleParams(style, { protectiveStopRoiPct: -6, minFeeHurdleMultiple: 2.5 });
      assert.equal(ok.rejected.length, 0, `a safe change was refused: ${ok.rejected.join('; ')}`);
      assert.equal(ok.accepted.protectiveStopRoiPct, -6);

      // One field out of bounds must not poison the fields beside it, but a margin large
      // enough to consume the account never lands.
      const mixed = sanitizeStyleParams(style, { baseMarginUsd: 4000, cooldownSecondsAfterLoss: 45 });
      assert.equal(mixed.accepted.baseMarginUsd, undefined);
      assert.equal(mixed.accepted.cooldownSecondsAfterLoss, 45);
      assert.ok(mixed.rejected.some((r) => r.includes('baseMarginUsd')));

      // A positive guard would close every position the instant it fills.
      assert.equal(sanitizeStyleParams(style, { protectiveStopRoiPct: 2 }).accepted.protectiveStopRoiPct, undefined);
      for (const bad of [NaN, Infinity, 'abc', null, {}, [1]]) {
        const r = sanitizeStyleParams(style, { minAiConfidenceScore: bad as never });
        assert.equal(r.accepted.minAiConfidenceScore, undefined, `${String(bad)} reached the book`);
      }
      // The dashboard sends text inputs as strings; those are still numbers.
      assert.equal(sanitizeStyleParams(style, { minAiConfidenceScore: '0.62' }).accepted.minAiConfidenceScore, 0.62);

      // Keys that are not parameters must not be persisted into the vault and echoed back.
      const injected = sanitizeStyleParams(style, { apiKey: 'stolen', engineRunning: true });
      assert.equal(Object.keys(injected.accepted).length, 0);
      assert.equal(injected.rejected.length, 2);

      // Cross-parameter relationships use the live values, not just the request.
      const inverted = sanitizeStyleParams({ ...style, minLeverage: 8 }, { maxLeverage: 4 });
      assert.equal(inverted.accepted.maxLeverage, undefined);
      assert.equal(inverted.accepted.minLeverage, undefined);
      assert.equal(
        sanitizeStyleParams({ ...style, trailingTriggerRoiPct: 5 }, { trailingFloorRoiPct: 9 })
          .accepted.trailingFloorRoiPct,
        undefined,
        'a locked floor above the trigger would exit on open'
      );

      assert.equal(isValidIpv4('172.22.224.63'), true);
      assert.equal(isValidIpv4('999.1.1.1'), false);
      assert.equal(isValidIpv4('127.0.0.1:11434'), false);

      const endpoint = (u: string) => checkDecisionEndpoint(u);
      for (const good of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434', 'http://192.168.1.9:8080']) {
        assert.equal(endpoint(good).ok, true, `refused the local model server ${good}`);
      }
      // The whole point of the allowlist: this process is signed into a money API.
      for (const bad of [
        'http://169.254.169.254/latest/meta-data/',
        'http://metadata.google.internal/',
        'https://api.someone-else.com',
        'http://attacker@127.0.0.1',
        'http://127.0.0.1:11434/?probe=1',
        'file:///etc/passwd',
        '127.0.0.1:11434',
        '',
      ]) {
        assert.equal(endpoint(bad).ok, false, `accepted the endpoint "${bad}"`);
        assert.ok(endpoint(bad).reason.length > 0, `no reason given for "${bad}"`);
      }
      assert.equal(endpoint('http://127.0.0.1:11434/v1/').normalizedUrl, 'http://127.0.0.1:11434/v1/');
      assert.equal(providerNeedsEndpoint('builtin'), false);
      assert.equal(providerNeedsEndpoint('ollama_nimble'), true);
      assert.equal(LOCAL_DECISION_PROVIDERS.includes('gpt_http' as never), false);

      // A light frame must omit the settled-trade blocks entirely: the dashboard merges frames
      // over its own state, and an explicit undefined would blank the history on screen.
      const frame = lightenSnapshot({
        timestamp: 5,
        ledgerVersion: 3,
        currentEquity: 11.2,
        recentClosedTrades: [mk('LIGHTUSDT', 'LONG', 0.1, 0.2, 0.1, t0)],
        styleMutations: [],
        pnlLedger: { stats: {}, points: [], income: {} },
        lessons: [],
        lessonPatterns: [],
      } as never);
      const asRecord = frame as unknown as Record<string, unknown>;
      assert.equal(asRecord.timestamp, 5, 'lightening dropped live fields');
      assert.equal(asRecord.ledgerVersion, 3);
      for (const key of HEAVY_SNAPSHOT_KEYS) {
        assert.ok(!(key in asRecord), `light frame still carried ${key} as "${String(asRecord[key])}"`);
      }
      assert.equal(HEAVY_SNAPSHOT_KEYS.length, 5);
    }

    console.log('11. Verifying the order-flow layer (tape math, book imbalance, six-gate verdict)...');
    {
      // --- Tape: quote-denominated CVD, ratio, slope and aggression from real bucket math.
      const tape = new OrderFlowTracker();
      const tNow = Date.now();
      tape.ingest('TESTUSDT', 100, 1, tNow - 90_000, false); // $100 buy in the *previous* window
      tape.ingest('TESTUSDT', 100, 10, tNow - 15_000, false); // $1,000 aggressive buy
      tape.ingest('TESTUSDT', 100, 4, tNow - 14_000, true); // $400 aggressive sell
      const tapeSnap = tape.getSnapshot('TESTUSDT', 60);
      assert.ok(tapeSnap, 'the tracker dropped a populated tape');
      assert.equal(tapeSnap.samples, 2, 'the prior-window bucket leaked into the current samples');
      assert.equal(tapeSnap.buyUsd, 1000);
      assert.equal(tapeSnap.sellUsd, 400);
      assert.ok(Math.abs(tapeSnap.buySellRatio - 2.5) < 1e-6);
      assert.equal(tapeSnap.cvdUsd, 600);
      assert.equal(tapeSnap.cvdSlopeUsd, 600, 'both buckets are in the modern half, so the slope is the delta');
      assert.ok(
        Math.abs(tapeSnap.buyAggressionMultiple - 10) < 1e-6,
        'aggression must be measured against the previous window, not the current one'
      );

      // A late taker sell must flip both the delta and its slope — the fade the gate refuses.
      tape.ingest('TESTUSDT', 100, 10, tNow - 5_000, true);
      const flipped = tape.getSnapshot('TESTUSDT', 60);
      assert.ok(flipped);
      assert.equal(flipped.cvdUsd, -400);
      assert.equal(flipped.cvdSlopeUsd, -400);
      assert.equal(flipped.priceChangePct, 0);

      // --- Book: distance-weighted OBI over top-20, spread in bps, touch-refill baseline.
      const books = new OrderBookTracker();
      const bookTs = Date.now();
      books.ingest('TESTUSDT', [[100, 10], [99.9, 10]], [[100.1, 1], [100.2, 1]], bookTs);
      const heavyBid = books.getSnapshot('TESTUSDT');
      assert.ok(heavyBid, 'the book tracker dropped an ingested frame');
      assert.ok(heavyBid.obi > 0.8, `bid-heavy book read OBI ${heavyBid.obi}`);
      assert.ok(Math.abs(heavyBid.spreadBps - 10) < 0.1, `spread read ${heavyBid.spreadBps} bps`);
      assert.equal(heavyBid.bidRefillRatio, 1, 'the first frame must baseline its own refill ratio');

      books.ingest('MIRRORUSDT', [[100, 1], [99.9, 1]], [[100.1, 10], [100.2, 10]], bookTs);
      const heavyAsk = books.getSnapshot('MIRRORUSDT');
      assert.ok(heavyAsk && heavyAsk.obi < -0.8);
      // The 0.1 tick means the two books are only near-mirrors, hence the loose bound.
      assert.ok(Math.abs(heavyAsk.obi + heavyBid.obi) < 1e-2, 'OBI is not symmetric for a mirrored book');

      // Size returning to the touch against an unchanged ask is what "refilled" means.
      books.ingest('TESTUSDT', [[100, 20], [99.9, 20]], [[100.1, 1], [100.2, 1]], bookTs + 500);
      const refilled = books.getSnapshot('TESTUSDT');
      assert.ok(refilled);
      assert.ok(refilled.bidRefillRatio > 1.8, `refill read ${refilled.bidRefillRatio}`);
      assert.ok(Math.abs(refilled.askRefillRatio - 1) < 1e-9);

      // --- The gate itself.
      const flowParams = {
        orderFlowMinObi: 0.2,
        orderFlowMinVolumeRatio: 1.5,
        orderFlowAbsorptionMultiple: 1.6,
        minFeeHurdleMultiple: 2,
      };
      const bookSnap = (
        obi: number,
        spreadBps = 2,
        askRefillRatio = 1,
        bidRefillRatio = 1
      ): OrderBookSnapshot => ({
        symbol: 'TESTUSDT',
        bid: 100,
        ask: 100.02,
        mid: 100.01,
        spreadBps,
        obi,
        bidDepthUsd: 50_000,
        askDepthUsd: 50_000,
        bidTouchUsd: 10_000,
        askTouchUsd: 10_000,
        bidRefillRatio,
        askRefillRatio,
        updatedAt: Date.now(),
      });
      const flowSnap = (over: Partial<OrderFlowSnapshot> = {}): OrderFlowSnapshot => ({
        symbol: 'TESTUSDT',
        windowSec: 60,
        samples: 20,
        buyUsd: 6000,
        sellUsd: 2000,
        buySellRatio: 3,
        cvdUsd: 4000,
        cvdSlopeUsd: 1500,
        cvdSlopePct: 1500 / 8000,
        priceChangePct: 0.3,
        windowHigh: 101,
        windowLow: 99,
        lastPrice: 100.8,
        buyAggressionMultiple: 1.1,
        sellAggressionMultiple: 1.1,
        updatedAt: Date.now(),
        ...over,
      });
      const shortFlow = flowSnap({
        buyUsd: 2000,
        sellUsd: 6000,
        buySellRatio: 0.4,
        cvdUsd: -4000,
        cvdSlopeUsd: -1500,
        cvdSlopePct: -1500 / 8000,
        priceChangePct: -0.3,
        lastPrice: 99.2,
      });

      const longOk = evaluateOrderFlow({ side: 'LONG', book: bookSnap(0.35), flow: flowSnap(), params: flowParams });
      assert.equal(longOk.verdict, 'CONFIRM', longOk.reasons.join('; '));
      assert.equal(longOk.ok, true);
      assert.equal(longOk.obi, 0.35);

      const shortOk = evaluateOrderFlow({ side: 'SHORT', book: bookSnap(-0.35), flow: shortFlow, params: flowParams });
      assert.equal(shortOk.verdict, 'CONFIRM', shortOk.reasons.join('; '));
      assert.equal(shortOk.ok, true);

      assert.equal(
        evaluateOrderFlow({ side: 'LONG', book: null, flow: flowSnap(), params: flowParams }).verdict,
        'NO_DATA'
      );
      const stale = evaluateOrderFlow({
        side: 'LONG',
        book: { ...bookSnap(0.35), updatedAt: Date.now() - 6000 },
        flow: flowSnap(),
        params: flowParams,
      });
      assert.equal(stale.verdict, 'NO_DATA');
      assert.equal(stale.spreadBps, 2, 'the stale verdict dropped the measured spread');

      assert.equal(
        evaluateOrderFlow({ side: 'LONG', book: bookSnap(0.35), flow: flowSnap({ samples: 2 }), params: flowParams })
          .verdict,
        'NO_SIGNAL'
      );
      assert.equal(
        evaluateOrderFlow({ side: 'LONG', book: bookSnap(0.35), flow: null, params: flowParams }).verdict,
        'NO_SIGNAL'
      );

      // Gate order: affordability is checked before the book, because data costs nothing
      // and an unaffordable entry is a loss regardless of how the book leans.
      const cost = evaluateOrderFlow({
        side: 'LONG',
        book: bookSnap(0.0, 10),
        flow: flowSnap(),
        params: flowParams,
        expectedRoiPct: 3,
        leverage: 10,
        takerFeeRate: 0.0005,
      });
      assert.equal(cost.verdict, 'EXECUTION_REJECT');
      assert.ok(cost.costRoiPct !== null && Math.abs(cost.costRoiPct - 2) < 1e-9, `cost read ${cost.costRoiPct}`);
      // fees are linear in leverage, so the same trade at 2x leverage has the same ratio.
      assert.equal(
        evaluateOrderFlow({
          side: 'LONG',
          book: bookSnap(0.35, 10),
          flow: flowSnap(),
          params: flowParams,
          expectedRoiPct: 9,
          leverage: 20,
          takerFeeRate: 0.0005,
        }).verdict,
        'CONFIRM'
      );

      assert.equal(
        evaluateOrderFlow({ side: 'LONG', book: bookSnap(0.19), flow: flowSnap(), params: flowParams }).verdict,
        'OBI_REJECT'
      );
      assert.equal(
        evaluateOrderFlow({ side: 'SHORT', book: bookSnap(-0.19), flow: shortFlow, params: flowParams }).verdict,
        'OBI_REJECT'
      );
      assert.equal(
        evaluateOrderFlow({
          side: 'LONG',
          book: bookSnap(0.35),
          flow: flowSnap({ cvdSlopeUsd: -100 }),
          params: flowParams,
        }).verdict,
        'CVD_REJECT'
      );
      assert.equal(
        evaluateOrderFlow({
          side: 'LONG',
          book: bookSnap(0.35),
          flow: flowSnap({ buyUsd: 6000, sellUsd: 5000, buySellRatio: 1.2, cvdUsd: 1000 }),
          params: flowParams,
        }).verdict,
        'RATIO_REJECT'
      );
      assert.equal(
        evaluateOrderFlow({ side: 'LONG', book: bookSnap(0.35), flow: flowSnap({ lastPrice: 99.2 }), params: flowParams })
          .verdict,
        'PRICE_REJECT'
      );
      assert.equal(
        evaluateOrderFlow({ side: 'SHORT', book: bookSnap(-0.35), flow: shortFlow, params: flowParams }).ok,
        true
      );

      // Aggressive buying that the ask keeps absorbing, with price going nowhere, is the
      // exhaustion print this layer exists to refuse — on both sides.
      const absorbedLong = evaluateOrderFlow({
        side: 'LONG',
        book: bookSnap(0.35, 2, 1.9),
        flow: flowSnap({ buyAggressionMultiple: 2.0, priceChangePct: 0.01 }),
        params: flowParams,
      });
      assert.equal(absorbedLong.verdict, 'ABSORPTION_REJECT');
      assert.equal(absorbedLong.absorption, 'ABSORBED_BUYERS');
      const absorbedShort = evaluateOrderFlow({
        side: 'SHORT',
        book: bookSnap(-0.35, 2, 1, 1.9),
        flow: { ...shortFlow, priceChangePct: 0.01, sellAggressionMultiple: 2.0 },
        params: flowParams,
      });
      assert.equal(absorbedShort.verdict, 'ABSORPTION_REJECT');
      assert.equal(absorbedShort.absorption, 'ABSORBED_SELLERS');

      // --- Mode: shadow is the resting state, and enforce has to survive a restart.
      const modeStore = new StateStore();
      assert.equal(modeStore.getOrderFlowMode(), 'shadow', 'the layer must ship shadow-first');
      modeStore.setOrderFlowMode('enforce');
      assert.equal(new StateStore().getOrderFlowMode(), 'enforce', 'the mode did not persist');
      modeStore.setOrderFlowMode('shadow');
      assert.equal(new StateStore().getOrderFlowMode(), 'shadow');
    }

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

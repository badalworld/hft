import crypto from 'node:crypto';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type {
  AdaptiveStyleParams,
  AgentMemberStatus,
  AiPostMortemAnalysis,
  EntryFeatureVector,
  LocalDecisionConfig,
  LessonPattern,
  LossAutopsy,
  LossRootCause,
  OperatorNote,
  StyleMutationRecord,
  System1Weights,
  TradeLesson,
} from '../types.js';
import {
  EmpiricalScoreWindow,
  System1DecisionEngine,
  resolveReachableThreshold,
} from './system1Primitives.js';
import {
  aggregateLessonPatterns,
  buildTradeLesson,
  lessonKey,
  prependLesson,
  recallLessons,
} from './lessonMemory.js';
import { diagnoseLoss, feeHurdleRoiPct } from './lossAutopsy.js';
import {
  castBallots,
  consensusLine,
  nextStepLine,
  type Ballot,
  type CouncilContext,
  type MutationProposal,
} from './improvementCouncil.js';
import { clamp, f6 } from '../utils/format.js';
import { logger } from '../utils/logger.js';

export function createDefaultStyleParams(): AdaptiveStyleParams {
  return {
    baseMarginUsd: 2.0,
    minLeverage: 10,
    maxLeverage: 15,
    capitalUtilizationCapPct: 95.0,
    trailingTriggerRoiPct: 5.0,
    trailingFloorRoiPct: 3.65,
    trailingCallbackRoiPct: 1.15,
    protectiveStopRoiPct: -6.0,
    pullbackRsiLongMax: 52.0,
    pullbackRsiShortMin: 48.0,
    minOrderflowDeltaRatio: 1.18,
    minConfirmationBodyRatio: 0.36,
    max24hOverextensionPct: 85.0,
    cooldownSecondsAfterLoss: 120,
    minAiConfidenceScore: 0.56,
    minFeeHurdleMultiple: 2.0,
    orderFlowMinObi: 0.2,
    orderFlowMinVolumeRatio: 1.5,
    orderFlowWindowSec: 60,
    orderFlowAbsorptionMultiple: 1.6,
  };
}

export function createInitialAgents(): AgentMemberStatus[] {
  const now = Date.now();
  return [
    {
      id: 'alpha-scout',
      name: 'Alpha Scout',
      role: 'Top-40 24h Momentum & Regime Filter',
      framework: 'LangGraph + CrewAI Role',
      decisionsCount: 0,
      lastAction: 'Armed — scanning 20 max positive & 20 max negative perp movers.',
      lastUpdatedAt: now,
      active: true,
    },
    {
      id: 'microstructure-sniper',
      name: 'MicroStructure Sniper',
      role: '15s Candle Pullback & AggTrade Orderflow',
      framework: 'LangGraph + Agent-Zero Pattern',
      decisionsCount: 0,
      lastAction: 'Monitoring 15-second OHLCV + buyer/seller aggressor delta.',
      lastUpdatedAt: now,
      active: true,
    },
    {
      id: 'system1-judge',
      name: 'System-1 Decision Gate',
      role: 'Single-Pass Typed Probability & Brier RLCD',
      framework: 'Nimble / Laya / Kev System-1',
      decisionsCount: 0,
      lastAction: 'Calibrated noul/score gate ready (<1ms latency, $0 API fee).',
      lastUpdatedAt: now,
      active: true,
    },
    {
      id: 'leverage-architect',
      name: 'Leverage & Margin Architect',
      role: '$2 Margin, 95% Equity Cap & 10x→15x Ladder',
      framework: 'LangGraph + AutoGen Verifier',
      decisionsCount: 0,
      lastAction: 'Enforcing $2.000000 base margin & 10x→11x→12x→13x→14x→15x escalation.',
      lastUpdatedAt: now,
      active: true,
    },
    {
      id: 'hermes-evolver',
      name: 'Hermes Post-Mortem Evolver',
      role: 'Win/Loss Forensics & Autonomous Style Self-Learning',
      framework: 'LangGraph + Hermes Self-Evolution',
      decisionsCount: 0,
      lastAction: 'Standing by to analyze MFE/MAE & adapt trading parameters after each trade.',
      lastUpdatedAt: now,
      active: true,
    },
  ];
}

// 1. LangGraph Entry Consensus State Definition
const EntryStateAnnotation = Annotation.Root({
  symbol: Annotation<string>,
  side: Annotation<'LONG' | 'SHORT'>,
  features: Annotation<EntryFeatureVector>,
  minNotional: Annotation<number>,
  lessonKey: Annotation<string>,
  lessonGuidance: Annotation<string>,
  lessonSamples: Annotation<number>,
  lessonWinRatePct: Annotation<number>,
  confidenceDelta: Annotation<number>,
  operatorBriefing: Annotation<string>,
  regimeApproved: Annotation<boolean>,
  sniperApproved: Annotation<boolean>,
  system1Approved: Annotation<boolean>,
  aiConfidence: Annotation<number>,
  recommendedStartLeverage: Annotation<number>,
  vetoReason: Annotation<string>,
  summaryNote: Annotation<string>,
});

// 2. LangGraph Post-Mortem Self-Learning State Definition
const PostMortemStateAnnotation = Annotation.Root({
  symbol: Annotation<string>,
  side: Annotation<'LONG' | 'SHORT'>,
  netPnl: Annotation<number>,
  grossPnl: Annotation<number>,
  binanceFees: Annotation<number>,
  initialMargin: Annotation<number>,
  leverage: Annotation<number>,
  entryPrice: Annotation<number>,
  exitPrice: Annotation<number>,
  finalRoiPct: Annotation<number>,
  peakRoiPct: Annotation<number>,
  worstRoiPct: Annotation<number>,
  durationSec: Annotation<number>,
  exitReason: Annotation<string>,
  features: Annotation<EntryFeatureVector>,
  /** Guard ROI that was live at entry — the level the exit is judged against. */
  entryGuardRoiPct: Annotation<number>,
  lessonKey: Annotation<string>,
  verdict: Annotation<AiPostMortemAnalysis['verdict']>,
  autopsy: Annotation<LossAutopsy | null>,
  whatWorkedBest: Annotation<string>,
  whatWeMissed: Annotation<string>,
  mfeCaptureRatio: Annotation<number>,
  brierLoss: Annotation<number>,
  proposals: Annotation<MutationProposal[]>,
  ballots: Annotation<Ballot[]>,
  mutations: Annotation<Array<{ param: string; before: number; after: number; reason: string }>>,
});

export class AiAgentClubOrchestrator {
  public readonly system1Engine = new System1DecisionEngine();
  private agents: AgentMemberStatus[];
  private styleParams: AdaptiveStyleParams;
  private system1Weights: System1Weights;
  private localConfig: LocalDecisionConfig;
  /** Shared memory every node reads before it votes or decides. */
  private lessons: TradeLesson[];
  /** Free-text briefings from the operator. Advisory: quoted into reasoning, never a gate. */
  private operatorNotes: OperatorNote[];
  /** Scores the judge has actually emitted, so the gate can be held inside their range. */
  private readonly scoreWindow = new EmpiricalScoreWindow();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private compiledEntryGraph: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private compiledPostMortemGraph: any;

  constructor(init: {
    agents?: AgentMemberStatus[];
    styleParams: AdaptiveStyleParams;
    system1Weights: System1Weights;
    localConfig: LocalDecisionConfig;
    lessons?: TradeLesson[];
    operatorNotes?: OperatorNote[];
  }) {
    this.agents = init.agents?.length ? init.agents : createInitialAgents();
    this.styleParams = init.styleParams;
    this.system1Weights = init.system1Weights;
    this.localConfig = init.localConfig;
    this.lessons = init.lessons || [];
    this.operatorNotes = init.operatorNotes || [];

    this.compiledEntryGraph = this.buildEntryStateGraph();
    this.compiledPostMortemGraph = this.buildPostMortemStateGraph();
  }

  public getAgents(): AgentMemberStatus[] {
    return this.agents;
  }

  public getLessons(): TradeLesson[] {
    return this.lessons;
  }

  public getLessonPatterns(): LessonPattern[] {
    return aggregateLessonPatterns(this.lessons);
  }

  public hydrateLessons(lessons: TradeLesson[]) {
    this.lessons = lessons;
  }

  public setOperatorNotes(notes: OperatorNote[]) {
    this.operatorNotes = notes;
  }

  public getOperatorNotes(): OperatorNote[] {
    return this.operatorNotes;
  }

  /** The freshest briefing, phrased so an agent's log line reads as a quoted instruction. */
  private briefingLine(): string {
    const newest = this.operatorNotes[0];
    if (!newest) return '';
    return `OPERATOR BRIEFING: ${newest.text}`;
  }

  public getStyleParams(): AdaptiveStyleParams {
    return this.styleParams;
  }

  public updateStyleParams(partial: Partial<AdaptiveStyleParams>) {
    this.styleParams = { ...this.styleParams, ...partial };
  }

  public getSystem1Weights(): System1Weights {
    return this.system1Weights;
  }

  /** Re-score recent entries so the reachability clamp works on the first tick after a restart. */
  public seedScoreWindow(scores: number[]) {
    this.scoreWindow.seed(scores);
  }

  public getScoreWindowStats() {
    return this.scoreWindow.stats();
  }

  private resolveGate() {
    return resolveReachableThreshold(
      this.styleParams.minAiConfidenceScore,
      this.system1Weights,
      this.scoreWindow.stats()
    );
  }

  public getLocalDecisionConfig(): LocalDecisionConfig {
    return this.localConfig;
  }

  public setLocalDecisionConfig(cfg: Partial<LocalDecisionConfig>) {
    this.localConfig = { ...this.localConfig, ...cfg };
  }

  private touchAgent(id: string, action: string) {
    const agent = this.agents.find((a) => a.id === id);
    if (agent) {
      agent.decisionsCount += 1;
      agent.lastAction = action;
      agent.lastUpdatedAt = Date.now();
    }
  }

  private buildEntryStateGraph() {
    const graph = new StateGraph(EntryStateAnnotation)
      .addNode('sharedMemoryRecall', async (state) => {
        const recall = recallLessons(this.lessons, {
          symbol: state.symbol,
          side: state.side,
          features: state.features,
        });
        this.touchAgent(
          'hermes-evolver',
          `Recalled ${recall.key}: ${recall.sampleCount} closed trade(s) at ${f6(
            recall.winRatePct
          )}% win -> confidence ${recall.confidenceDelta >= 0 ? '+' : ''}${f6(
            recall.confidenceDelta
          )}`
        );
        return {
          lessonKey: recall.key,
          lessonGuidance: recall.guidance,
          lessonSamples: recall.sampleCount,
          lessonWinRatePct: recall.winRatePct,
          confidenceDelta: recall.confidenceDelta,
          operatorBriefing: this.briefingLine(),
        };
      })
      .addNode('alphaScout', async (state) => {
        const f = state.features;
        const maxOverext = this.styleParams.max24hOverextensionPct;
        const ok = f.absChange24hPct >= 1.5 && f.absChange24hPct <= maxOverext * 1.25;
        this.touchAgent(
          'alpha-scout',
          `${state.symbol} (${state.side}): 24h Δ ${f6(f.absChange24hPct)}% -> ${
            ok ? 'REGIME_PASS' : 'OVEREXTENDED_CAUTION'
          } | Hermes: ${state.lessonKey} ${f6(state.lessonWinRatePct)}% win / ${
            state.lessonSamples
          } trades${state.operatorBriefing ? ` | ${state.operatorBriefing}` : ''}`.slice(0, 200)
        );
        return {
          regimeApproved: ok,
          vetoReason: ok ? '' : `24h move ${f6(f.absChange24hPct)}% exceeds regime cap`,
        };
      })
      .addNode('microStructureSniper', async (state) => {
        if (!state.regimeApproved) {
          return { sniperApproved: false };
        }
        const f = state.features;
        const threshold = this.styleParams.minOrderflowDeltaRatio;
        const deltaOk = f.orderflowDeltaRatio >= threshold;
        const bodyOk =
          f.candleBodyRatio >= this.styleParams.minConfirmationBodyRatio ||
          f.wickRejectionRatio >= 0.42;
        const passed = deltaOk && bodyOk;
        this.touchAgent(
          'microstructure-sniper',
          `${state.symbol} 15s: RSI=${f6(f.rsi15s)} Delta=${f6(
            f.orderflowDeltaRatio
          )}x vs ${f6(threshold)}x -> ${passed ? 'CONFIRMED' : 'WEAK_TAPE'} | ${
            state.lessonGuidance
          }`.slice(0, 200)
        );
        return {
          sniperApproved: passed,
          vetoReason: passed
            ? ''
            : `15s confirmation filtered (Delta=${f6(f.orderflowDeltaRatio)}x vs required ${f6(
                threshold
              )}x, Body=${f6(f.candleBodyRatio)})`,
        };
      })
      .addNode('system1Judge', async (state) => {
        if (!state.sniperApproved) {
          return { system1Approved: false, aiConfidence: 0.25 };
        }
        const decision = await this.system1Engine.decide({
          symbol: state.symbol,
          side: state.side,
          features: state.features,
          weights: this.system1Weights,
          minConfidence: this.styleParams.minAiConfidenceScore,
          max24hOverextensionPct: this.styleParams.max24hOverextensionPct,
          minNotional: state.minNotional,
          baseMarginUsd: this.styleParams.baseMarginUsd,
          config: this.localConfig,
        });

        // Shared memory nudges the probability, then the gate is re-applied so a
        // historically losing setup genuinely has to clear a higher bar. The bar itself
        // is held inside the model's real range — its structural ceiling and, once enough
        // candidates exist, the p95 of scores it actually emits. A gate above every score
        // the model can produce filters 100% of signals forever, which is an outage, not risk.
        const adjusted = clamp(decision.calibratedScore + state.confidenceDelta, 0, 1);
        const gate = this.resolveGate();
        const approved = adjusted >= gate.threshold;
        const clampNote =
          gate.source === 'ceiling'
            ? ` — configured ${f6(this.styleParams.minAiConfidenceScore)} exceeds the model ceiling ${f6(
                gate.ceiling
              )}; gate held at ${f6(gate.threshold)}`
            : gate.source === 'observed'
              ? ` — configured ${f6(
                  this.styleParams.minAiConfidenceScore
                )} exceeds the observed p95 ${f6(
                  gate.observedP95 ?? 0
                )} of ${gate.observedN} recent candidates; gate held at ${f6(gate.threshold)}`
              : '';

        this.touchAgent(
          'system1-judge',
            `${state.symbol}: p=${f6(decision.calibratedScore)}${
              state.confidenceDelta !== 0
                ? ` ${state.confidenceDelta > 0 ? '+' : ''}${f6(state.confidenceDelta)} memory -> ${f6(adjusted)}`
                : ''
            } (${decision.choiceAction}) in ${decision.latencyMs.toFixed(2)}ms${clampNote}`
        );

        this.scoreWindow.record(adjusted);

        return {
          system1Approved: approved,
          aiConfidence: adjusted,
          recommendedStartLeverage: decision.recommendedLeverage,
          vetoReason: approved
            ? ''
            : state.confidenceDelta < 0
              ? `Shared memory veto: ${state.lessonGuidance}${clampNote}`
              : `System-1 score ${f6(adjusted)} < threshold ${f6(gate.threshold)}${clampNote}`,
        };
      })
      .addNode('leverageArchitect', async (state) => {
        if (!state.system1Approved) {
          return {
            summaryNote: state.vetoReason || 'Filtered by AI Club',
          };
        }
        // System-1's recommendation sets the ladder start; it is the minimum
        // leverage that clears Binance MIN_NOTIONAL, never a risk escalation.
        const startLev = clamp(
          Math.round(state.recommendedStartLeverage),
          Math.round(this.styleParams.minLeverage),
          Math.round(this.styleParams.maxLeverage)
        );
        const gate = this.resolveGate();
        this.touchAgent(
          'leverage-architect',
          `${state.symbol}: Approved $${f6(this.styleParams.baseMarginUsd)} margin | Ladder ${startLev}x→${
            this.styleParams.maxLeverage
          }x armed`
        );
        return {
          recommendedStartLeverage: startLev,
          summaryNote: `AI Club Consensus PASS (score=${f6(state.aiConfidence)}, start ${startLev}x)${
            gate.clamped
              ? ` [gate held at ${f6(
                  gate.threshold
                )}: configured ${f6(this.styleParams.minAiConfidenceScore)} is above the model's reachable range]`
              : ''
          }${state.operatorBriefing ? ` — briefed: ${state.operatorBriefing}` : ''}`,
        };
      })
      .addEdge(START, 'sharedMemoryRecall')
      .addEdge('sharedMemoryRecall', 'alphaScout')
      .addEdge('alphaScout', 'microStructureSniper')
      .addEdge('microStructureSniper', 'system1Judge')
      .addEdge('system1Judge', 'leverageArchitect')
      .addEdge('leverageArchitect', END);

    return graph.compile();
  }

  private buildPostMortemStateGraph() {
    const graph = new StateGraph(PostMortemStateAnnotation)
      .addNode('forensicAuditor', async (state) => {
        const wonNet = state.netPnl > 0;
        const mfeRatio =
          state.peakRoiPct > 0.5
            ? clamp(state.finalRoiPct / state.peakRoiPct, -1, 1)
            : wonNet
            ? 0.8
            : 0;

        let verdict: AiPostMortemAnalysis['verdict'] = 'WIN_OPTIMAL';
        let whatWorkedBest = '';
        let whatWeMissed = '';

        if (wonNet) {
          if (state.peakRoiPct >= 7.5 && mfeRatio < 0.62) {
            verdict = 'WIN_EARLY_TRAIL';
            whatWorkedBest = `15s pullback confirmation on ${state.symbol} (${state.side}) surged to +${f6(
              state.peakRoiPct
            )}% peak ROI and banked +$${f6(state.netPnl)} Net PNL after Binance fees.`;
            whatWeMissed = `Gave back ${f6(
              state.peakRoiPct - state.finalRoiPct
            )}% ROI from peak before trailing close (captured ${f6(
              mfeRatio * 100
            )}% of MFE). Tightening trailing callback slightly captures faster HFT spikes.`;
          } else {
            verdict = 'WIN_OPTIMAL';
            whatWorkedBest = `Clean 15s ${state.side} entry (RSI=${f6(
              state.features.rsi15s
            )}, Delta=${f6(state.features.orderflowDeltaRatio)}x) hit +${f6(
              state.finalRoiPct
            )}% ROI with +$${f6(state.netPnl)} pure Net PNL.`;
            whatWeMissed =
              state.worstRoiPct < -3.5
                ? `Experienced ${f6(state.worstRoiPct)}% initial drawdown (MAE) before rallying; slightly deeper pullback wait can improve R:R.`
                : `Minimal drawdown (${f6(state.worstRoiPct)}% MAE) and crisp trailing execution.`;
          }
        } else if (state.grossPnl > 0 && state.netPnl <= 0) {
          verdict = 'FEE_DRAG_BREAKEVEN';
          whatWorkedBest = `Direction was right (+$${f6(state.grossPnl)} Gross PNL), protecting capital.`;
          whatWeMissed = `Binance round-trip taker fees ($${f6(
            state.binanceFees
          )}) absorbed gross profit, resulting in $${f6(
            state.netPnl
          )} Net PNL. Raising trailing floor protects fee-adjusted profit.`;
        } else if (state.peakRoiPct < 1.8 && state.worstRoiPct <= -5.0) {
          verdict = 'LOSS_PREMATURE_PULLBACK';
          whatWorkedBest = `Protective risk guardrail exited ${state.symbol} swiftly within ${f6(
            state.durationSec
          )}s, capping loss to $${f6(state.netPnl)}.`;
          whatWeMissed = `Pullback had not finished exhausting on 15s timeframe (Entry RSI=${f6(
            state.features.rsi15s
          )}, Delta=${f6(
            state.features.orderflowDeltaRatio
          )}x). Waiting for stronger orderflow delta and deeper RSI reset improves entry accuracy.`;
        } else {
          verdict = 'LOSS_MOMENTUM_REVERSAL';
          whatWorkedBest = `Position sizing ($2.000000 margin) contained risk cleanly during sudden tape reversal.`;
          whatWeMissed = `Trade reached +${f6(
            state.peakRoiPct
          )}% ROI (< 5.000000% trailing activation) before 24h momentum (${f6(
            state.features.absChange24hPct
          )}%) snapped back.`;
        }

        const autopsy = wonNet
          ? null
          : diagnoseLoss({
              symbol: state.symbol,
              side: state.side,
              netPnl: state.netPnl,
              grossPnl: state.grossPnl,
              binanceFees: state.binanceFees,
              initialMargin: state.initialMargin,
              leverage: state.leverage,
              entryPrice: state.entryPrice,
              exitPrice: state.exitPrice,
              finalRoiPct: state.finalRoiPct,
              peakRoiPct: state.peakRoiPct,
              worstRoiPct: state.worstRoiPct,
              durationSec: state.durationSec,
              exitReason: state.exitReason,
              features: state.features,
              params: this.styleParams,
              entryGuardRoiPct: state.entryGuardRoiPct,
            });

        if (autopsy) {
          this.touchAgent(
            'hermes-evolver',
            `AUTOPSY ${state.symbol} (${state.side}) ${autopsy.rootCause}: ${autopsy.avoidanceRule}`.slice(
              0,
              200
            )
          );
        }

        return {
          verdict,
          autopsy,
          whatWorkedBest,
          whatWeMissed,
          mfeCaptureRatio: mfeRatio,
        };
      })
      .addNode('improvementDraft', async (state) => {
        const proposals: MutationProposal[] = [];
        const p = this.styleParams;

        const propose = (
          key: keyof AdaptiveStyleParams,
          nextVal: number,
          minV: number,
          maxV: number,
          reason: string
        ) => {
          const before = p[key];
          const clamped = Number(clamp(nextVal, minV, maxV).toFixed(6));
          if (Math.abs(clamped - before) >= 0.005) {
            proposals.push({ param: key, target: clamped, min: minV, max: maxV, reason });
          }
        };

        if (state.verdict === 'WIN_EARLY_TRAIL') {
          propose(
            'trailingCallbackRoiPct',
            p.trailingCallbackRoiPct - 0.06,
            0.65,
            2.1,
            'Tighten trailing stop callback to lock more of parabolic MFE peak'
          );
        } else if (state.verdict === 'WIN_OPTIMAL') {
          // Slight confidence relaxation when sniper hits clean winners so we capture steady flow
          propose(
            'minAiConfidenceScore',
            p.minAiConfidenceScore - 0.008,
            0.5,
            0.74,
            'Reward high-accuracy regime while preserving selectivity'
          );
        } else if (state.autopsy) {
          // A losing trade drafts its proposals from the autopsy's attribution rather
          // than from a verdict label, so the parameter that moves is the one the
          // diagnosis actually blamed.
          const cause: LossRootCause = state.autopsy.rootCause;
          const hurdle = feeHurdleRoiPct(state.binanceFees, state.initialMargin);
          const rsiReset = () => {
            if (state.side === 'LONG') {
              propose(
                'pullbackRsiLongMax',
                p.pullbackRsiLongMax - 1.0,
                40.0,
                58.0,
                'Wait for a deeper 15s RSI cooldown before calling a LONG pullback finished'
              );
            } else {
              propose(
                'pullbackRsiShortMin',
                p.pullbackRsiShortMin + 1.0,
                42.0,
                60.0,
                'Wait for a higher 15s RSI relief bounce before calling a SHORT pullback finished'
              );
            }
          };

          switch (cause) {
            case 'EXIT_SLIPPAGE':
              // The guard is a price promise; the only lever that keeps it is the
              // notional we throw at the book when the cascade hits.
              propose(
                'maxLeverage',
                p.maxLeverage - 1,
                5,
                15,
                `Stop filled ${f6(
                  state.finalRoiPct - (state.entryGuardRoiPct ?? p.protectiveStopRoiPct)
                )}% ROI through the guard — position too large for available exit depth`
              );
              propose(
                'cooldownSecondsAfterLoss',
                p.cooldownSecondsAfterLoss + 45,
                60,
                900,
                'Do not re-enter the same cascade that just slipped through the stop'
              );
              break;
            case 'TRAIL_TOO_LOOSE':
              propose(
                'trailingCallbackRoiPct',
                p.trailingCallbackRoiPct - 0.06,
                0.65,
                2.1,
                `Gave back ${f6(
                  state.peakRoiPct - state.finalRoiPct
                )}% of a +${f6(state.peakRoiPct)}% excursion — callback sized for a trend, not a spike`
              );
              break;
            case 'FEE_DRAG':
              propose(
                'maxLeverage',
                p.maxLeverage - 1,
                5,
                15,
                `Round-trip taker costs ${f6(
                  hurdle
                )}% of margin ROI at ${f6(
                  state.leverage
                )}x; the hurdle falls proportionally with leverage`
              );
              propose(
                'minAiConfidenceScore',
                p.minAiConfidenceScore + 0.01,
                0.5,
                0.74,
                'Demand higher probability before entering a move that only just clears the fee hurdle'
              );
              break;
            case 'MOVE_TOO_SMALL_FOR_FEES':
              propose(
                'maxLeverage',
                p.maxLeverage - 1,
                5,
                15,
                `Peak +${f6(state.peakRoiPct)}% ROI sat under the ${f6(
                  hurdle
                )}% fee hurdle — this band cannot pay for itself at this leverage`
              );
              propose(
                'minFeeHurdleMultiple',
                p.minFeeHurdleMultiple + 0.25,
                1.0,
                4.0,
                `Peak +${f6(
                  state.peakRoiPct
                )}% ROI bought a structure with no room for its own exit — demand more than one round trip next time`
              );
              propose(
                'minAiConfidenceScore',
                p.minAiConfidenceScore + 0.012,
                0.5,
                0.74,
                'Filter low-energy 15s structures whose full excursion is smaller than the round trip costs'
              );
              break;
            case 'ENTRY_INTO_SPENT_MOVE':
              propose(
                'max24hOverextensionPct',
                p.max24hOverextensionPct - 2.5,
                45.0,
                120.0,
                `Entered after a ${f6(
                  state.features.absChange24hPct
                )}% 24h move — over-extension is liquidation fuel, not continuation`
              );
              propose(
                'cooldownSecondsAfterLoss',
                p.cooldownSecondsAfterLoss + 30,
                60,
                900,
                'Lengthen per-symbol cooldown so a spent move is not re-entered on the first bounce'
              );
              break;
            case 'ADVERSE_TAKER_FLOW':
              propose(
                'minConfirmationBodyRatio',
                p.minConfirmationBodyRatio + 0.02,
                0.28,
                0.58,
                `Delta ${f6(
                  state.features.orderflowDeltaRatio
                )}x at RSI ${f6(
                  state.features.rsi15s
                )} was exhaustion print, not conviction — require a closed body`
              );
              propose(
                'orderFlowMinVolumeRatio',
                p.orderFlowMinVolumeRatio + 0.05,
                1.2,
                2.5,
                'Taker flow leaned against the entry — demand a bigger measured imbalance in the 60s tape'
              );
              rsiReset();
              break;
            case 'ENTRY_TOO_EARLY':
              propose(
                'minOrderflowDeltaRatio',
                p.minOrderflowDeltaRatio + 0.04,
                1.08,
                1.75,
                `MAE ${f6(
                  state.worstRoiPct
                )}% before any MFE — the pullback was still in progress at entry`
              );
              rsiReset();
              propose(
                'minAiConfidenceScore',
                p.minAiConfidenceScore + 0.015,
                0.5,
                0.74,
                'Increase System-1 probability gate after premature entry loss'
              );
              break;
            case 'REGIME_FADED':
              if (state.features.absChange24hPct > 55) {
                propose(
                  'max24hOverextensionPct',
                  p.max24hOverextensionPct - 2.5,
                  45.0,
                  120.0,
                  'Filter exhausted extreme 24h movers prone to violent mean-reversion'
                );
              }
              propose(
                'minConfirmationBodyRatio',
                p.minConfirmationBodyRatio + 0.02,
                0.28,
                0.58,
                'Demand stronger 15s confirmation candle body conviction'
              );
              break;
          }
        }

        this.touchAgent(
          'hermes-evolver',
          `Drafted ${proposals.length} improvement proposal(s) for ${state.verdict} on ${
            state.symbol
          }: ${proposals.map((pr) => pr.param).join(', ') || 'none'}`
        );

        return {
          proposals,
          lessonKey: lessonKey(state.side, state.features),
        };
      })
      .addNode('councilVote', async (state) => {
        const ctx: CouncilContext = {
          params: this.styleParams,
          verdict: state.verdict,
          side: state.side,
          patterns: this.getLessonPatterns(),
          lessonKey: state.lessonKey,
          recentLessons: this.lessons,
          rootCause: state.autopsy?.rootCause,
        };
        const ballots = castBallots(state.proposals, ctx);

        for (const b of ballots) {
          for (const v of b.votes) {
            this.touchAgent(v.agent, `${v.vote} ${b.change} — ${v.why}`.slice(0, 200));
          }
        }

        const approvedCount = ballots.filter((b) => b.approved).length;
        this.touchAgent(
          'system1-judge',
          `Council tallied ${ballots.length} ballot(s) on ${state.symbol}: ${approvedCount} approved, ${
            ballots.length - approvedCount
          } rejected by vote`.slice(0, 200)
        );

        return { ballots };
      })
      .addNode('applyConsensus', async (state) => {
        const changes: Array<{ param: string; before: number; after: number; reason: string }> = [];

        for (const b of state.ballots) {
          if (!b.approved) continue;
          const prop = state.proposals.find((pr) => pr.param === b.param);
          if (!prop) continue;
          const before = this.styleParams[prop.param];
          const after = Number(clamp(prop.target, prop.min, prop.max).toFixed(6));
          this.styleParams[prop.param] = after;
          changes.push({
            param: prop.param,
            before,
            after,
            reason: `${prop.reason} [${b.forCount}/${b.votes.length} council votes]`,
          });
        }

        return { mutations: changes };
      })
      .addNode('rlcdCalibration', async (state) => {
        const { updatedWeights, brierLoss } = this.system1Engine.learnFromOutcome({
          symbol: state.symbol,
          side: state.side,
          features: state.features,
          weights: this.system1Weights,
          wonNetAfterFees: state.netPnl > 0,
          netPnl: state.netPnl,
          peakRoiPct: state.peakRoiPct,
          worstRoiPct: state.worstRoiPct,
        });
        this.system1Weights = updatedWeights;

        this.touchAgent(
          'hermes-evolver',
          `Post-mortem ${state.symbol} (${state.verdict}): Net $${f6(
            state.netPnl
          )} | Brier=${f6(brierLoss)} | ${state.mutations.length} style param(s) evolved`
        );

        return { brierLoss };
      })
      .addEdge(START, 'forensicAuditor')
      .addEdge('forensicAuditor', 'improvementDraft')
      .addEdge('improvementDraft', 'councilVote')
      .addEdge('councilVote', 'applyConsensus')
      .addEdge('applyConsensus', 'rlcdCalibration')
      .addEdge('rlcdCalibration', END);

    return graph.compile();
  }

  public async evaluateEntryCandidate(params: {
    symbol: string;
    side: 'LONG' | 'SHORT';
    features: EntryFeatureVector;
    minNotional: number;
  }): Promise<{
    approved: boolean;
    confidence: number;
    recommendedStartLeverage: number;
    reason: string;
    lessonKey: string;
    lessonGuidance: string;
  }> {
    const out = await this.compiledEntryGraph.invoke({
      symbol: params.symbol,
      side: params.side,
      features: params.features,
      minNotional: params.minNotional,
      lessonKey: '',
      lessonGuidance: '',
      lessonSamples: 0,
      lessonWinRatePct: 0,
      confidenceDelta: 0,
      operatorBriefing: '',
      regimeApproved: false,
      sniperApproved: false,
      system1Approved: false,
      aiConfidence: 0.5,
      recommendedStartLeverage: 10,
      vetoReason: '',
      summaryNote: '',
    });

    const approved = Boolean(
      out.regimeApproved && out.sniperApproved && out.system1Approved
    );

    return {
      approved,
      confidence: Number(out.aiConfidence ?? 0.5),
      recommendedStartLeverage: Number(out.recommendedStartLeverage ?? 10),
      reason: out.summaryNote || out.vetoReason || 'Evaluated',
      lessonKey: String(out.lessonKey ?? ''),
      lessonGuidance: String(out.lessonGuidance ?? ''),
    };
  }

  /** Called once per closed trade so every agent can read this outcome on the next candidate. */
  public absorbLesson(lesson: TradeLesson) {
    this.lessons = prependLesson(this.lessons, lesson);
  }

  public async runTradePostMortem(params: {
    symbol: string;
    side: 'LONG' | 'SHORT';
    netPnl: number;
    grossPnl: number;
    binanceFees: number;
    initialMargin: number;
    leverage: number;
    entryPrice: number;
    exitPrice: number;
    finalRoiPct: number;
    peakRoiPct: number;
    worstRoiPct: number;
    durationSec: number;
    exitReason: string;
    features: EntryFeatureVector;
    entryGuardRoiPct: number;
  }): Promise<{
    analysis: AiPostMortemAnalysis;
    mutationRecord: StyleMutationRecord | null;
    lesson: TradeLesson;
  }> {
    const out = await this.compiledPostMortemGraph.invoke({
      ...params,
      lessonKey: '',
      verdict: 'WIN_OPTIMAL',
      autopsy: null,
      whatWorkedBest: '',
      whatWeMissed: '',
      mfeCaptureRatio: 0,
      brierLoss: 0,
      proposals: [],
      ballots: [],
      mutations: [],
    });

    const styleAdjustments: string[] = (out.mutations || []).map(
      (m: { param: string; before: number; after: number; reason: string }) =>
        `${m.param}: ${f6(m.before)} → ${f6(m.after)} (${m.reason})`
    );

    const ballots: Ballot[] = out.ballots || [];
    const ctx: CouncilContext = {
      params: this.styleParams,
      verdict: out.verdict,
      side: params.side,
      patterns: this.getLessonPatterns(),
      lessonKey: out.lessonKey || lessonKey(params.side, params.features),
      recentLessons: this.lessons,
      rootCause: out.autopsy?.rootCause,
    };

    const analysis: AiPostMortemAnalysis = {
      verdict: out.verdict,
      whatWorkedBest: out.whatWorkedBest,
      whatWeMissed: out.whatWeMissed,
      styleAdjustments,
      mfeCaptureRatio: out.mfeCaptureRatio,
      brierLoss: out.brierLoss,
      autopsy: out.autopsy || undefined,
      councilBallots: ballots,
      nextStep: nextStepLine(ballots, ctx),
      agentConsensusSummary: `${consensusLine(ballots)} || RLCD #${
        this.system1Weights.totalUpdates
      }, EMA Brier=${f6(this.system1Weights.brierScoreEma)}.`,
    };

    const lesson = buildTradeLesson(
      {
        closedAt: Date.now(),
        symbol: params.symbol,
        side: params.side,
        netPnl: params.netPnl,
        entryFeatures: params.features,
      },
      analysis
    );
    this.absorbLesson(lesson);

    let mutationRecord: StyleMutationRecord | null = null;
    if (out.mutations && out.mutations.length > 0) {
      mutationRecord = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        symbol: params.symbol,
        tradeOutcome: params.netPnl > 0 ? 'WIN' : 'LOSS',
        netPnl: params.netPnl,
        parameterChanges: out.mutations,
        summary: `${out.verdict}: ${out.whatWeMissed}`,
      };
    }

    logger.ai(
      'AI_CLUB',
      `Post-Mortem [${params.symbol} ${params.side}] Verdict=${out.verdict}${
        out.autopsy ? ` Autopsy=${out.autopsy.rootCause}` : ''
      } | NetPNL=$${f6(params.netPnl)} | Council=${ballots.length} ballot(s), ${
        styleAdjustments.length
      } applied`,
      {
        whatWorkedBest: out.whatWorkedBest,
        whatWeMissed: out.whatWeMissed,
        autopsy: out.autopsy
          ? {
              rootCause: out.autopsy.rootCause,
              why: out.autopsy.whyItHappened,
              rule: out.autopsy.avoidanceRule,
              execution: out.autopsy.executionUpdate,
            }
          : undefined,
        styleAdjustments,
        ballots: ballots.map((b) => `${b.change} -> ${b.approved ? 'FOR' : 'REJECTED'} (${b.forCount}/${b.votes.length})`),
        nextStep: analysis.nextStep,
      }
    );

    return { analysis, mutationRecord, lesson };
  }
}

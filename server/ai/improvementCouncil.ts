import type {
  AdaptiveStyleParams,
  AiPostMortemAnalysis,
  LessonPattern,
  TradeLesson,
} from '../types.js';
import { clamp, f6 } from '../utils/format.js';

export interface MutationProposal {
  param: keyof AdaptiveStyleParams;
  target: number;
  min: number;
  max: number;
  reason: string;
}

export type VoteValue = 'FOR' | 'AGAINST';

export interface Vote {
  agent: string;
  agentName: string;
  vote: VoteValue;
  why: string;
}

export interface Ballot {
  param: string;
  change: string;
  reason: string;
  votes: Vote[];
  forCount: number;
  approved: boolean;
}

/** Which club member is accountable for which parameter. */
const PARAM_OWNER: Record<string, string> = {
  max24hOverextensionPct: 'alpha-scout',
  cooldownSecondsAfterLoss: 'alpha-scout',
  minFeeHurdleMultiple: 'alpha-scout',
  minOrderflowDeltaRatio: 'microstructure-sniper',
  minConfirmationBodyRatio: 'microstructure-sniper',
  pullbackRsiLongMax: 'microstructure-sniper',
  pullbackRsiShortMin: 'microstructure-sniper',
  orderFlowMinObi: 'microstructure-sniper',
  orderFlowMinVolumeRatio: 'microstructure-sniper',
  orderFlowWindowSec: 'microstructure-sniper',
  orderFlowAbsorptionMultiple: 'microstructure-sniper',
  minAiConfidenceScore: 'system1-judge',
  baseMarginUsd: 'leverage-architect',
  minLeverage: 'leverage-architect',
  maxLeverage: 'leverage-architect',
  capitalUtilizationCapPct: 'leverage-architect',
  protectiveStopRoiPct: 'leverage-architect',
  trailingTriggerRoiPct: 'hermes-evolver',
  trailingFloorRoiPct: 'hermes-evolver',
  trailingCallbackRoiPct: 'hermes-evolver',
};

const AGENT_NAMES: Record<string, string> = {
  'alpha-scout': 'Alpha Scout',
  'microstructure-sniper': 'MicroStructure Sniper',
  'system1-judge': 'System-1 Decision Gate',
  'leverage-architect': 'Leverage & Margin Architect',
  'hermes-evolver': 'Hermes Post-Mortem Evolver',
};

/**
 * For every parameter, does a HIGHER value mean a STRICTER trading stance?
 * Two of these are easy to get backwards and both matter for real money:
 * `pullbackRsiLongMax` is inverted because a lower ceiling forces the bot to wait for a
 * deeper reset; `protectiveStopRoiPct` is inverted because it lives on a negative scale,
 * so -6.0 is tighter than -9.5 even though the number went up. `baseMarginUsd` and the
 * leverage caps are inverted too: a bigger bet is a looser stance, never a stricter one.
 */
const HIGHER_IS_TIGHTER: Record<string, boolean> = {
  max24hOverextensionPct: false,
  cooldownSecondsAfterLoss: true,
  minFeeHurdleMultiple: true,
  minOrderflowDeltaRatio: true,
  minConfirmationBodyRatio: true,
  orderFlowMinObi: true,
  orderFlowMinVolumeRatio: true,
  orderFlowWindowSec: true,
  // Absorption is a *block*, so demanding a larger aggression multiple before calling a
  // book absorbed means fewer blocks — a looser stance, not a stricter one.
  orderFlowAbsorptionMultiple: false,
  pullbackRsiLongMax: false,
  pullbackRsiShortMin: true,
  minAiConfidenceScore: true,
  baseMarginUsd: false,
  minLeverage: false,
  maxLeverage: false,
  capitalUtilizationCapPct: false,
  protectiveStopRoiPct: true,
  trailingTriggerRoiPct: false,
  trailingFloorRoiPct: true,
  trailingCallbackRoiPct: false,
};

/** Largest single-trade step each owner tolerates before it calls the move reckless. */
const MAX_STEP: Record<string, number> = {
  minOrderflowDeltaRatio: 0.05,
  minConfirmationBodyRatio: 0.03,
  pullbackRsiLongMax: 1.5,
  pullbackRsiShortMin: 1.5,
  minAiConfidenceScore: 0.02,
  orderFlowMinObi: 0.02,
  orderFlowMinVolumeRatio: 0.05,
  orderFlowWindowSec: 5,
  orderFlowAbsorptionMultiple: 0.1,
  trailingCallbackRoiPct: 0.15,
  trailingFloorRoiPct: 0.2,
  trailingTriggerRoiPct: 0.5,
  max24hOverextensionPct: 5.0,
  cooldownSecondsAfterLoss: 45,
  minFeeHurdleMultiple: 0.25,
  protectiveStopRoiPct: 1.5,
  // Sizing levers move dollars, so they get the smallest steps in the book: one leverage
  // rung or fifty cents at a time. Without a cap here the owner seat could not object to a
  // proposal that doubled the position on a single post-mortem.
  baseMarginUsd: 0.5,
  minLeverage: 2,
  maxLeverage: 2,
  capitalUtilizationCapPct: 5.0,
};

/** Which parameters this verdict is actually allowed to argue for. */
const VERDICT_PARAMS: Record<string, string[]> = {
  WIN_OPTIMAL: ['minAiConfidenceScore', 'trailingFloorRoiPct'],
  WIN_EARLY_TRAIL: ['trailingCallbackRoiPct', 'trailingFloorRoiPct'],
  FEE_DRAG_BREAKEVEN: ['trailingFloorRoiPct', 'minAiConfidenceScore'],
  LOSS_PREMATURE_PULLBACK: [
    'minOrderflowDeltaRatio',
    'minConfirmationBodyRatio',
    'pullbackRsiLongMax',
    'pullbackRsiShortMin',
    'minAiConfidenceScore',
  ],
  LOSS_MOMENTUM_REVERSAL: [
    'max24hOverextensionPct',
    'minConfirmationBodyRatio',
    'cooldownSecondsAfterLoss',
    'protectiveStopRoiPct',
  ],
};

/**
 * Loss proposals are drafted from the autopsy's root cause, not from the verdict label, so
 * the coherence seat has to be checked against the same attribution. Without this map, a
 * leverage cut recommended by an EXIT_SLIPPAGE autopsy could never be approved: the verdict
 * is LOSS_MOMENTUM_REVERSAL, which pre-dates the autopsy and does not mention maxLeverage.
 */
const AUTOPSY_PARAMS: Record<string, string[]> = {
  EXIT_SLIPPAGE: ['maxLeverage', 'baseMarginUsd', 'cooldownSecondsAfterLoss', 'protectiveStopRoiPct'],
  TRAIL_TOO_LOOSE: ['trailingCallbackRoiPct', 'trailingFloorRoiPct', 'trailingTriggerRoiPct'],
  FEE_DRAG: ['maxLeverage', 'minAiConfidenceScore', 'trailingFloorRoiPct'],
  MOVE_TOO_SMALL_FOR_FEES: [
    'maxLeverage',
    'minFeeHurdleMultiple',
    'minAiConfidenceScore',
    'trailingFloorRoiPct',
  ],
  ENTRY_INTO_SPENT_MOVE: ['max24hOverextensionPct', 'cooldownSecondsAfterLoss'],
  ADVERSE_TAKER_FLOW: [
    'minConfirmationBodyRatio',
    'pullbackRsiLongMax',
    'pullbackRsiShortMin',
    'orderFlowMinVolumeRatio',
    'orderFlowMinObi',
  ],
  ENTRY_TOO_EARLY: [
    'minOrderflowDeltaRatio',
    'minConfirmationBodyRatio',
    'pullbackRsiLongMax',
    'pullbackRsiShortMin',
    'minAiConfidenceScore',
    'orderFlowWindowSec',
  ],
  REGIME_FADED: [
    'max24hOverextensionPct',
    'minConfirmationBodyRatio',
    'cooldownSecondsAfterLoss',
    'minAiConfidenceScore',
  ],
};

/** Parameters whose *increase* puts more capital at risk on a single trade. */
const RISK_UP_PARAMS = [
  'maxLeverage',
  'minLeverage',
  'baseMarginUsd',
  'capitalUtilizationCapPct',
];


export interface CouncilContext {
  params: AdaptiveStyleParams;
  verdict: AiPostMortemAnalysis['verdict'];
  side: 'LONG' | 'SHORT';
  patterns: LessonPattern[];
  lessonKey: string;
  recentLessons: TradeLesson[];
  /** Set when the loss was attributed to a mechanism; the drafter keys off this, not the verdict. */
  rootCause?: string;
}

function isTightening(param: string, before: number, after: number): boolean {
  const higherIsTighter = HIGHER_IS_TIGHTER[param] ?? true;
  return higherIsTighter ? after > before : after < before;
}

function patternFor(ctx: CouncilContext): LessonPattern | undefined {
  return ctx.patterns.find((p) => p.key === ctx.lessonKey);
}

/** A loosening is only legitimate when shared memory shows the setup already pays. */
function looseningIsEarned(ctx: CouncilContext): { ok: boolean; why: string } {
  const p = patternFor(ctx);
  if (!p) return { ok: false, why: 'no closed-trade history for this setup' };
  if (p.sampleCount >= 4 && p.winRatePct >= 60 && p.netPnlTotal > 0) {
    return {
      ok: true,
      why: `shared memory proves it (${p.winRatePct.toFixed(6)}% win over ${p.sampleCount}, $${f6(
        p.netPnlTotal
      )} net)`,
    };
  }
  return {
    ok: false,
    why: `history says otherwise (${p.winRatePct.toFixed(6)}% win over ${p.sampleCount}, $${f6(
      p.netPnlTotal
    )} net)`,
  };
}

function flipFlopCount(param: string, ctx: CouncilContext): number {
  return ctx.recentLessons
    .slice(0, 8)
    .filter((l) => l.appliedAdjustments.some((a) => a.startsWith(param))).length;
}

function voteBy(agentId: string, prop: MutationProposal, ctx: CouncilContext): Vote {
  const before = ctx.params[prop.param];
  const after = clamp(prop.target, prop.min, prop.max);
  const tightening = isTightening(prop.param, before, after);
  const step = Math.abs(after - before);
  const cap = MAX_STEP[prop.param] ?? Infinity;
  const owner = PARAM_OWNER[prop.param] ?? 'hermes-evolver';
  let vote: VoteValue = 'FOR';
  let why = '';

  if (agentId === owner) {
    if (!tightening && !looseningIsEarned(ctx).ok) {
      vote = 'AGAINST';
      why = `Refusing to loosen my own guard (${prop.param} ${f6(before)} → ${f6(
        after
      )}) — ${looseningIsEarned(ctx).why}.`;
    } else if (step > cap) {
      vote = 'AGAINST';
      why = `Step of ${f6(step)} on ${prop.param} exceeds the ${f6(
        cap
      )} I allow in a single trade; take it in stages.`;
    } else {
      vote = 'FOR';
      why = `${tightening ? 'Tightening' : 'Earning a loosening'} of ${prop.param} by ${f6(
        step
      )} is inside my ${f6(cap)} limit and matches the tape.`;
    }
  } else if (agentId === 'hermes-evolver') {
    const allowed =
      (ctx.rootCause ? AUTOPSY_PARAMS[ctx.rootCause] : undefined) ||
      VERDICT_PARAMS[ctx.verdict] ||
      [];
    if (!allowed.includes(prop.param)) {
      vote = 'AGAINST';
      why = `${
        ctx.rootCause ? `Autopsy ${ctx.rootCause}` : `Verdict ${ctx.verdict}`
      } does not justify touching ${prop.param}; that is an unrelated change.`;
    } else {
      const flips = flipFlopCount(prop.param, ctx);
      if (flips >= 3) {
        vote = 'AGAINST';
        why = `${prop.param} has already been rewritten on ${flips} of the last 8 closes — we are oscillating, not learning. Hold it.`;
      } else {
        vote = 'FOR';
        why = `Coherent with verdict ${ctx.verdict}${flips > 0 ? ` (${flips} prior touch(es), still stable)` : ''}.`;
      }
    }
  } else {
    // Third seat: capital / risk consequence of the change. Direction matters — cutting
    // leverage after a slippage autopsy is the *repair*, and a seat that vetoed every
    // mention of maxLeverage could never approve it, which is why the riskiest lever in
    // the book was frozen in place.
    const riskUp =
      (RISK_UP_PARAMS.includes(prop.param) && after > before) ||
      (prop.param === 'protectiveStopRoiPct' && after < before);
    if (riskUp) {
      vote = 'AGAINST';
      why = `This raises capital at risk per trade; nothing in a ${ctx.verdict} post-mortem pays for that.`;
    } else if (tightening) {
      vote = 'FOR';
      why = `Stricter ${prop.param} can only reduce our loss tail, so I back it.`;
    } else {
      const earned = looseningIsEarned(ctx);
      vote = earned.ok ? 'FOR' : 'AGAINST';
      why = earned.ok
        ? `Loosening ${prop.param} is defensible: ${earned.why}.`
        : `Loosening ${prop.param} is not paid for yet — ${earned.why}.`;
    }
  }

  return { agent: agentId, agentName: AGENT_NAMES[agentId] || agentId, vote, why };
}

/**
 * Every proposal gets exactly three seats: the parameter's owner (who knows its
 * bounds), Hermes (verdict coherence + oscillation guard) and one peer that judges
 * only the capital consequence. Two FORs are required before anything is applied, and
 * the owner holds a hard veto: a 2/3 vote must not be able to outargue the one agent
 * accountable for a parameter's stated bounds on a live account.
 */
export function castBallots(
  proposals: MutationProposal[],
  ctx: CouncilContext
): Ballot[] {
  return proposals.map((prop) => {
    const owner = PARAM_OWNER[prop.param] ?? 'hermes-evolver';
    // Hermes is always on the panel, so when Hermes *owns* the parameter the peer
    // cannot be Hermes again — that collapsed the panel to two seats and turned
    // "two of three" into "two of two" for every trailing-stop parameter. In that
    // case the panel is Hermes plus two independent judges instead.
    const seats =
      owner === 'hermes-evolver'
        ? ['hermes-evolver', 'system1-judge', 'leverage-architect']
        : Array.from(new Set([owner, 'hermes-evolver', owner === 'system1-judge' ? 'leverage-architect' : 'system1-judge']));
    const votes = seats.map((id) => voteBy(id, prop, ctx));
    const forCount = votes.filter((v) => v.vote === 'FOR').length;
    const before = ctx.params[prop.param];
    const after = clamp(prop.target, prop.min, prop.max);

    return {
      param: prop.param,
      change: `${prop.param} ${f6(before)} → ${f6(after)}`,
      reason: prop.reason,
      votes,
      forCount,
      approved: forCount >= 2 && votes.some((v) => v.agent === owner && v.vote === 'FOR'),
    };
  });
}

export function consensusLine(ballots: Ballot[]): string {
  const applied = ballots.filter((b) => b.approved);
  const rejected = ballots.filter((b) => !b.approved);
  const parts: string[] = [];
  if (applied.length > 0) {
    parts.push(
      applied
        .map(
          (b) =>
            `APPROVED ${b.change} (${b.forCount}/${b.votes.length} votes: ${b.votes
              .map((v) => `${v.agentName} ${v.vote}`)
              .join(', ')})`
        )
        .join(' | ')
    );
  }
  if (rejected.length > 0) {
    parts.push(
      rejected
        .map(
          (b) =>
            `REJECTED ${b.change} — ${
              b.votes.find((v) => v.vote === 'AGAINST')?.why || 'no quorum'
            }`
        )
        .join(' | ')
    );
  }
  if (parts.length === 0) parts.push('No parameter change proposed by the council.');
  return parts.join(' || ');
}

export function nextStepLine(ballots: Ballot[], ctx: CouncilContext): string {
  const applied = ballots.filter((b) => b.approved).map((b) => b.change);
  const p = patternFor(ctx);
  const memory = p
    ? `Setup ${ctx.lessonKey} has ${p.sampleCount} closed trade(s) at ${p.winRatePct.toFixed(
        6
      )}% win, $${f6(p.netPnlTotal)} net.`
    : `Setup ${ctx.lessonKey} has no shared history yet.`;
  if (applied.length > 0) {
    return `Next time this setup appears, enter under ${applied.join(', ')}. ${memory}`;
  }
  return `Next time this setup appears, keep today's parameters and demand the same confirmation. ${memory}`;
}

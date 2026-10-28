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
  minOrderflowDeltaRatio: 'microstructure-sniper',
  minConfirmationBodyRatio: 'microstructure-sniper',
  pullbackRsiLongMax: 'microstructure-sniper',
  pullbackRsiShortMin: 'microstructure-sniper',
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
 * `pullbackRsiLongMax` is inverted on purpose: a lower ceiling forces the bot to
 * wait for a deeper reset, so tightening = decreasing.
 */
const HIGHER_IS_TIGHTER: Record<string, boolean> = {
  max24hOverextensionPct: false,
  cooldownSecondsAfterLoss: true,
  minOrderflowDeltaRatio: true,
  minConfirmationBodyRatio: true,
  pullbackRsiLongMax: false,
  pullbackRsiShortMin: true,
  minAiConfidenceScore: true,
  baseMarginUsd: true,
  minLeverage: false,
  maxLeverage: false,
  capitalUtilizationCapPct: false,
  protectiveStopRoiPct: false,
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
  trailingCallbackRoiPct: 0.15,
  trailingFloorRoiPct: 0.2,
  max24hOverextensionPct: 5.0,
  cooldownSecondsAfterLoss: 45,
  protectiveStopRoiPct: 1.5,
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

export interface CouncilContext {
  params: AdaptiveStyleParams;
  verdict: AiPostMortemAnalysis['verdict'];
  side: 'LONG' | 'SHORT';
  patterns: LessonPattern[];
  lessonKey: string;
  recentLessons: TradeLesson[];
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
    const allowed = VERDICT_PARAMS[ctx.verdict] || [];
    if (!allowed.includes(prop.param)) {
      vote = 'AGAINST';
      why = `Verdict ${ctx.verdict} does not justify touching ${prop.param}; that is an unrelated change.`;
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
    // Third seat: capital / risk consequence of the change
    const riskUp =
      prop.param === 'maxLeverage' ||
      prop.param === 'baseMarginUsd' ||
      prop.param === 'capitalUtilizationCapPct' ||
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
 * only the capital consequence. Two FORs are required before anything is applied.
 */
export function castBallots(
  proposals: MutationProposal[],
  ctx: CouncilContext
): Ballot[] {
  return proposals.map((prop) => {
    const owner = PARAM_OWNER[prop.param] ?? 'hermes-evolver';
    const peer = owner === 'system1-judge' ? 'leverage-architect' : 'system1-judge';
    const seats = Array.from(new Set([owner, 'hermes-evolver', peer]));
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
      approved: forCount >= 2,
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

import crypto from 'node:crypto';
import type {
  AiPostMortemAnalysis,
  EntryFeatureVector,
  LessonPattern,
  TradeLesson,
} from '../types.js';

const LESSON_CAP = 120;

export function rsiBand(side: 'LONG' | 'SHORT', rsi: number): string {
  if (side === 'LONG') {
    if (rsi < 35) return 'RSI<35';
    if (rsi < 45) return 'RSI35-45';
    if (rsi < 55) return 'RSI45-55';
    return 'RSI55+';
  }
  if (rsi > 65) return 'RSI>65';
  if (rsi > 55) return 'RSI55-65';
  if (rsi > 45) return 'RSI45-55';
  return 'RSI<45';
}

export function deltaBand(ratio: number): string {
  if (ratio < 1.05) return 'DELTA FLAT';
  if (ratio < 1.2) return 'DELTA 1.05-1.20';
  if (ratio < 1.5) return 'DELTA 1.20-1.50';
  return 'DELTA 1.50+';
}

export function overextensionBand(absChange24hPct: number): string {
  if (absChange24hPct < 10) return '24h<10%';
  if (absChange24hPct < 25) return '24h10-25%';
  if (absChange24hPct < 50) return '24h25-50%';
  return '24h50%+';
}

/** The address a lesson is filed under: same side, same RSI band, same tape quality. */
export function lessonKey(side: 'LONG' | 'SHORT', features: EntryFeatureVector): string {
  return `${side} | ${rsiBand(side, features.rsi15s)} | ${deltaBand(features.orderflowDeltaRatio)}`;
}

export function buildTradeLesson(
  trade: {
    closedAt: number;
    symbol: string;
    side: 'LONG' | 'SHORT';
    netPnl: number;
    entryFeatures: EntryFeatureVector;
  },
  analysis: AiPostMortemAnalysis
): TradeLesson {
  return {
    id: crypto.randomUUID(),
    createdAt: trade.closedAt,
    symbol: trade.symbol,
    side: trade.side,
    verdict: analysis.verdict,
    netPnl: trade.netPnl,
    rsiBand: rsiBand(trade.side, trade.entryFeatures.rsi15s),
    deltaBand: deltaBand(trade.entryFeatures.orderflowDeltaRatio),
    overextensionBand: overextensionBand(trade.entryFeatures.absChange24hPct),
    miss: analysis.whatWeMissed,
    rootCause: analysis.autopsy?.rootCause,
    avoidanceRule: analysis.autopsy?.avoidanceRule,
    appliedAdjustments: analysis.styleAdjustments.map((a) => a.split(':')[0].trim()),
  };
}

export function prependLesson(existing: TradeLesson[], lesson: TradeLesson): TradeLesson[] {
  const next = [lesson, ...existing];
  if (next.length > LESSON_CAP) next.length = LESSON_CAP;
  return next;
}

export function aggregateLessonPatterns(lessons: TradeLesson[]): LessonPattern[] {
  const byKey = new Map<string, LessonPattern>();
  for (const l of lessons) {
    const key = `${l.side} | ${l.rsiBand} | ${l.deltaBand}`;
    const p = byKey.get(key) || {
      key,
      sampleCount: 0,
      winCount: 0,
      netPnlTotal: 0,
      winRatePct: 0,
      lastTaughtAt: 0,
    };
    p.sampleCount += 1;
    if (l.netPnl > 0) p.winCount += 1;
    p.netPnlTotal += l.netPnl;
    p.lastTaughtAt = Math.max(p.lastTaughtAt, l.createdAt);
    p.winRatePct = (p.winCount / p.sampleCount) * 100;
    byKey.set(key, p);
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.sampleCount - a.sampleCount)
    .slice(0, 24);
}

export interface LessonRecall {
  key: string;
  sampleCount: number;
  winRatePct: number;
  netPnlTotal: number;
  /** Bounded nudge applied to the System-1 probability before the gate. */
  confidenceDelta: number;
  guidance: string;
  /** The newest autopsy rule on file for this band, if one has been written. */
  standingRule?: string;
}

/**
 * Shared-memory read: an incoming candidate is looked up against the pattern the
 * club already learned for this exact setup. Small samples deliberately produce no
 * adjustment, so one lucky trade cannot steer the entry gate.
 *
 * A written rule is different from a statistical nudge. One loss with a clear
 * attribution is worth carrying forward immediately, so the standing rule is recalled
 * even when the sample count is too small to move the probability.
 */
export function recallLessons(lessons: TradeLesson[], candidate: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  features: EntryFeatureVector;
}): LessonRecall {
  const key = lessonKey(candidate.side, candidate.features);
  const match = lessons.filter((l) => `${l.side} | ${l.rsiBand} | ${l.deltaBand}` === key);
  const pattern = aggregateLessonPatterns(match)[0];
  // Lessons are prepended, so the first hit is the most recent.
  const standingRule = match.find((l) => l.avoidanceRule)?.avoidanceRule;

  if (!pattern || pattern.sampleCount < 2) {
    return {
      key,
      sampleCount: pattern?.sampleCount || 0,
      winRatePct: pattern?.winRatePct || 0,
      netPnlTotal: pattern?.netPnlTotal || 0,
      confidenceDelta: 0,
      standingRule,
      guidance: standingRule
        ? `STANDING RULE for ${key}: ${standingRule}`
        : `No shared history for ${key} yet — deciding on live tape only.`,
    };
  }

  let delta = 0;
  let guidance = `Club has ${pattern.sampleCount} closed trade(s) on ${key}: ${pattern.winRatePct.toFixed(
    6
  )}% win, $${pattern.netPnlTotal.toFixed(6)} net. Standing by the current gate.`;

  if (pattern.sampleCount >= 4 && pattern.winRatePct < 35) {
    delta = -0.06;
    guidance = `HISTORICAL BLEED on ${key}: ${pattern.winRatePct.toFixed(
      6
    )}% win over ${pattern.sampleCount} trades, $${pattern.netPnlTotal.toFixed(
      6
    )} net. System-1 probability cut 0.06 until this setup proves itself.`;
  } else if (pattern.sampleCount >= 4 && pattern.winRatePct >= 65 && pattern.netPnlTotal > 0) {
    delta = 0.02;
    guidance = `PROVEN SETUP on ${key}: ${pattern.winRatePct.toFixed(6)}% win over ${
      pattern.sampleCount
    } trades, $${pattern.netPnlTotal.toFixed(6)} net. System-1 probability lifted 0.02.`;
  }

  if (standingRule) guidance = `${guidance} STANDING RULE: ${standingRule}`;

  return {
    key,
    sampleCount: pattern.sampleCount,
    winRatePct: pattern.winRatePct,
    netPnlTotal: pattern.netPnlTotal,
    confidenceDelta: delta,
    guidance,
    standingRule,
  };
}

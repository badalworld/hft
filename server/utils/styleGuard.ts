import type { AdaptiveStyleParams } from '../types.js';

/**
 * Hard bounds for every live trading parameter.
 *
 * The council's step caps govern how fast a parameter may *drift*; these govern where it may
 * never be. They exist because the settings route writes straight into the order path: a
 * stray request, a stale browser tab, or a fat-fingered margin must not be able to put the
 * whole Portfolio Margin balance into one 15-second scalp, and a positive protective stop
 * would close every position the instant it opens.
 */
const BOUNDS: Record<keyof AdaptiveStyleParams, { min: number; max: number }> = {
  baseMarginUsd: { min: 0.25, max: 50 },
  minLeverage: { min: 2, max: 25 },
  maxLeverage: { min: 2, max: 25 },
  capitalUtilizationCapPct: { min: 1, max: 95 },
  trailingTriggerRoiPct: { min: 0.5, max: 100 },
  trailingFloorRoiPct: { min: -50, max: 100 },
  trailingCallbackRoiPct: { min: 0.1, max: 25 },
  protectiveStopRoiPct: { min: -50, max: -0.1 },
  pullbackRsiLongMax: { min: 1, max: 99 },
  pullbackRsiShortMin: { min: 1, max: 99 },
  minOrderflowDeltaRatio: { min: 0.5, max: 5 },
  minConfirmationBodyRatio: { min: 0, max: 1 },
  max24hOverextensionPct: { min: 1, max: 1000 },
  cooldownSecondsAfterLoss: { min: 0, max: 3600 },
  minAiConfidenceScore: { min: 0, max: 1 },
  minFeeHurdleMultiple: { min: 1, max: 10 },
};

export interface StyleSanitizeResult {
  accepted: Partial<AdaptiveStyleParams>;
  rejected: string[];
}

/**
 * Unknown keys are dropped rather than passed through: `AdaptiveStyleParams` is spread into
 * the vault and the snapshot, so an injected field would be persisted and echoed to the UI.
 * `current` supplies the other half of each cross-parameter rule — the request only carries
 * the fields being changed, but the ladder and the trail have to stay consistent with the
 * values they keep.
 */
export function sanitizeStyleParams(
  current: AdaptiveStyleParams,
  input: unknown
): StyleSanitizeResult {
  const accepted: Partial<AdaptiveStyleParams> = {};
  const rejected: string[] = [];
  if (!input || typeof input !== 'object') {
    return { accepted, rejected: ['body was not an object'] };
  }

  for (const [key, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const bound = (BOUNDS as Record<string, { min: number; max: number } | undefined>)[key];
    if (!bound) {
      rejected.push(`${key} is not a trading parameter`);
      continue;
    }
    const value = typeof rawValue === 'string' ? Number(rawValue) : rawValue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      rejected.push(`${key}=${String(rawValue)} is not a number`);
      continue;
    }
    if (value < bound.min || value > bound.max) {
      rejected.push(`${key}=${value} is outside the ${bound.min}..${bound.max} safety range`);
      continue;
    }
    accepted[key as keyof AdaptiveStyleParams] = value;
  }

  // Relationships the engine cannot survive: the leverage ladder walks upward from min to
  // max, and a locked floor above the trigger would fire the trailing exit on open.
  const merged = { ...current, ...accepted };
  if (merged.minLeverage > merged.maxLeverage) {
    rejected.push(
      `minLeverage ${merged.minLeverage} would exceed maxLeverage ${merged.maxLeverage}`
    );
    delete accepted.minLeverage;
    delete accepted.maxLeverage;
  }
  if (merged.trailingFloorRoiPct > merged.trailingTriggerRoiPct) {
    rejected.push(
      `trailingFloorRoiPct ${merged.trailingFloorRoiPct} sits above the ${merged.trailingTriggerRoiPct}% trigger`
    );
    delete accepted.trailingFloorRoiPct;
  }

  return { accepted, rejected };
}

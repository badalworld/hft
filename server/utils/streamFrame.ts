import type { DashboardSnapshot } from '../types.js';

/**
 * Blocks that only change when a trade settles, a lesson is written or the income ledger is
 * refreshed. On a 1 Hz stream they are the bulk of the payload — the closed-trade history
 * alone is 40 records per frame — so they travel only to a client that has not yet seen the
 * snapshot version carrying them.
 */
export const HEAVY_SNAPSHOT_KEYS = [
  'recentClosedTrades',
  'styleMutations',
  'pnlLedger',
  'lessons',
  'lessonPatterns',
] as const;

/**
 * Returns a frame with the settled-trade blocks removed rather than set to undefined: the
 * dashboard merges incoming frames over its own state, and an explicit undefined would erase
 * the history already on screen.
 */
export function lightenSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  const light: Record<string, unknown> = { ...snapshot };
  for (const key of HEAVY_SNAPSHOT_KEYS) delete light[key];
  return light as unknown as DashboardSnapshot;
}

import type { EntryFeatureVector, OperatorDirective, OperatorDirectiveKind } from '../types.js';
import { f6 } from '../utils/format.js';

/**
 * The operator's standing orders, evaluated mechanically. First active rule that
 * matches vetoes the entry — no vote, no override, no confidence score high enough
 * to talk its way past it.
 */
export interface DirectiveCandidate {
  symbol: string;
  side: 'LONG' | 'SHORT';
  features: EntryFeatureVector;
  openPositionCount: number;
}

export const DIRECTIVE_KINDS: OperatorDirectiveKind[] = [
  'STAND_DOWN_ALL',
  'STAND_DOWN_SYMBOL',
  'BLOCK_LONG',
  'BLOCK_SHORT',
  'MAX_CONCURRENT_POSITIONS',
  'RSI_GATE',
  'MIN_24H_MOVE',
  'MAX_24H_OVEREXTENSION',
];

export const DIRECTIVE_LABEL: Record<OperatorDirectiveKind, string> = {
  STAND_DOWN_ALL: 'Stand down — take no new entries',
  STAND_DOWN_SYMBOL: 'Stand down on a symbol',
  BLOCK_LONG: 'No new LONG entries',
  BLOCK_SHORT: 'No new SHORT entries',
  MAX_CONCURRENT_POSITIONS: 'Maximum positions open at once',
  RSI_GATE: '15s RSI must have reset before entry',
  MIN_24H_MOVE: 'Minimum 24h move to trade',
  MAX_24H_OVEREXTENSION: 'Maximum 24h move before it is too late',
};

/** How the rule reads in plain words, with the operator's threshold filled in. */
export function describeDirective(d: OperatorDirective): string {
  switch (d.kind) {
    case 'STAND_DOWN_SYMBOL':
      return `${DIRECTIVE_LABEL[d.kind]} ${d.symbol ?? ''}`.trim();
    case 'MAX_CONCURRENT_POSITIONS':
      return `${DIRECTIVE_LABEL[d.kind]}: ${d.value ?? 0}`;
    case 'RSI_GATE':
      return `${DIRECTIVE_LABEL[d.kind]}: LONG needs RSI <= ${f6(
        d.value ?? 0
      )}, SHORT needs RSI >= ${f6(d.value ?? 0)}`;
    case 'MIN_24H_MOVE':
      return `${DIRECTIVE_LABEL[d.kind]}: ${f6(d.value ?? 0)}%`;
    case 'MAX_24H_OVEREXTENSION':
      return `${DIRECTIVE_LABEL[d.kind]}: ${f6(d.value ?? 0)}%`;
    default:
      return DIRECTIVE_LABEL[d.kind];
  }
}

/** True when this rule blocks the candidate, with the reason the numbers gave. */
function vetoes(d: OperatorDirective, c: DirectiveCandidate): boolean {
  switch (d.kind) {
    case 'STAND_DOWN_ALL':
      return true;
    case 'STAND_DOWN_SYMBOL':
      return Boolean(d.symbol) && d.symbol!.toUpperCase() === c.symbol.toUpperCase();
    case 'BLOCK_LONG':
      return c.side === 'LONG';
    case 'BLOCK_SHORT':
      return c.side === 'SHORT';
    case 'MAX_CONCURRENT_POSITIONS':
      return c.openPositionCount >= (d.value ?? Number.MAX_SAFE_INTEGER);
    case 'RSI_GATE':
      // A pullback entry is only a pullback entry if the oscillator actually cooled
      // off; past the operator's line the same signal is a chase.
      return d.value === undefined
        ? false
        : c.side === 'LONG'
        ? c.features.rsi15s > d.value
        : c.features.rsi15s < d.value;
    case 'MIN_24H_MOVE':
      return d.value !== undefined && c.features.absChange24hPct < d.value;
    case 'MAX_24H_OVEREXTENSION':
      return d.value !== undefined && c.features.absChange24hPct > d.value;
    default:
      return false;
  }
}

export function findVetoingDirective(
  directives: OperatorDirective[],
  candidate: DirectiveCandidate
): OperatorDirective | null {
  for (const d of directives) {
    if (!d.active) continue;
    if (vetoes(d, candidate)) return d;
  }
  return null;
}

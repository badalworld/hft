import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { LineChart, TrendingDown, TrendingUp, X } from 'lucide-react';
import type { DashboardSnapshot, PnlLedgerPoint } from '../types/hft';
import { fmt6, fmtOutflowUsd6, fmtSigned6, fmtSignedUsd6, fmtUsd6 } from '../utils/format';

interface PnlLedgerModalProps {
  open: boolean;
  snapshot: DashboardSnapshot | null;
  onClose: () => void;
}

const W = 960;
const H = 300;
const PAD = { left: 58, right: 46, top: 18, bottom: 26 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

const INK_BED = '#130a09';
const BRASS = '#D9A441';
const MINT = '#ADEBB3';
const ORCHID = '#EBAEE6';
const CORAL = '#FF857A';
const CREAM = '#FDF6F5';
const DIM = '#B99895';

function niceStep(range: number): number {
  const raw = range / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const norm = raw / mag;
  const mult = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return mult * mag;
}

/** Axis labels must fit the 50px gutter, so the scale drops to cents. */
function axisLabel(v: number): string {
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
}

/**
 * The Trellis: one hairline per settled close, two side strands that climb only on
 * their own trades, and the whole-portfolio strand in cream. The brass rule is zero —
 * everything above it is money the account kept.
 */
const PnlTrellis: React.FC<{
  points: PnlLedgerPoint[];
  reduceMotion: boolean;
}> = ({ points, reduceMotion }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const geometry = useMemo(() => {
    const n = points.length;
    const totals = points.map((p) => p.cumulativeNet);
    const longs = points.filter((p) => p.side === 'LONG').map((p) => p.cumulativeSideNet);
    const shorts = points.filter((p) => p.side === 'SHORT').map((p) => p.cumulativeSideNet);
    const all = [0, ...totals, ...longs, ...shorts];
    let dMin = Math.min(...all);
    let dMax = Math.max(...all);
    if (dMax - dMin < 1e-9) {
      dMax = dMin + 0.1;
      dMin = dMin - 0.1;
    }
    const padY = (dMax - dMin) * 0.08;
    dMin -= padY;
    dMax += padY;

    const xAt = (i: number) => (n <= 1 ? PAD.left + INNER_W / 2 : PAD.left + (i * INNER_W) / (n - 1));
    const yAt = (v: number) => PAD.top + INNER_H * (1 - (v - dMin) / (dMax - dMin));

    const strand = (sel: (p: PnlLedgerPoint, i: number) => number | null) => {
      const cmds: string[] = [];
      points.forEach((p, i) => {
        const v = sel(p, i);
        if (v === null) return;
        cmds.push(`${cmds.length === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`);
      });
      return cmds.join(' ');
    };

    const step = niceStep(dMax - dMin);
    const first = Math.ceil(dMin / step) * step;
    const grid: number[] = [];
    for (let v = first; v <= dMax + 1e-9; v += step) grid.push(Number(v.toFixed(6)));

    return {
      n,
      dMin,
      dMax,
      xAt,
      yAt,
      grid,
      totalPath: strand((p) => p.cumulativeNet),
      longPath: strand((p) => (p.side === 'LONG' ? p.cumulativeSideNet : null)),
      shortPath: strand((p) => (p.side === 'SHORT' ? p.cumulativeSideNet : null)),
    };
  }, [points]);

  const { n, xAt, yAt, grid, totalPath, longPath, shortPath } = geometry;
  const zeroY = yAt(0);
  const hovered = hoverIdx === null ? null : points[hoverIdx];
  const drawIn = {
    initial: reduceMotion ? { pathLength: 1 } : { pathLength: 0 },
    animate: { pathLength: 1 },
    transition: { duration: reduceMotion ? 0 : 1.05, ease: 'easeInOut' as const },
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Cumulative net PNL across ${n} settled close${n === 1 ? '' : 's'}`}
        className="w-full"
        style={{ backgroundColor: INK_BED, borderRadius: 12 }}
      >
        {/* Trellis lattice — one vertical per close */}
        {points.map((p, i) => (
          <line
            key={`lat-${p.symbol}-${i}`}
            x1={xAt(i)}
            x2={xAt(i)}
            y1={PAD.top}
            y2={PAD.top + INNER_H}
            stroke={ORCHID}
            strokeOpacity={hoverIdx === i ? 0.34 : 0.08}
            strokeWidth={1}
          />
        ))}

        {/* Horizontal scale rules */}
        {grid.map((v) => (
          <g key={`grid-${v}`}>
            <line
              x1={PAD.left}
              x2={PAD.left + INNER_W}
              y1={yAt(v)}
              y2={yAt(v)}
              stroke={CREAM}
              strokeOpacity={0.07}
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={yAt(v) + 3.5}
              textAnchor="end"
              fontSize={10}
              fill={DIM}
              className="font-mono-num"
            >
              {axisLabel(v)}
            </text>
          </g>
        ))}

        {/* Brass zero rule */}
        <line
          x1={PAD.left - 14}
          x2={PAD.left + INNER_W}
          y1={zeroY}
          y2={zeroY}
          stroke={BRASS}
          strokeWidth={1.4}
          strokeDasharray="none"
        />
        <text x={PAD.left - 8} y={zeroY + 3.5} textAnchor="end" fontSize={10} fill={BRASS} className="font-mono-num">
          0
        </text>

        {/* Side strands */}
        {longPath && (
          <motion.path d={longPath} fill="none" stroke={MINT} strokeWidth={1.3} strokeOpacity={0.85} strokeLinecap="round" {...drawIn} />
        )}
        {shortPath && (
          <motion.path d={shortPath} fill="none" stroke={ORCHID} strokeWidth={1.3} strokeOpacity={0.85} strokeLinecap="round" {...drawIn} />
        )}

        {/* Per-trade stems: the jump one close made */}
        {points.map((p, i) => {
          const from = i === 0 ? 0 : points[i - 1].cumulativeNet;
          return (
            <motion.line
              key={`stem-${p.symbol}-${i}`}
              x1={xAt(i)}
              x2={xAt(i)}
              y1={yAt(from)}
              y2={yAt(p.cumulativeNet)}
              stroke={p.netPnl >= 0 ? MINT : CORAL}
              strokeWidth={hoverIdx === i ? 2.6 : 1.8}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 0.9 }}
              transition={{ delay: reduceMotion ? 0 : 0.03 * i, duration: 0.25 }}
            />
          );
        })}

        {/* Whole-portfolio strand */}
        <motion.path d={totalPath} fill="none" stroke={CREAM} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" {...drawIn} />

        {/* Focusable dots — one per settled close */}
        {points.map((p, i) => (
          <g
            key={`dot-${p.symbol}-${i}`}
            tabIndex={0}
            role="listitem"
            aria-label={`${p.side} ${p.symbol} closed ${fmtSignedUsd6(p.netPnl)} net, cumulative ${fmtSignedUsd6(p.cumulativeNet)}`}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
            onFocus={() => setHoverIdx(i)}
            onBlur={() => setHoverIdx(null)}
            style={{ cursor: 'pointer', outline: 'none' }}
          >
            <circle
              cx={xAt(i)}
              cy={yAt(p.cumulativeNet)}
              r={hoverIdx === i ? 5 : 3}
              fill={p.side === 'LONG' ? MINT : ORCHID}
              stroke={INK_BED}
              strokeWidth={1.2}
            />
            {hoverIdx === i && (
              <circle cx={xAt(i)} cy={yAt(p.cumulativeNet)} r={9} fill="none" stroke={BRASS} strokeWidth={1} />
            )}
          </g>
        ))}
      </svg>

      {hovered && hoverIdx !== null && (
        <div
          className="skeuo-dropdown-menu pointer-events-none absolute top-2 z-10 w-56 rounded-xl px-3 py-2 text-[11px]"
          style={{
            left: `min(calc(100% - 15rem), max(0px, ${(xAt(hoverIdx) / W) * 100}% - 7rem))`,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono-num font-bold text-white">{hovered.symbol}</span>
            <span className={`font-mono-num font-bold ${hovered.side === 'LONG' ? 'text-[#ADEBB3]' : 'text-[#EBAEE6]'}`}>
              {hovered.side}
            </span>
          </div>
          <div className="mt-1 font-mono-num text-[#c7a8a5]">
            Net {fmtSignedUsd6(hovered.netPnl)} • ROI {fmtSigned6(hovered.finalRoiPct)}%
          </div>
          <div className="font-mono-num text-[#c7a8a5]">
            Cumulative {fmtSignedUsd6(hovered.cumulativeNet)}
          </div>
          <div className="mt-1 truncate text-[10px] text-[#b99895]">{hovered.exitReason}</div>
        </div>
      )}
    </div>
  );
};

const Readout: React.FC<{
  label: string;
  value: string;
  sub?: string;
  tone?: 'up' | 'down' | 'neutral' | 'brass';
}> = ({ label, value, sub, tone = 'neutral' }) => {
  const toneClass =
    tone === 'up'
      ? 'text-[#ADEBB3]'
      : tone === 'down'
        ? 'text-[#FF857A]'
        : tone === 'brass'
          ? 'text-[#D9A441]'
          : 'text-[#FDF6F5]';

  return (
    <div className="skeuo-oled rounded-xl px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-[#c7a8a5]">{label}</div>
      <div className={`mt-1 font-mono-num text-sm font-bold ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 font-mono-num text-[10px] text-[#b99895]">{sub}</div>}
    </div>
  );
};

const Band: React.FC<{ title: string; accent: string; children: React.ReactNode }> = ({
  title,
  accent,
  children,
}) => (
  <section className="mb-4">
    <div className="mb-2 flex items-center gap-2">
      <span className="h-px flex-1" style={{ backgroundColor: `${accent}33` }} />
      <h3 className="font-crest text-[11px] font-bold tracking-[0.18em]" style={{ color: accent }}>
        {title}
      </h3>
      <span className="h-px flex-1" style={{ backgroundColor: `${accent}33` }} />
    </div>
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">{children}</div>
  </section>
);

export const PnlLedgerModal: React.FC<PnlLedgerModalProps> = ({ open, snapshot, onClose }) => {
  const reduceMotion = useMemo(
    () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
    []
  );

  if (!open) return null;

  const ledger = snapshot?.pnlLedger;
  const stats = ledger?.stats;
  const points = ledger?.points ?? [];
  const income = ledger?.income;

  const netTone = (stats?.totalNetPnl ?? 0) >= 0 ? 'up' : 'down';
  const fundingTone = (stats?.totalFundingFees ?? 0) >= 0 ? 'up' : 'down';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-md sm:p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="skeuo-chassis skeuo-lotus-trim relative my-auto w-full max-w-5xl rounded-2xl p-5 sm:p-6"
      >
        <div className="lotus-ribbon absolute top-0 left-0 right-0 h-[3px]" />
        <div className="skeuo-screw !absolute top-3 left-2.5 hidden sm:block" />
        <div className="skeuo-screw !absolute top-3 right-2.5 hidden sm:block" />

        <div className="mb-4 flex items-start justify-between gap-3 border-b border-[#EBAEE6]/15 pb-4">
          <div className="flex items-center gap-3">
            <div className="skeuo-oled flex h-10 w-10 items-center justify-center rounded-xl border border-[#D9A441]/45">
              <LineChart className="h-5 w-5 text-[#D9A441]" />
            </div>
            <div>
              <h2 className="font-crest text-lg font-bold tracking-wider text-lotus-crest">
                PNL LEDGER — THE TRELLIS
              </h2>
              <p className="text-xs text-[#d5b8b5]">
                Every settled close the engine recorded, climbed strand by strand against real Binance income.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="skeuo-btn rounded-xl p-2 text-[#fdf6f5]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="skeuo-oled mb-4 rounded-xl p-2.5 sm:p-3">
          {points.length === 0 ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 px-6 text-center">
              <TrendingUp className="h-6 w-6 text-[#D9A441]/70" />
              <p className="text-sm font-semibold text-[#FDF6F5]">No settled closes yet</p>
              <p className="text-xs text-[#c7a8a5]">
                The trellis is built and waiting. The first position the engine closes draws its stem here,
                and the stats deck below fills in from real exchange income.
              </p>
            </div>
          ) : (
            <>
              <PnlTrellis points={points} reduceMotion={reduceMotion} />
              <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-1 text-[10px] text-[#c7a8a5]">
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-5 rounded" style={{ backgroundColor: CREAM }} /> Portfolio net
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-5 rounded" style={{ backgroundColor: MINT }} /> LONG strand
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-5 rounded" style={{ backgroundColor: ORCHID }} /> SHORT strand
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-5 rounded" style={{ backgroundColor: BRASS }} /> Zero
                </span>
                <span className="font-mono-num">
                  {points.length} closes • {new Date(stats?.firstTradeAt ?? Date.now()).toLocaleDateString()} →{' '}
                  {new Date(stats?.lastTradeAt ?? Date.now()).toLocaleDateString()}
                </span>
              </div>
            </>
          )}
        </div>

        <Band title="VOLUME" accent={ORCHID}>
          <Readout label="Total Trades" value={String(stats?.totalTrades ?? 0)} sub="settled closes on record" />
          <Readout
            label="Long Trade Quantity"
            value={String(stats?.longTrades ?? 0)}
            sub={`net ${fmtSignedUsd6(stats?.longNetPnl ?? 0)}`}
            tone="up"
          />
          <Readout
            label="Short Trade Quantity"
            value={String(stats?.shortTrades ?? 0)}
            sub={`net ${fmtSignedUsd6(stats?.shortNetPnl ?? 0)}`}
            tone="brass"
          />
        </Band>

        <Band title="ACCURACY" accent={MINT}>
          <Readout label="Win Trades" value={String(stats?.winTrades ?? 0)} sub={`${stats?.lossTrades ?? 0} losses`} tone="up" />
          <Readout
            label="Win Rate"
            value={`${fmt6(stats?.winRatePct ?? 0)}%`}
            sub={`${stats?.totalTrades ?? 0} closed`}
            tone={(stats?.winRatePct ?? 0) >= 50 ? 'up' : 'down'}
          />
          <Readout
            label="Long Win %"
            value={`${fmt6(stats?.longWinRatePct ?? 0)}%`}
            sub={`${stats?.longWinTrades ?? 0} of ${stats?.longTrades ?? 0}`}
            tone="up"
          />
          <Readout
            label="Short Win %"
            value={`${fmt6(stats?.shortWinRatePct ?? 0)}%`}
            sub={`${stats?.shortWinTrades ?? 0} of ${stats?.shortTrades ?? 0}`}
            tone="brass"
          />
          <Readout label="Best Close" value={fmtSignedUsd6(stats?.bestTradeNet ?? 0)} tone="up" />
          <Readout
            label="Worst Close"
            value={points.length > 0 ? fmtSignedUsd6(stats?.worstTradeNet ?? 0) : '—'}
            tone="down"
          />
        </Band>

        <Band title="FRICTION" accent={BRASS}>
          <Readout
            label="Total Binance Platform Fees"
            value={points.length > 0 ? fmtOutflowUsd6(stats?.totalBinanceFees ?? 0) : '—'}
            sub={
              income?.available
                ? `exchange-settled commission ${fmtUsd6(income.commissionTotal)}`
                : 'engine taker-rate estimate'
            }
            tone="down"
          />
          <Readout
            label="Total Funding Fees"
            value={income?.available ? fmtSignedUsd6(stats?.totalFundingFees) : '—'}
            sub={
              income?.available
                ? `${income.fundingFeeAccountTotal !== income.fundingFeeTotal ? `account-wide ${fmtSignedUsd6(income.fundingFeeAccountTotal)} • ` : ''}${
                    (stats?.totalFundingFees ?? 0) > 0
                      ? 'received on bot symbols'
                      : (stats?.totalFundingFees ?? 0) < 0
                      ? 'paid on bot symbols'
                      : 'no funding settled on bot symbols yet'
                  }`
                : income?.status || 'awaiting first /papi/v1/um/income sync'
            }
            tone={fundingTone}
          />
          <Readout
            label="Fee Drag On Gross"
            value={
              points.length === 0
                ? '—'
                : (stats?.totalGrossPnl ?? 0) > 0
                ? `${fmt6(stats?.feeDragPctOfGross ?? 0)}%`
                : '—'
            }
            sub={
              points.length > 0 && (stats?.totalGrossPnl ?? 0) <= 0
                ? 'no gross profit to measure against'
                : `avg win ${fmtSignedUsd6(stats?.avgWinNet ?? 0)} • avg loss ${fmtSignedUsd6(stats?.avgLossNet ?? 0)}`
            }
            tone="brass"
          />
          <Readout
            label="Gross PNL"
            value={points.length > 0 ? fmtSignedUsd6(stats?.totalGrossPnl) : '—'}
            sub="before taker fees"
          />
          <Readout
            label="Net PNL After Fees"
            value={points.length > 0 ? fmtSignedUsd6(stats?.totalNetPnl) : '—'}
            sub="settled closes only"
            tone={netTone}
          />
          <Readout
            label="Net Including Funding"
            value={income?.available ? fmtSignedUsd6((stats?.totalNetPnl ?? 0) + (stats?.totalFundingFees ?? 0)) : '—'}
            sub={income?.available ? `${income.recordCount} income records` : 'not synced yet'}
            tone={income?.available ? ((stats?.totalNetPnl ?? 0) + (stats?.totalFundingFees ?? 0) >= 0 ? 'up' : 'down') : 'neutral'}
          />
        </Band>

        <div className="mt-1 flex flex-col gap-1.5 border-t border-[#EBAEE6]/15 pt-3 text-[11px] text-[#c7a8a5] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            {income?.available ? (
              <TrendingUp className="h-3.5 w-3.5 shrink-0 text-[#ADEBB3]" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 shrink-0 text-[#FF857A]" />
            )}
            <span className="min-w-0 truncate">
              {income?.available
                ? `Exchange income synced from /papi/v1/um/income at ${new Date(income.lastSyncAt).toLocaleTimeString()} — funding is attributed per symbol the bot actually traded.`
                : income?.status || 'Income ledger has not synced yet — funding shows — rather than a guessed zero.'}
            </span>
          </div>
          <span className="font-mono-num shrink-0 text-[#b99895]">
            Unrealized open positions are not in this ledger.
          </span>
        </div>
      </motion.div>
    </div>
  );
};

export default PnlLedgerModal;

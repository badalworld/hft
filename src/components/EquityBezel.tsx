import React from 'react';
import { motion } from 'framer-motion';
import { Lock, TrendingUp, Wallet, ShieldAlert } from 'lucide-react';
import type { DashboardSnapshot } from '../types/hft';
import { fmt6, fmtSigned6, fmtSignedUsd6, fmtUsd2, fmtUsd6 } from '../utils/format';
import { SegmentDefs, SevenSegmentNumber, useConsoleGlyphHeight } from './SevenSegmentNumber';

interface EquityBezelProps {
  snapshot: DashboardSnapshot | null;
}

export const EquityBezel: React.FC<EquityBezelProps> = ({ snapshot }) => {
  const startBalance = snapshot?.startBalance ?? 0;
  const startLocked = Boolean(snapshot?.startBalanceLocked);
  const currentEquity = snapshot?.currentEquity ?? 0;
  const walletBalance = snapshot?.walletBalance ?? 0;
  const availableBalance = snapshot?.availableBalance ?? 0;
  const usedMargin = snapshot?.usedMarginTotal ?? 0;
  const max95 = snapshot?.maxDeployable95Margin ?? 0;
  const rem95 = snapshot?.remainingDeployable95Margin ?? 0;
  const capPct = snapshot?.capitalUtilizationPct ?? 0;

  const equityDelta = startLocked ? currentEquity - startBalance : 0;
  const equityDeltaPct =
    startLocked && startBalance > 0 ? (equityDelta / startBalance) * 100 : 0;

  const marginPaused = snapshot?.scannerState === 'PAUSED_MARGIN_FULL';

  const glyphPx = useConsoleGlyphHeight();

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <SegmentDefs />
      {/* 1. START BALANCE (Fixed on 1st Binance API Connection until Reset) */}
      <div className="skeuo-chassis relative rounded-2xl p-4 sm:p-5 lg:col-span-5">
        <div className="skeuo-screw !absolute top-2.5 left-2.5" />
        <div className="skeuo-screw !absolute top-2.5 right-2.5" />

        <div className="mb-2.5 flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-[#EBAEE6]" />
            <span className="text-xs font-semibold uppercase tracking-[0.15em] text-[#f4e5e3]">
              Start Balance
            </span>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              startLocked
                ? 'border-[#EBAEE6]/45 bg-[#EBAEE6]/15 text-[#EBAEE6]'
                : 'border-white/15 bg-black/35 text-[#cdb0ad]'
            }`}
          >
            <Lock className="h-2.5 w-2.5" />
            {startLocked ? 'Fixed Vault Snapshot' : 'Locks on 1st API Connect'}
          </span>
        </div>

        <div className="skeuo-oled rounded-xl px-4 py-4">
          <div className="flex items-baseline justify-between gap-2">
            <SevenSegmentNumber
              value={fmtUsd2(startBalance)}
              tone="orchid"
              heightPx={glyphPx}
              label={`Start balance ${fmtUsd6(startBalance)} USDT`}
            />
            <span className="font-mono-num text-xs font-semibold text-[#EBAEE6]">USDT</span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#EBAEE6]/10 pt-2 text-[11px] text-[#c7a8a5]">
            <span>
              Wallet Balance:{' '}
              <strong className="font-mono-num text-[#fdf6f5]">
                {fmtUsd6(walletBalance)}
              </strong>
            </span>
            <span>
              Locked:{' '}
              <strong className="font-mono-num text-[#EBAEE6]">
                {snapshot?.startBalanceLockedAt
                  ? new Date(snapshot.startBalanceLockedAt).toLocaleString()
                  : 'Pending 1st Connect'}
              </strong>
            </span>
          </div>
        </div>
      </div>

      {/* 2. CURRENT EQUITY + 95.000000% CAPITAL DEPLOYMENT GAUGE */}
      <div className="skeuo-chassis relative rounded-2xl p-4 sm:p-5 lg:col-span-7">
        <div className="skeuo-screw !absolute top-2.5 left-2.5" />
        <div className="skeuo-screw !absolute top-2.5 right-2.5" />

        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-[#ADEBB3]" />
            <span className="text-xs font-semibold uppercase tracking-[0.15em] text-[#f4e5e3]">
              Current Equity
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`rounded-full border px-2.5 py-0.5 font-mono-num text-[11px] font-semibold ${
                equityDelta >= 0
                  ? 'border-[#ADEBB3]/45 bg-[#ADEBB3]/15 text-[#ADEBB3]'
                  : 'border-[#FF857A]/45 bg-[#FF857A]/15 text-[#FF857A]'
              }`}
            >
              {fmtSignedUsd6(equityDelta)} ({fmtSigned6(equityDeltaPct)}%)
            </span>
          </div>
        </div>

        <div className="skeuo-oled rounded-xl px-4 py-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-baseline">
            <div className="flex items-baseline gap-2.5">
              <SevenSegmentNumber
                value={fmtUsd2(currentEquity)}
                tone={startLocked && equityDelta < 0 ? 'coral' : 'mint'}
                heightPx={glyphPx}
                label={`Current equity ${fmtUsd6(currentEquity)} USDT, ${
                  equityDelta >= 0 ? 'ahead of' : 'behind'
                } start balance`}
              />
              <span className="font-mono-num text-xs font-semibold text-[#ADEBB3]">
                {fmtUsd6(currentEquity)} USDT LIVE
              </span>
            </div>

            <div className="flex items-center gap-4 text-[11px] text-[#c7a8a5]">
              <span>
                Free Margin:{' '}
                <strong className="font-mono-num text-[#fdf6f5]">
                  {fmtUsd6(availableBalance)}
                </strong>
              </span>
              <span>
                95% Pool Left:{' '}
                <strong className="font-mono-num text-[#EBAEE6]">{fmtUsd6(rem95)}</strong>
              </span>
            </div>
          </div>

          {/* 95% Capital Utilization Bar */}
          <div className="mt-3 border-t border-[#EBAEE6]/10 pt-2.5">
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 text-[#c7a8a5]">
                {marginPaused && <ShieldAlert className="h-3.5 w-3.5 text-[#FF857A]" />}
                <span>
                  95.000000% Balance Execution Pool (Cap: {fmtUsd6(max95)})
                </span>
              </span>
              <span className="font-mono-num font-semibold text-[#fdf6f5]">
                Used {fmtUsd6(usedMargin)} ({fmt6(capPct)}%)
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-black/80 p-[1px] shadow-inner border border-[#EBAEE6]/15">
              <motion.div
                animate={{ width: `${Math.min(100, Math.max(0, (capPct / 95) * 100))}%` }}
                transition={{ type: 'spring', stiffness: 120, damping: 20 }}
                className={`h-full rounded-full ${
                  marginPaused
                    ? 'bg-gradient-to-r from-[#FF857A] to-[#EBAEE6]'
                    : 'bg-gradient-to-r from-[#ADEBB3] via-[#EBAEE6] to-[#FF857A]'
                }`}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Crosshair,
  Flame,
  TrendingDown,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import type { OpenTradePosition } from '../types/hft';
import {
  fmt6,
  fmtSigned6,
  fmtSignedUsd6,
  fmtUsd6,
  formatDurationClock,
} from '../utils/format';

interface OpenTradesDeckProps {
  positions: OpenTradePosition[];
  trailingTriggerRoi: number;
  onManualClose: (symbol: string, positionSide: string) => Promise<boolean>;
}

export const OpenTradesDeck: React.FC<OpenTradesDeckProps> = ({
  positions,
  trailingTriggerRoi,
  onManualClose,
}) => {
  const [closingKey, setClosingKey] = useState<string | null>(null);

  const totalGrossPnl = positions.reduce((acc, p) => acc + p.grossPnl, 0);
  const totalFees = positions.reduce((acc, p) => acc + p.binanceFees, 0);
  const totalNetPnl = positions.reduce((acc, p) => acc + p.netPnl, 0);

  const handleClose = async (pos: OpenTradePosition) => {
    const key = `${pos.symbol}:${pos.positionSide}`;
    setClosingKey(key);
    try {
      await onManualClose(pos.symbol, pos.positionSide);
    } finally {
      setClosingKey(null);
    }
  };

  return (
    <section className="skeuo-chassis relative rounded-2xl p-4 sm:p-5">
      <div className="skeuo-screw !absolute top-2.5 left-2.5" />
      <div className="skeuo-screw !absolute top-2.5 right-2.5" />
      <div className="skeuo-screw !absolute bottom-2.5 left-2.5" />
      <div className="skeuo-screw !absolute bottom-2.5 right-2.5" />

      {/* Section Header */}
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-[#ADEBB3]/40 bg-[#ADEBB3]/15">
            <Activity className="h-4 w-4 text-[#ADEBB3]" />
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 animate-ping rounded-full bg-[#ADEBB3]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-[#fdf6f5]">
                Open Trades
              </h2>
              <span className="rounded-full border border-[#EBAEE6]/45 bg-[#EBAEE6]/20 px-2.5 py-0.5 font-mono-num text-[11px] font-bold text-[#EBAEE6]">
                {positions.length} ACTIVE
              </span>
            </div>
            <p className="text-[11px] text-[#d5b8b5]">
              1.000000s Real-Time Position Check • Trailing Stop Arms at +{fmt6(trailingTriggerRoi)}% ROI
            </p>
          </div>
        </div>

        {/* Live Totals Summary Pill */}
        <div className="skeuo-oled flex flex-wrap items-center gap-4 rounded-xl px-3.5 py-1.5 text-xs">
          <div>
            <span className="text-[#b99895]">Gross PNL: </span>
            <strong
              className={`font-mono-num ${
                totalGrossPnl >= 0 ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
              }`}
            >
              {fmtSignedUsd6(totalGrossPnl)}
            </strong>
          </div>
          <div className="h-3.5 w-px bg-[#EBAEE6]/15" />
          <div>
            <span className="text-[#b99895]">Binance Fees: </span>
            <strong className="font-mono-num text-[#EBAEE6]">{fmtUsd6(totalFees)}</strong>
          </div>
          <div className="h-3.5 w-px bg-[#EBAEE6]/15" />
          <div>
            <span className="text-[#b99895]">Net PNL: </span>
            <strong
              className={`font-mono-num ${
                totalNetPnl >= 0 ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
              }`}
            >
              {fmtSignedUsd6(totalNetPnl)}
            </strong>
          </div>
        </div>
      </div>

      {/* Recessed Smoked-Rosewood OLED Table */}
      <div className="skeuo-oled overflow-x-auto rounded-xl">
        {positions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="mb-2.5 flex h-11 w-11 items-center justify-center rounded-full border border-[#EBAEE6]/25 bg-[#6B403C]/35">
              <Crosshair className="h-5 w-5 text-[#EBAEE6]" />
            </div>
            <p className="text-xs font-semibold uppercase tracking-widest text-[#f2dedc]">
              No Open Positions Currently Running
            </p>
            <p className="mt-1 max-w-md text-[11px] text-[#b99895]">
              When a Top-40 24h mover completes a 15-second pullback + confirmation and Engine is ARMED, live positions appear here with 1.000000s precision updates.
            </p>
          </div>
        ) : (
          <table className="w-full min-w-[1050px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[#EBAEE6]/15 bg-[#241312] text-[10px] font-semibold uppercase tracking-[0.12em] text-[#dec2bf]">
                <th className="py-3 pl-4 pr-3">Asset Name</th>
                <th className="px-3 py-3">Long / Short</th>
                <th className="px-3 py-3 text-right">Entry Price</th>
                <th className="px-3 py-3 text-right">Mark Price</th>
                <th className="px-3 py-3 text-right">ROI (%)</th>
                <th className="px-3 py-3 text-right">PNL (USDT)</th>
                <th className="px-3 py-3 text-right">Binance Fees</th>
                <th className="px-3 py-3 text-right">Net PNL</th>
                <th className="px-3 py-3 text-right">Running Trade Time</th>
                <th className="py-3 pl-3 pr-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EBAEE6]/[0.07]">
              <AnimatePresence initial={false}>
                {positions.map((pos) => {
                  const key = `${pos.symbol}:${pos.positionSide}`;
                  const isLong = pos.side === 'LONG';
                  const roiPositive = pos.roiPct >= 0;
                  const netPositive = pos.netPnl >= 0;

                  return (
                    <motion.tr
                      key={key}
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, height: 0 }}
                      className="transition-colors hover:bg-[#6B403C]/20"
                    >
                      {/* Asset Name */}
                      <td className="py-3 pl-4 pr-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                              netPositive ? 'led-mint led-blink' : 'led-coral led-blink-alarm'
                            } ${pos.trailingActive ? 'led-armed-ring' : ''}`}
                          />
                          <TrendingUp
                            className={`h-3.5 w-3.5 shrink-0 ${
                              netPositive ? 'text-[#ADEBB3]' : 'hidden'
                            }`}
                            aria-hidden="true"
                          />
                          <TrendingDown
                            className={`h-3.5 w-3.5 shrink-0 ${
                              netPositive ? 'hidden' : 'text-[#FF857A]'
                            }`}
                            aria-hidden="true"
                          />
                          <span className="sr-only">
                            {netPositive ? 'net profit' : 'net loss'}
                            {pos.trailingActive ? ', trailing stop armed' : ''}
                          </span>
                          <div>
                            <div className="font-mono-num text-xs font-bold text-white">
                              {pos.symbol}
                            </div>
                            <div className="font-mono-num text-[10px] text-[#b99895]">
                              Margin {fmtUsd6(pos.initialMargin)}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Long / Short + Leverage */}
                      <td className="px-3 py-3">
                        <div className="inline-flex items-center gap-1.5">
                          <span
                            className={`inline-flex items-center gap-0.5 rounded-md border px-2 py-0.5 font-mono-num text-[11px] font-bold ${
                              isLong
                                ? 'border-[#ADEBB3]/50 bg-[#ADEBB3]/18 text-[#ADEBB3]'
                                : 'border-[#FF857A]/50 bg-[#FF857A]/18 text-[#FF857A]'
                            }`}
                          >
                            {isLong ? (
                              <ArrowUpRight className="h-3 w-3" />
                            ) : (
                              <ArrowDownRight className="h-3 w-3" />
                            )}
                            {pos.side}
                          </span>
                          <span className="rounded border border-[#EBAEE6]/40 bg-[#EBAEE6]/15 px-1.5 py-0.5 font-mono-num text-[10px] font-bold text-[#EBAEE6]">
                            {pos.leverage}x
                          </span>
                        </div>
                      </td>

                      {/* Entry Price */}
                      <td className="px-3 py-3 text-right font-mono-num text-[#f2dedc]">
                        {fmt6(pos.entryPrice)}
                      </td>

                      {/* Mark Price */}
                      <td className="px-3 py-3 text-right font-mono-num font-semibold text-white">
                        {fmt6(pos.markPrice)}
                      </td>

                      {/* ROI */}
                      <td className="px-3 py-3 text-right">
                        <div
                          className={`font-mono-num font-bold ${
                            roiPositive ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
                          }`}
                        >
                          {fmtSigned6(pos.roiPct)}%
                        </div>
                        {pos.trailingActive && pos.trailingStopRoiPct !== null ? (
                          <div className="mt-0.5 inline-flex items-center gap-1 rounded border border-[#EBAEE6]/40 bg-[#EBAEE6]/20 px-1.5 py-0.5 font-mono-num text-[9px] font-semibold text-[#EBAEE6]">
                            <Flame className="h-2.5 w-2.5" />
                            TRAIL @ +{fmt6(pos.trailingStopRoiPct)}%
                          </div>
                        ) : (
                          <div className="font-mono-num text-[10px] text-[#b99895]">
                            Peak {fmtSigned6(pos.peakRoiPct)}%
                          </div>
                        )}
                      </td>

                      {/* Gross PNL */}
                      <td
                        className={`px-3 py-3 text-right font-mono-num font-semibold ${
                          pos.grossPnl >= 0 ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
                        }`}
                      >
                        {fmtSignedUsd6(pos.grossPnl)}
                      </td>

                      {/* Binance Platform Fees */}
                      <td className="px-3 py-3 text-right font-mono-num text-[#EBAEE6]">
                        {fmtUsd6(pos.binanceFees)}
                      </td>

                      {/* Net PNL */}
                      <td className="px-3 py-3 text-right">
                        <span
                          className={`inline-block rounded-md border px-2 py-0.5 font-mono-num font-bold ${
                            netPositive
                              ? 'border-[#ADEBB3]/40 bg-[#ADEBB3]/15 text-[#ADEBB3]'
                              : 'border-[#FF857A]/40 bg-[#FF857A]/15 text-[#FF857A]'
                          }`}
                        >
                          {fmtSignedUsd6(pos.netPnl)}
                        </span>
                      </td>

                      {/* Running Trade Time */}
                      <td className="px-3 py-3 text-right font-mono-num text-[11px] text-[#f2dedc]">
                        {formatDurationClock(pos.runningTimeSec)}
                      </td>

                      {/* Manual Close */}
                      <td className="py-3 pl-3 pr-4 text-right">
                        <button
                          type="button"
                          disabled={closingKey === key}
                          onClick={() => handleClose(pos)}
                          className="skeuo-btn inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-[#FF857A] hover:!border-[#FF857A]/60"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          <span>{closingKey === key ? 'Closing...' : 'Close'}</span>
                        </button>
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};

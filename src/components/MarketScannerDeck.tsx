import React, { useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  PauseOctagon,
  Radar,
  Radio,
} from 'lucide-react';
import type { ScannerAsset, ScannerOperatingState } from '../types/hft';
import { fmt6, fmtSigned6 } from '../utils/format';

interface MarketScannerDeckProps {
  positiveAssets: ScannerAsset[];
  negativeAssets: ScannerAsset[];
  scannerState: ScannerOperatingState;
  scannerPauseReason: string | null;
}

const StageBadge: React.FC<{ stage: ScannerAsset['stage']; side: 'LONG' | 'SHORT' }> = ({
  stage,
  side,
}) => {
  if (stage === 'CONFIRMED_SIGNAL') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
          side === 'LONG'
            ? 'border-[#ADEBB3]/60 bg-[#ADEBB3]/20 text-[#ADEBB3]'
            : 'border-[#FF857A]/60 bg-[#FF857A]/20 text-[#FF857A]'
        }`}
      >
        <span className="h-1.5 w-1.5 animate-ping rounded-full bg-current" />
        15s CONFIRMED
      </span>
    );
  }
  if (stage === 'PULLBACK_DETECTED') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EBAEE6]/55 bg-[#EBAEE6]/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#EBAEE6]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#EBAEE6]" />
        PULLBACK ZONE
      </span>
    );
  }
  if (stage === 'IN_POSITION') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#ADEBB3]/50 bg-[#ADEBB3]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#ADEBB3]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#ADEBB3]" />
        OPEN TRADE
      </span>
    );
  }
  if (stage === 'COOLDOWN') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[#FF857A]/25 bg-[#FF857A]/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#FF857A]">
        COOLDOWN
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#c7a8a5]">
      MONITORING
    </span>
  );
};

const ScannerTableBank: React.FC<{
  title: string;
  subtitle: string;
  side: 'LONG' | 'SHORT';
  assets: ScannerAsset[];
}> = ({ title, subtitle, side, assets }) => {
  const isLong = side === 'LONG';

  return (
    <div className="skeuo-plate flex flex-col rounded-xl p-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2.5">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-lg border ${
              isLong
                ? 'border-[#ADEBB3]/50 bg-[#ADEBB3]/20 text-[#ADEBB3]'
                : 'border-[#FF857A]/50 bg-[#FF857A]/20 text-[#FF857A]'
            }`}
          >
            {isLong ? (
              <ArrowUpRight className="h-4 w-4" />
            ) : (
              <ArrowDownRight className="h-4 w-4" />
            )}
          </span>
          <div>
            <h3 className="text-xs font-bold uppercase tracking-[0.13em] text-[#fdf6f5]">
              {title}
            </h3>
            <p className="text-[10px] text-[#e7cecc]">{subtitle}</p>
          </div>
        </div>
        <span
          className={`rounded-md border px-2 py-0.5 font-mono-num text-[10px] font-bold ${
            isLong
              ? 'border-[#ADEBB3]/35 bg-black/40 text-[#ADEBB3]'
              : 'border-[#FF857A]/35 bg-black/40 text-[#FF857A]'
          }`}
        >
          {assets.length} / 20
        </span>
      </div>

      <div className="skeuo-oled max-h-[430px] overflow-auto rounded-lg">
        {assets.length === 0 ? (
          <div className="py-10 text-center text-xs text-[#b99895]">
            Waiting for live Binance USDⓈ-M 24h market stream (`!ticker@arr`)...
          </div>
        ) : (
          <table className="w-full min-w-[540px] border-collapse text-left text-[11px]">
            <thead className="sticky top-0 z-10 border-b border-[#EBAEE6]/15 bg-[#201110] text-[10px] uppercase tracking-wider text-[#dec2bf]">
              <tr>
                <th className="py-2.5 pl-3 pr-2">#</th>
                <th className="px-2 py-2.5">Asset</th>
                <th className="px-2 py-2.5 text-right">24h Change</th>
                <th className="px-2 py-2.5 text-right">Last Price</th>
                <th className="px-2 py-2.5 text-right">15s Pullback</th>
                <th className="px-2 py-2.5 text-right">15s RSI / Δ</th>
                <th className="py-2.5 pl-2 pr-3 text-right">15s Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EBAEE6]/[0.06]">
              {assets.map((asset) => (
                <tr
                  key={asset.symbol}
                  title={asset.lastSignalReason}
                  className="transition-colors hover:bg-[#6B403C]/22"
                >
                  <td className="py-2 pl-3 pr-2 font-mono-num text-[10px] text-[#b99895]">
                    {String(asset.rank).padStart(2, '0')}
                  </td>
                  <td className="px-2 py-2">
                    <div className="font-mono-num font-bold text-[#fdf6f5]">
                      {asset.symbol}
                    </div>
                    <div className="font-mono-num text-[9px] text-[#b99895]">
                      {asset.candleCount15s} bars • {asset.recommendedLeverage}x-15x
                    </div>
                  </td>
                  <td
                    className={`px-2 py-2 text-right font-mono-num font-bold ${
                      isLong ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
                    }`}
                  >
                    {fmtSigned6(asset.priceChangePercent24h)}%
                  </td>
                  <td className="px-2 py-2 text-right font-mono-num text-[#f2dedc]">
                    {fmt6(asset.lastPrice)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono-num text-[#f2dedc]">
                    {fmt6(asset.pullbackDepthPct)}%
                  </td>
                  <td className="px-2 py-2 text-right font-mono-num text-[10px] text-[#f2dedc]">
                    <div>RSI {fmt6(asset.rsi15s)}</div>
                    <div className="text-[#EBAEE6]">Δ {fmt6(asset.orderflowDeltaRatio)}x</div>
                  </td>
                  <td className="py-2 pl-2 pr-3 text-right">
                    <StageBadge stage={asset.stage} side={side} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export const MarketScannerDeck: React.FC<MarketScannerDeckProps> = ({
  positiveAssets,
  negativeAssets,
  scannerState,
  scannerPauseReason,
}) => {
  const [filterTab, setFilterTab] = useState<'BOTH' | 'POSITIVE' | 'NEGATIVE'>('BOTH');

  const isMarginPaused = scannerState === 'PAUSED_MARGIN_FULL';
  const totalAssets = positiveAssets.length + negativeAssets.length;

  return (
    <section className="skeuo-chassis relative rounded-2xl p-4 sm:p-5">
      <div className="skeuo-screw !absolute top-2.5 left-2.5" />
      <div className="skeuo-screw !absolute top-2.5 right-2.5" />
      <div className="skeuo-screw !absolute bottom-2.5 left-2.5" />
      <div className="skeuo-screw !absolute bottom-2.5 right-2.5" />

      {/* Header */}
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2.5">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-lg border ${
              isMarginPaused
                ? 'border-[#FF857A]/50 bg-[#FF857A]/20 text-[#FF857A]'
                : 'border-[#EBAEE6]/50 bg-[#EBAEE6]/20 text-[#EBAEE6]'
            }`}
          >
            <Radar
              className={`h-4 w-4 ${
                scannerState === 'ACTIVE_SCANNING' ? 'animate-spin' : ''
              }`}
              style={
                scannerState === 'ACTIVE_SCANNING' ? { animationDuration: '5s' } : undefined
              }
            />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-[#fdf6f5]">
                24H Market Scanner (40 Max Change Assets)
              </h2>
              <span className="rounded-full border border-[#ADEBB3]/35 bg-[#ADEBB3]/12 px-2.5 py-0.5 font-mono-num text-[11px] font-semibold text-[#ADEBB3]">
                {totalAssets} / 40 ASSETS
              </span>
            </div>
            <p className="text-[11px] text-[#d5b8b5]">
              Top 20 Positive (Pullback → Bullish 15s LONG) & Top 20 Negative (Bounce → Bearish 15s SHORT)
            </p>
          </div>
        </div>

        {/* Tactile Bank Selector */}
        <div className="skeuo-oled flex items-center gap-1 rounded-xl p-1 text-[11px]">
          {(['BOTH', 'POSITIVE', 'NEGATIVE'] as const).map((tab) => {
            const active = filterTab === tab;
            const activeClass =
              tab === 'POSITIVE'
                ? 'bg-[#ADEBB3]/20 text-[#ADEBB3] border border-[#ADEBB3]/50'
                : tab === 'NEGATIVE'
                ? 'bg-[#FF857A]/20 text-[#FF857A] border border-[#FF857A]/50'
                : 'bg-[#EBAEE6]/20 text-[#EBAEE6] border border-[#EBAEE6]/50';

            return (
              <button
                key={tab}
                type="button"
                onClick={() => setFilterTab(tab)}
                className={`rounded-lg px-3 py-1 font-semibold transition-all cursor-pointer ${
                  active ? activeClass : 'text-[#c7a8a5] hover:text-white'
                }`}
              >
                {tab === 'BOTH'
                  ? 'Dual Bank (40)'
                  : tab === 'POSITIVE'
                  ? 'Top 20 Positive'
                  : 'Top 20 Negative'}
              </button>
            );
          })}
        </div>
      </div>

      {/* Hardware Auto-Pause Banner when 95% Balance Deployed or Disconnected */}
      {scannerPauseReason && (
        <div
          className={`mb-4 flex items-center gap-3 rounded-xl border px-4 py-3 text-xs ${
            isMarginPaused
              ? 'border-[#FF857A]/55 bg-[#FF857A]/15 text-[#ffe3e0]'
              : 'border-[#EBAEE6]/25 bg-black/35 text-[#ebdad8]'
          }`}
        >
          {isMarginPaused ? (
            <PauseOctagon className="h-5 w-5 shrink-0 text-[#FF857A]" />
          ) : (
            <Radio className="h-4 w-4 shrink-0 text-[#EBAEE6]" />
          )}
          <span className="leading-relaxed">{scannerPauseReason}</span>
        </div>
      )}

      {/* Dual Bank Grid */}
      <div
        className={`grid grid-cols-1 gap-4 ${
          filterTab === 'BOTH' ? 'xl:grid-cols-2' : ''
        }`}
      >
        {(filterTab === 'BOTH' || filterTab === 'POSITIVE') && (
          <ScannerTableBank
            title="20 Maximum Positive Assets"
            subtitle="Wait for 15s Pullback + Bullish Confirmation → Execute LONG"
            side="LONG"
            assets={positiveAssets}
          />
        )}

        {(filterTab === 'BOTH' || filterTab === 'NEGATIVE') && (
          <ScannerTableBank
            title="20 Maximum Negative Assets"
            subtitle="Wait for 15s Relief Bounce + Bearish Confirmation → Execute SHORT"
            side="SHORT"
            assets={negativeAssets}
          />
        )}
      </div>
    </section>
  );
};

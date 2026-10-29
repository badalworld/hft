import React from 'react';
import {
  Activity,
  BrainCircuit,
  LineChart,
  Power,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Wifi,
} from 'lucide-react';
import type { DashboardSnapshot } from '../types/hft';
import { fmt6 } from '../utils/format';
import type { FeedStatus } from '../hooks/useHftRealtime';
import { HftBrandLogo } from './HftBrandLogo';

const FEED_PRESENTATION: Record<FeedStatus, { label: string; tone: string }> = {
  live: { label: 'LIVE STREAM', tone: 'text-[#ADEBB3]' },
  polling: { label: 'REST POLLING', tone: 'text-[#EBAEE6]' },
  stalled: { label: 'STALL — RECOVERING', tone: 'text-[#FF857A]' },
  offline: { label: 'NO FEED', tone: 'text-[#FF857A]' },
};

interface HeaderChassisProps {
  snapshot: DashboardSnapshot | null;
  wsConnected: boolean;
  feedStatus: FeedStatus;
  actionBusy: boolean;
  errorCount: number;
  onToggleEngine: (next: boolean) => void;
  onOpenPnlLedger: () => void;
  onOpenAiClub: () => void;
  onOpenLogs: () => void;
  onOpenSettings: () => void;
}

export const HeaderChassis: React.FC<HeaderChassisProps> = ({
  snapshot,
  wsConnected,
  feedStatus,
  actionBusy,
  errorCount,
  onToggleEngine,
  onOpenPnlLedger,
  onOpenAiClub,
  onOpenLogs,
  onOpenSettings,
}) => {
  const isRunning = Boolean(snapshot?.engineRunning);
  const apiConnected = Boolean(snapshot?.apiConnected);
  const apiConfigured = Boolean(snapshot?.apiConfigured);
  const weightUsed = snapshot?.rateTelemetry.usedWeight1m ?? 0;
  const weightMax = snapshot?.rateTelemetry.maxWeight1m ?? 2400;
  const weightPct = snapshot?.rateTelemetry.utilizationPct ?? 0;
  const style = snapshot?.styleParams;
  const feed = FEED_PRESENTATION[feedStatus];

  return (
    <header className="skeuo-chassis skeuo-lotus-trim relative overflow-hidden rounded-2xl px-4 pt-4 pb-3.5 sm:px-6">
      {/* Signature 4-Color Lotus Garden Top Enamel Inlay */}
      <div className="lotus-ribbon absolute top-0 left-0 right-0 h-[3px] opacity-95" />

      {/* Corner Machined Rose-Bronze Rivets */}
      <div className="skeuo-screw !absolute top-3 left-2.5 hidden sm:block" />
      <div className="skeuo-screw !absolute top-3 right-2.5 hidden sm:block" />
      <div className="skeuo-screw !absolute bottom-2.5 left-2.5 hidden sm:block" />
      <div className="skeuo-screw !absolute bottom-2.5 right-2.5 hidden sm:block" />

      <div className="flex flex-col gap-3.5 xl:flex-row xl:items-center xl:justify-between">
        {/* Left: Futuristic HFT Candlestick + Breakout Arrow Logo Lockup */}
        <HftBrandLogo isRunning={isRunning} variant="header" />

        {/* Center: Live Telemetry Diode Strip */}
        <div className="skeuo-oled flex flex-wrap items-center gap-4 rounded-xl px-4 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                apiConnected
                  ? 'led-mint'
                  : apiConfigured
                  ? 'led-orchid'
                  : 'led-coral'
              }`}
            />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#b99895]">
                Binance PAPI
              </div>
              <div className="font-mono-num text-[11px] font-semibold text-[#fdf6f5]">
                {apiConnected
                  ? snapshot?.hedgeMode
                    ? 'LIVE (HEDGE)'
                    : 'LIVE (ONE-WAY)'
                  : apiConfigured
                  ? 'CONNECTING'
                  : 'KEYS REQUIRED'}
              </div>
            </div>
          </div>

          <div className="h-6 w-px bg-[#EBAEE6]/15" />

          <div className="flex items-center gap-2">
            <Wifi
              className={`h-3.5 w-3.5 ${
                wsConnected ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
              }`}
            />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#b99895]">
                API Weight (1m)
              </div>
              <div className="font-mono-num text-[11px] font-semibold text-[#fdf6f5]">
                {weightUsed} / {weightMax} ({fmt6(weightPct)}%)
              </div>
            </div>
          </div>

          <div className="h-6 w-px bg-[#EBAEE6]/15" />

          <div className="flex items-center gap-2" role="status" aria-live="polite">
            <Activity
              className={`h-3.5 w-3.5 ${
                feedStatus === 'live' ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
              }`}
            />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#b99895]">
                Dashboard Feed
              </div>
              <div className={`font-mono-num text-[11px] font-semibold ${feed.tone}`}>
                {feed.label}
              </div>
            </div>
          </div>

          <div className="hidden h-6 w-px bg-[#EBAEE6]/15 2xl:block" />

          <div className="hidden items-center gap-2 2xl:flex">
            <ShieldCheck className="h-3.5 w-3.5 text-[#EBAEE6]" />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[#b99895]">
                Ladder & Target
              </div>
              <div className="font-mono-num text-[11px] font-semibold text-[#EBAEE6]">
                ${fmt6(style?.baseMarginUsd ?? 0)} • {style?.minLeverage ?? 0}x→
                {style?.maxLeverage ?? 0}x • +{fmt6(style?.trailingTriggerRoiPct ?? 0)}% Trail
              </div>
            </div>
          </div>
        </div>

        {/* Right: Physical Tactile Rosewood & Lotus Switches */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onOpenPnlLedger}
            className="skeuo-btn flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-[#fdf6f5]"
          >
            <LineChart className="h-4 w-4 text-[#D9A441]" />
            <span>PNL Ledger</span>
            {snapshot && (snapshot.pnlLedger?.stats.totalTrades ?? 0) > 0 && (
              <span
                className={`h-2 w-2 rounded-full ${
                  (snapshot.pnlLedger?.stats.totalNetPnl ?? 0) >= 0 ? 'led-mint' : 'led-coral'
                }`}
                title={`Net settled PNL ${(snapshot.pnlLedger?.stats.totalNetPnl ?? 0).toFixed(6)} USDT`}
              />
            )}
            <span className="rounded-full bg-[#D9A441]/25 px-1.5 py-0.2 font-mono-num text-[10px] font-bold text-[#D9A441]">
              {snapshot?.pnlLedger?.stats.totalTrades ?? 0}
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenAiClub}
            className="skeuo-btn flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-[#fdf6f5]"
          >
            <BrainCircuit className="h-4 w-4 text-[#EBAEE6]" />
            <span>AI Club</span>
            {snapshot && snapshot.styleMutations.length > 0 && (
              <span className="rounded-full bg-[#EBAEE6]/25 px-1.5 py-0.2 font-mono-num text-[10px] font-bold text-[#EBAEE6]">
                {snapshot.styleMutations.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenLogs}
            className="skeuo-btn flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-[#fdf6f5]"
          >
            <ScrollText className="h-4 w-4 text-[#ADEBB3]" />
            <span>Logs</span>
            {errorCount > 0 && (
              <span className="rounded-full bg-[#FF857A]/25 px-1.5 py-0.2 font-mono-num text-[10px] font-bold text-[#FF857A]">
                {errorCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            className="skeuo-btn flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-[#fdf6f5]"
          >
            <Settings
              className={`h-4 w-4 ${
                !apiConfigured ? 'animate-spin text-[#FF857A]' : 'text-[#EBAEE6]'
              }`}
              style={!apiConfigured ? { animationDuration: '8s' } : undefined}
            />
            <span>Settings & IPs</span>
          </button>

          {/* Physical Master Engine Rocker Switch */}
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => onToggleEngine(!isRunning)}
            className={`relative flex items-center gap-2.5 rounded-xl px-4 py-2 text-xs font-bold tracking-wider uppercase transition-all ${
              isRunning ? 'skeuo-btn-mint-armed' : 'skeuo-btn-lotus'
            }`}
          >
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                isRunning ? 'led-mint' : 'bg-[#6B403C] ring-1 ring-[#261110]/40'
              }`}
            />
            {isRunning ? (
              <Power className="h-3.5 w-3.5 text-[#ADEBB3]" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-[#261110]" />
            )}
            <span>{isRunning ? 'ENGINE ARMED' : 'ARM ENGINE'}</span>
          </button>
        </div>
      </div>
    </header>
  );
};

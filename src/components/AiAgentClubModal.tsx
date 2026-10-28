import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  BrainCircuit,
  Cpu,
  GitBranch,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import type {
  DashboardSnapshot,
  LocalDecisionConfig,
  LocalDecisionProvider,
} from '../types/hft';
import { fmt6, fmtSigned6, fmtSignedUsd6 } from '../utils/format';
import { LotusSelect } from './LotusSelect';

interface AiAgentClubModalProps {
  open: boolean;
  snapshot: DashboardSnapshot | null;
  onClose: () => void;
  onUpdateLocalAi: (cfg: Partial<LocalDecisionConfig>) => Promise<void>;
}

export const AiAgentClubModal: React.FC<AiAgentClubModalProps> = ({
  open,
  snapshot,
  onClose,
  onUpdateLocalAi,
}) => {
  const [provider, setProvider] = useState<LocalDecisionProvider>(
    snapshot?.localDecisionConfig.provider || 'builtin'
  );
  const [endpointUrl, setEndpointUrl] = useState(
    snapshot?.localDecisionConfig.endpointUrl || 'http://127.0.0.1:11434'
  );
  const [modelName, setModelName] = useState(
    snapshot?.localDecisionConfig.modelName || 'nimble'
  );

  if (!open) return null;

  const agents = snapshot?.agents ?? [];
  const style = snapshot?.styleParams;
  const weights = snapshot?.system1Weights;
  const mutations = snapshot?.styleMutations ?? [];
  const closedTrades = snapshot?.recentClosedTrades ?? [];

  const handleSaveRuntime = async (e: React.FormEvent) => {
    e.preventDefault();
    await onUpdateLocalAi({ provider, endpointUrl, modelName });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-md sm:p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="skeuo-chassis skeuo-lotus-trim relative max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-2xl p-5 sm:p-6"
      >
        <div className="lotus-ribbon absolute top-0 left-0 right-0 h-[3px]" />

        {/* Header */}
        <div className="mb-5 flex items-center justify-between border-b border-[#EBAEE6]/15 pb-4">
          <div className="flex items-center gap-3">
            <div className="skeuo-oled flex h-10 w-10 items-center justify-center rounded-xl border border-[#EBAEE6]/45">
              <BrainCircuit className="h-5 w-5 text-[#EBAEE6]" />
            </div>
            <div>
              <h2 className="font-crest text-lg font-bold tracking-wider text-lotus-crest">
                SELF-LEARNING AI AGENT CLUB ($0.00 ZERO-COST QUANT COUNCIL)
              </h2>
              <p className="text-xs text-[#d5b8b5]">
                LangGraph Multi-Agent StateGraph + Nimble / Laya / Kev System-1 RLCD Calibration & Autonomous Style Evolution
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="skeuo-btn rounded-xl p-2 text-[#fdf6f5]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Top KPI Strip */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="skeuo-oled rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wider text-[#c7a8a5]">
              Win / Loss Record
            </div>
            <div className="mt-1 font-mono-num text-sm font-bold text-white">
              {snapshot?.winCount ?? 0}W / {snapshot?.lossCount ?? 0}L (
              {fmt6(snapshot?.winRatePct ?? 0)}%)
            </div>
          </div>
          <div className="skeuo-oled rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wider text-[#c7a8a5]">
              Realized Net PNL
            </div>
            <div
              className={`mt-1 font-mono-num text-sm font-bold ${
                (snapshot?.realizedNetPnlTotal ?? 0) >= 0
                  ? 'text-[#ADEBB3]'
                  : 'text-[#FF857A]'
              }`}
            >
              {fmtSignedUsd6(snapshot?.realizedNetPnlTotal ?? 0)}
            </div>
          </div>
          <div className="skeuo-oled rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wider text-[#c7a8a5]">
              System-1 Brier EMA
            </div>
            <div className="mt-1 font-mono-num text-sm font-bold text-[#EBAEE6]">
              {fmt6(weights?.brierScoreEma ?? 0.18)}
            </div>
          </div>
          <div className="skeuo-oled rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wider text-[#c7a8a5]">
              Contrastive Pairs Curated
            </div>
            <div className="mt-1 font-mono-num text-sm font-bold text-[#FF857A]">
              {weights?.contrastivePairsCount ?? 0} JSONL Examples
            </div>
          </div>
        </div>

        <div className="space-y-5">
          {/* 1. 5 SPECIALIZED LANGGRAPH AGENTS */}
          <div className="skeuo-plate rounded-xl p-4">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[#EBAEE6]" />
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                Active 5-Agent LangGraph Quant Club
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {agents.map((ag) => (
                <div key={ag.id} className="skeuo-oled rounded-xl p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full led-mint" />
                      <span className="text-xs font-bold text-white">{ag.name}</span>
                    </div>
                    <span className="rounded bg-[#EBAEE6]/20 px-1.5 py-0.5 font-mono-num text-[10px] font-bold text-[#EBAEE6]">
                      #{ag.decisionsCount}
                    </span>
                  </div>
                  <div className="mt-1 text-[10px] font-medium text-[#FF857A]">
                    {ag.framework} • {ag.role}
                  </div>
                  <p className="mt-2 border-t border-[#EBAEE6]/10 pt-2 font-mono-num text-[11px] leading-relaxed text-[#f2dedc]">
                    {ag.lastAction}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* 2. LIVE SELF-EVOLVING STYLE PARAMETERS */}
          {style && (
            <div className="skeuo-plate rounded-xl p-4">
              <div className="mb-3 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-[#ADEBB3]" />
                <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                  Autonomous Trading Style Parameters (Auto-Adapted After Every Win/Loss)
                </h3>
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">Base Margin / Ladder</div>
                  <div className="font-mono-num text-xs font-bold text-white">
                    ${fmt6(style.baseMarginUsd)} ({style.minLeverage}x→{style.maxLeverage}x)
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">Trailing Start ROI</div>
                  <div className="font-mono-num text-xs font-bold text-[#ADEBB3]">
                    +{fmt6(style.trailingTriggerRoiPct)}%
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">Trailing Callback</div>
                  <div className="font-mono-num text-xs font-bold text-[#EBAEE6]">
                    {fmt6(style.trailingCallbackRoiPct)}% (Floor +{fmt6(style.trailingFloorRoiPct)}%)
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">Protective Stop ROI</div>
                  <div className="font-mono-num text-xs font-bold text-[#FF857A]">
                    {fmt6(style.protectiveStopRoiPct)}%
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">15s Pullback RSI (L / S)</div>
                  <div className="font-mono-num text-xs font-bold text-[#fdf6f5]">
                    ≤{fmt6(style.pullbackRsiLongMax)} / ≥{fmt6(style.pullbackRsiShortMin)}
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">Min AggTrade Delta</div>
                  <div className="font-mono-num text-xs font-bold text-[#fdf6f5]">
                    {fmt6(style.minOrderflowDeltaRatio)}x
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">System-1 Gate Score</div>
                  <div className="font-mono-num text-xs font-bold text-[#EBAEE6]">
                    {fmt6(style.minAiConfidenceScore)}
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">24h Overextension Cap</div>
                  <div className="font-mono-num text-xs font-bold text-[#fdf6f5]">
                    {fmt6(style.max24hOverextensionPct)}%
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 3. CLOSED TRADE POST-MORTEMS & STYLE MUTATION JOURNAL */}
          <div className="skeuo-plate rounded-xl p-4">
            <div className="mb-3 flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-[#FF857A]" />
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                Win / Loss Post-Mortem Analysis & Style Mutations
              </h3>
            </div>

            {closedTrades.length === 0 && mutations.length === 0 ? (
              <div className="skeuo-oled rounded-xl p-5 text-center text-xs text-[#d5b8b5]">
                As soon as your first live Binance trade closes, <strong className="text-[#ADEBB3]">Hermes Post-Mortem Evolver</strong> inspects MFE/MAE excursion, Binance fee drag, and 15s entry tape to report what worked best, what was missed, and automatically upgrades your trading style parameters here.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                {closedTrades.map((t) => (
                  <div key={t.id} className="skeuo-oled rounded-xl p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-mono-num font-bold text-white">
                        {t.symbol} ({t.side} {t.leverage}x) • {t.postMortem.verdict}
                      </div>
                      <div
                        className={`font-mono-num font-bold ${
                          t.netPnl >= 0 ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
                        }`}
                      >
                        Net PNL: {fmtSignedUsd6(t.netPnl)} (ROI {fmtSigned6(t.finalRoiPct)}% | Peak{' '}
                        {fmtSigned6(t.peakRoiPct)}%)
                      </div>
                    </div>
                    <div className="mt-1.5 text-[11px] text-[#ADEBB3]">
                      <strong>Best:</strong> {t.postMortem.whatWorkedBest}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#FF857A]">
                      <strong>Improvement:</strong> {t.postMortem.whatWeMissed}
                    </div>
                    {t.postMortem.styleAdjustments.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {t.postMortem.styleAdjustments.map((adj, idx) => (
                          <span
                            key={idx}
                            className="rounded border border-[#EBAEE6]/40 bg-[#EBAEE6]/15 px-2 py-0.5 font-mono-num text-[10px] text-[#EBAEE6]"
                          >
                            {adj}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 4. ZERO-FEE SYSTEM-1 DECISION ENGINE CONNECTOR (NIMBLE / LAYA / KEV) */}
          <form onSubmit={handleSaveRuntime} className="skeuo-plate rounded-xl p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-[#ADEBB3]" />
                <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                  Zero-Fee System-1 Decision Runtime (Nimble / Laya / Kev / Built-in RLCD)
                </h3>
              </div>
              <span className="font-mono-num text-[11px] text-[#ADEBB3]">
                Latency: {fmt6(snapshot?.localDecisionConfig.lastLatencyMs ?? 0.18)}ms • $0.00 API Cost
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#e7cecc]">
                  Decision Engine Mode
                </label>
                <LotusSelect
                  value={provider}
                  onChange={(next) => setProvider(next as LocalDecisionProvider)}
                  ariaLabel="Decision Engine Mode"
                  className="w-full"
                  options={[
                    {
                      value: 'builtin',
                      label: 'Built-in Quant System-1 RLCD',
                      badge: '0.2ms • $0',
                    },
                    {
                      value: 'ollama_nimble',
                      label: 'Local Ollama (Bespoke-Nimble / Hermes3)',
                      badge: 'FREE',
                    },
                    {
                      value: 'laya_http',
                      label: 'Local Laya HTTP Server (laya[serve])',
                      badge: 'FREE',
                    },
                    {
                      value: 'kev_http',
                      label: 'Local Kev System-One Server (kev-0.8b/4b)',
                      badge: 'FREE',
                    },
                  ]}
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#e7cecc]">
                  Local Endpoint URL
                </label>
                <input
                  type="text"
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  disabled={provider === 'builtin'}
                  className="skeuo-input w-full rounded-xl px-3 py-2 font-mono-num text-xs disabled:opacity-50"
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#e7cecc]">
                  Checkpoint / Model Tag
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    disabled={provider === 'builtin'}
                    className="skeuo-input w-full rounded-xl px-3 py-2 font-mono-num text-xs disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    className="skeuo-btn-lotus shrink-0 rounded-xl px-4 py-2 text-xs"
                  >
                    Apply
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </motion.div>
    </div>
  );
};

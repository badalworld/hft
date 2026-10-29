import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  BrainCircuit,
  Cpu,
  GitBranch,
  Library,
  Megaphone,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { useDialogA11y } from '../hooks/useDialogA11y';
import type {
  AiCouncilBallot,
  DashboardSnapshot,
  LocalDecisionConfig,
  LocalDecisionProvider,
  OperatorDirectiveKind,
} from '../types/hft';
import {
  DIRECTIVE_KINDS,
  DIRECTIVE_LABEL,
  describeDirective,
} from '../../server/ai/operatorDirectives';
import { fmt6, fmtSigned6, fmtSignedUsd6 } from '../utils/format';
import { LotusSelect } from './LotusSelect';

/** Which field each standing order needs before it can be bound. */
const DIRECTIVE_NEEDS: Record<OperatorDirectiveKind, 'symbol' | 'value' | 'nothing'> = {
  STAND_DOWN_ALL: 'nothing',
  STAND_DOWN_SYMBOL: 'symbol',
  BLOCK_LONG: 'nothing',
  BLOCK_SHORT: 'nothing',
  MAX_CONCURRENT_POSITIONS: 'value',
  RSI_GATE: 'value',
  MIN_24H_MOVE: 'value',
  MAX_24H_OVEREXTENSION: 'value',
};

const VALUE_HINT: Partial<Record<OperatorDirectiveKind, { label: string; example: string; hint: string }>> =
  {
    MAX_CONCURRENT_POSITIONS: {
      label: 'Max open positions',
      example: 'e.g. 3',
      hint: 'A new entry is refused while this many slots are already held.',
    },
    RSI_GATE: {
      label: 'RSI 15s limit',
      example: 'e.g. 38',
      hint: 'LONG needs RSI at or below this, SHORT at or above — below the line the dip has reset, above it the same signal is a chase.',
    },
    MIN_24H_MOVE: {
      label: 'Min 24h move %',
      example: 'e.g. 2.5',
      hint: 'Flat names cannot pay a 15x round trip in fees; refuse anything that has not actually moved.',
    },
    MAX_24H_OVEREXTENSION: {
      label: 'Max 24h move %',
      example: 'e.g. 45',
      hint: 'Past this the move is spent and the exit liquidity is gone — the next entrant is the exit.',
    },
  };

const CouncilBallots: React.FC<{ ballots: AiCouncilBallot[] }> = ({ ballots }) => (
  <div className="mt-2 space-y-1.5">
    {ballots.map((b) => (
      <div
        key={b.param}
        className={`skeuo-oled rounded-lg border px-2.5 py-2 ${
          b.approved ? 'border-[#ADEBB3]/40' : 'border-[#FF857A]/35'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span
            className={`font-mono-num text-[11px] font-bold ${
              b.approved ? 'text-[#ADEBB3]' : 'text-[#FF857A] line-through decoration-[#FF857A]/60'
            }`}
          >
            {b.change}
          </span>
          <span className="font-mono-num text-[10px] uppercase tracking-wider text-[#EBAEE6]">
            {b.forCount}/{b.votes.length} council
          </span>
        </div>
        <ul className="mt-1 space-y-0.5">
          {b.votes.map((v) => (
            <li key={v.agent} className="flex gap-1.5 text-[10px] leading-tight">
              <span
                className={`shrink-0 font-bold ${
                  v.vote === 'FOR' ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
                }`}
              >
                {v.vote === 'FOR' ? '+' : '−'}
              </span>
              <span className="shrink-0 font-semibold text-[#fdf6f5]">{v.agentName}:</span>
              <span className="text-[#c7a8a5]">{v.why}</span>
            </li>
          ))}
        </ul>
      </div>
    ))}
  </div>
);

/** Every directive/note route answers with the same envelope. */
interface BriefingResult {
  ok?: boolean;
  message?: string;
}

interface AiAgentClubModalProps {
  open: boolean;
  snapshot: DashboardSnapshot | null;
  onClose: () => void;
  onUpdateLocalAi: (cfg: Partial<LocalDecisionConfig>) => Promise<{ ok: boolean; message: string }>;
  onSetOrderFlowMode: (mode: 'shadow' | 'enforce') => Promise<BriefingResult>;
  onAddDirective: (d: {
    kind: OperatorDirectiveKind;
    symbol?: string;
    value?: number;
    reason?: string;
  }) => Promise<BriefingResult>;
  onToggleDirective: (id: string, active: boolean) => Promise<BriefingResult>;
  onAddNote: (text: string) => Promise<BriefingResult>;
  onRemoveNote: (id: string) => Promise<BriefingResult>;
}

export const AiAgentClubModal: React.FC<AiAgentClubModalProps> = ({
  open,
  snapshot,
  onClose,
  onUpdateLocalAi,
  onSetOrderFlowMode,
  onAddDirective,
  onToggleDirective,
  onAddNote,
  onRemoveNote,
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

  const [ruleKind, setRuleKind] = useState<OperatorDirectiveKind>('MAX_24H_OVEREXTENSION');
  const [ruleSymbol, setRuleSymbol] = useState('');
  const [ruleValue, setRuleValue] = useState('');
  const [ruleReason, setRuleReason] = useState('');
  const [noteText, setNoteText] = useState('');
  const [briefingError, setBriefingError] = useState('');
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const { panelRef, titleId } = useDialogA11y(open, onClose, 'hft-ai-club-title');

  // The live vault config outranks the defaults captured on first mount, or a saved endpoint
  // would silently revert in the form every time the panel is reopened.
  useEffect(() => {
    if (!open) return;
    const cfg = snapshot?.localDecisionConfig;
    if (!cfg) return;
    setProvider(cfg.provider);
    setEndpointUrl(cfg.endpointUrl);
    setModelName(cfg.modelName);
    setRuntimeMessage(null);
  }, [open, snapshot?.localDecisionConfig]);

  if (!open) return null;

  const agents = snapshot?.agents ?? [];
  const style = snapshot?.styleParams;
  const weights = snapshot?.system1Weights;
  const mutations = snapshot?.styleMutations ?? [];
  const closedTrades = snapshot?.recentClosedTrades ?? [];
  const directives = snapshot?.operatorDirectives ?? [];
  const notes = snapshot?.operatorNotes ?? [];
  const activeRuleCount = directives.filter((d) => d.active).length;
  const hasRuleField = DIRECTIVE_NEEDS[ruleKind] !== 'nothing';

  const handleSaveRuntime = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = await onUpdateLocalAi({ provider, endpointUrl, modelName });
    setRuntimeMessage({
      ok: out.ok,
      text: out.ok
        ? `Applied: ${provider} on ${endpointUrl}.`
        : out.message || 'The server refused that runtime.',
    });
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setBriefingError('');
    const needs = DIRECTIVE_NEEDS[ruleKind];
    const symbol = ruleSymbol.trim().toUpperCase();
    const value = Number(ruleValue);
    if (needs === 'symbol' && !/^[A-Z0-9]{5,20}USDT$/.test(symbol)) {
      setBriefingError('Enter a full USDT pair, e.g. DOGEUSDT.');
      return;
    }
    if (needs === 'value' && (ruleValue.trim() === '' || !Number.isFinite(value))) {
      setBriefingError('This rule needs a numeric threshold.');
      return;
    }
    setBriefingBusy(true);
    const res = await onAddDirective({
      kind: ruleKind,
      symbol: needs === 'symbol' ? symbol : undefined,
      value: needs === 'value' ? value : undefined,
      reason: ruleReason.trim() || undefined,
    });
    setBriefingBusy(false);
    if (res?.ok !== true) {
      setBriefingError(res?.message || 'Could not bind that rule.');
      return;
    }
    setRuleSymbol('');
    setRuleValue('');
    setRuleReason('');
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    setBriefingError('');
    const text = noteText.trim();
    if (text.length < 4) {
      setBriefingError('Write a sentence the agents can act on.');
      return;
    }
    setBriefingBusy(true);
    const res = await onAddNote(text);
    setBriefingBusy(false);
    if (res?.ok !== true) {
      setBriefingError(res?.message || 'Could not save that briefing.');
      return;
    }
    setNoteText('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-md sm:p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="skeuo-chassis skeuo-lotus-trim relative max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-2xl p-5 focus:outline-none sm:p-6"
      >
        <div className="lotus-ribbon absolute top-0 left-0 right-0 h-[3px]" />

        {/* Header */}
        <div className="mb-5 flex items-center justify-between border-b border-[#EBAEE6]/15 pb-4">
          <div className="flex items-center gap-3">
            <div className="skeuo-oled flex h-10 w-10 items-center justify-center rounded-xl border border-[#EBAEE6]/45">
              <BrainCircuit className="h-5 w-5 text-[#EBAEE6]" />
            </div>
            <div>
              <h2
                id={titleId}
                className="font-crest text-lg font-bold tracking-wider text-lotus-crest"
              >
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
            aria-label="Close the AI Agent Club panel"
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

          {/* 2b. ORDER FLOW LAYER — OBI, CVD, LIQUIDITY & ABSORPTION */}
          {style && snapshot?.orderFlow && (
            <div className="skeuo-plate rounded-xl p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-[#D9A441]" />
                  <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                    Order Flow Layer — Book Imbalance · Executed Delta · Absorption
                  </h3>
                </div>
                <div className="skeuo-oled flex items-center gap-1 rounded-xl p-1 text-[10px]">
                  {(['shadow', 'enforce'] as const).map((m) => {
                    const active = snapshot.orderFlow.mode === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          if (active || briefingBusy) return;
                          setBriefingBusy(true);
                          onSetOrderFlowMode(m).finally(() => setBriefingBusy(false));
                        }}
                        aria-pressed={active}
                        title={
                          m === 'shadow'
                            ? 'Score and log every verdict; never block an entry.'
                            : 'A non-confirming book/tape verdict vetoes the entry.'
                        }
                        className={`rounded-lg px-2.5 py-1 font-bold uppercase tracking-wider transition-all cursor-pointer ${
                          active
                            ? m === 'enforce'
                              ? 'bg-[#FF857A]/20 text-[#FF857A] border border-[#FF857A]/50'
                              : 'bg-[#EBAEE6]/20 text-[#EBAEE6] border border-[#EBAEE6]/50'
                            : 'text-[#a98b88] hover:text-white'
                        }`}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">Depth / Tape Feed</div>
                  <div className="font-mono-num text-xs font-bold">
                    <span className={snapshot.orderFlow.depthLive ? 'text-[#ADEBB3]' : 'text-[#FF857A]'}>
                      BOOK {snapshot.orderFlow.depthLive ? 'LIVE' : 'DEAD'}
                    </span>
                    <span className="text-[#a98b88]"> · </span>
                    <span className={snapshot.orderFlow.tapeLive ? 'text-[#ADEBB3]' : 'text-[#FF857A]'}>
                      TAPE {snapshot.orderFlow.tapeLive ? 'LIVE' : 'DEAD'}
                    </span>
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">Live Books / Watched</div>
                  <div className="font-mono-num text-xs font-bold text-[#fdf6f5]">
                    {snapshot.orderFlow.liveBooks} / {snapshot.orderFlow.watchedSymbols}
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">Would-Enter / Would-Block</div>
                  <div className="font-mono-num text-xs font-bold">
                    <span className="text-[#ADEBB3]">{snapshot.orderFlow.confirmed}</span>
                    <span className="text-[#a98b88]"> / </span>
                    <span className="text-[#FF857A]">{snapshot.orderFlow.blocked}</span>
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">OBI Floor · Aggressor Ratio</div>
                  <div className="font-mono-num text-xs font-bold text-[#EBAEE6]">
                    ±{fmt6(style.orderFlowMinObi)} · {fmt6(style.orderFlowMinVolumeRatio)}x
                  </div>
                </div>
                <div className="skeuo-oled rounded-lg p-2.5">
                  <div className="text-[10px] text-[#c7a8a5]">Flow Window · Absorption</div>
                  <div className="font-mono-num text-xs font-bold text-[#fdf6f5]">
                    {Math.round(style.orderFlowWindowSec)}s ·{' '}
                    {fmt6(style.orderFlowAbsorptionMultiple)}x
                  </div>
                </div>
                <div className="skeuo-oled col-span-2 rounded-lg p-2.5 sm:col-span-3">
                  <div className="text-[10px] text-[#c7a8a5]">Refusals by gate since boot</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {Object.keys(snapshot.orderFlow.byVerdict).length === 0 ? (
                      <span className="font-mono-num text-[11px] text-[#a98b88]">
                        No 15s trigger has reached the flow gate yet.
                      </span>
                    ) : (
                      Object.entries(snapshot.orderFlow.byVerdict).map(([verdict, count]) => (
                        <span
                          key={verdict}
                          className={`rounded border px-1.5 py-[1px] font-mono-num text-[10px] ${
                            verdict === 'CONFIRM'
                              ? 'border-[#ADEBB3]/45 bg-[#ADEBB3]/12 text-[#ADEBB3]'
                              : 'border-[#EBAEE6]/30 bg-black/35 text-[#e7cecc]'
                          }`}
                        >
                          {verdict} {count}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <p className="mt-2.5 text-[10px] leading-relaxed text-[#b99895]">
                Six gates run on every 15s trigger, in this order: fee-plus-spread cost, book
                imbalance, executed delta level and slope, aggressive buy/sell ratio, price
                location in the window's range, and absorption. In{' '}
                <strong className="text-[#EBAEE6]">shadow</strong> the verdict is
                scored and written to the tape but never blocks. In{' '}
                <strong className="text-[#FF857A]">enforce</strong> a non-confirming verdict vetoes
                the entry and puts the symbol on a 20s cooldown. These thresholds are starting
                hypotheses the council may tune — one capped step at a time.
              </p>
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

                    {t.postMortem.autopsy && (
                      <div className="mt-2 rounded-lg border border-[#FF857A]/35 bg-[#FF857A]/[0.07] p-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded border border-[#FF857A]/50 bg-[#FF857A]/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#FF857A]">
                            Loss autopsy — {t.postMortem.autopsy.rootCauseLabel}
                          </span>
                          <span className="font-mono-num text-[10px] text-[#b99895]">
                            {t.postMortem.autopsy.rootCause}
                          </span>
                        </div>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-[#f4e5e3]">
                          {t.postMortem.autopsy.whyItHappened}
                        </p>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-[#ADEBB3]">
                          <strong>Rule now carried:</strong>{' '}
                          {t.postMortem.autopsy.avoidanceRule}
                        </p>
                        <p className="mt-1 text-[11px] leading-relaxed text-[#EBAEE6]">
                          <strong>Execution update:</strong>{' '}
                          {t.postMortem.autopsy.executionUpdate}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-[#FF857A]/20 pt-1.5 font-mono-num text-[10px] text-[#b99895]">
                          <span>fee hurdle {fmt6(t.postMortem.autopsy.evidence.feeHurdleRoiPct)}% ROI</span>
                          <span>MFE {fmt6(t.postMortem.autopsy.evidence.peakRoiPct)}%</span>
                          <span>MAE {fmt6(t.postMortem.autopsy.evidence.worstRoiPct)}%</span>
                          <span>move {fmt6(t.postMortem.autopsy.evidence.underlyingMovePct)}%</span>
                          <span>held {fmt6(t.postMortem.autopsy.evidence.durationSec)}s</span>
                        </div>
                        {t.postMortem.autopsy.contributingCauses.length > 0 && (
                          <div className="mt-1 text-[10px] text-[#a58784]">
                            Also present: {t.postMortem.autopsy.contributingCauses.join(', ')}
                          </div>
                        )}
                      </div>
                    )}

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

                    {t.postMortem.councilBallots && t.postMortem.councilBallots.length > 0 ? (
                      <>
                        <div className="mt-2 text-[11px] text-[#fdf6f5]">
                          <strong className="uppercase tracking-wider text-[#D9A441]">
                            Club discussion:
                          </strong>{' '}
                          {t.postMortem.agentConsensusSummary}
                        </div>
                        <CouncilBallots ballots={t.postMortem.councilBallots} />
                        {t.postMortem.nextStep && (
                          <div className="mt-1.5 text-[11px] text-[#EBAEE6]">
                            <strong>Next step:</strong> {t.postMortem.nextStep}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="mt-2 text-[10px] italic text-[#a58784]">
                        Settled before the improvement council was wired in — no ballots on record.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 3b. SHARED MEMORY — what every agent recalls before it votes */}
          <div className="skeuo-plate rounded-xl p-4">
            <div className="mb-3 flex items-center gap-2">
              <Library className="h-4 w-4 text-[#D9A441]" />
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                Shared Memory — Recalled by Every Agent on Entry
              </h3>
            </div>

            {(snapshot?.lessonPatterns ?? []).length === 0 ? (
              <div className="skeuo-oled rounded-xl p-4 text-center text-[11px] text-[#d5b8b5]">
                No settled trades have been absorbed yet. The first post-mortem writes the first
                lesson, and from then on every entry gate reads it before it votes.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {(snapshot?.lessonPatterns ?? []).slice(0, 8).map((p) => (
                  <div
                    key={p.key}
                    className="skeuo-oled flex flex-wrap items-center justify-between gap-1.5 rounded-lg px-2.5 py-2"
                  >
                    <span className="font-mono-num text-[10px] font-bold text-[#fdf6f5]">
                      {p.key}
                    </span>
                    <span className="font-mono-num text-[10px] text-[#c7a8a5]">
                      {p.sampleCount} trade{p.sampleCount === 1 ? '' : 's'} •{' '}
                      <span className={p.winRatePct >= 50 ? 'text-[#ADEBB3]' : 'text-[#FF857A]'}>
                        {fmt6(p.winRatePct)}%
                      </span>{' '}
                      • {fmtSignedUsd6(p.netPnlTotal)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {(snapshot?.lessons ?? []).length > 0 && (
              <div className="mt-3 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                {(snapshot?.lessons ?? []).slice(0, 6).map((l) => (
                  <div key={l.id} className="skeuo-oled rounded-lg px-2.5 py-2 text-[10px]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono-num font-bold text-white">
                        {l.symbol} ({l.side})
                      </span>
                      <span
                        className={`font-mono-num font-bold ${
                          l.netPnl >= 0 ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
                        }`}
                      >
                        {fmtSignedUsd6(l.netPnl)}
                      </span>
                      <span className="text-[#D9A441]">{l.verdict}</span>
                    </div>
                    <div className="mt-0.5 text-[#c7a8a5]">{l.miss}</div>
                    {l.appliedAdjustments.length > 0 && (
                      <div className="mt-1 font-mono-num text-[9px] text-[#EBAEE6]">
                        taught: {l.appliedAdjustments.join(' • ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 3c. OPERATOR BRIEFING — the human's direct channel into the club */}
          <div className="skeuo-plate skeuo-lotus-trim rounded-xl p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="skeuo-oled flex h-7 w-7 items-center justify-center rounded-lg border border-[#EBAEE6]/40">
                  <Megaphone className="h-3.5 w-3.5 text-[#EBAEE6]" />
                </div>
                <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                  Operator Briefing — Direct Channel to the Club
                </h3>
              </div>
              <span className="font-mono-num text-[10px] text-[#EBAEE6]">
                {activeRuleCount} binding rule{activeRuleCount === 1 ? '' : 's'} • {notes.length}{' '}
                briefing{notes.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="skeuo-oled rounded-lg border-l-2 border-l-[#ADEBB3] px-2.5 py-2 text-[10px] leading-relaxed text-[#c7a8a5]">
                <span className="font-mono-num font-bold uppercase tracking-wider text-[#ADEBB3]">
                  Binding
                </span>{' '}
                — the club can approve an entry, but it cannot outvote a standing order. The veto is
                logged and counted per rule.
              </div>
              <div className="skeuo-oled rounded-lg border-l-2 border-l-[#EBAEE6] px-2.5 py-2 text-[10px] leading-relaxed text-[#c7a8a5]">
                <span className="font-mono-num font-bold uppercase tracking-wider text-[#EBAEE6]">
                  Advisory
                </span>{' '}
                — your read on the tape, quoted into Alpha Scout and Leverage Architect before they
                vote. Never gates an order.
              </div>
            </div>

            {/* Standing orders in force */}
            {directives.length === 0 ? (
              <div className="skeuo-oled mb-3 rounded-xl px-3 py-3 text-center text-[11px] text-[#d5b8b5]">
                No standing orders. Bind one below — it applies to the very next 15s candle.
              </div>
            ) : (
              <div className="mb-3 max-h-48 space-y-1.5 overflow-y-auto pr-1">
                {directives.map((d) => (
                  <div
                    key={d.id}
                    className="skeuo-oled flex flex-wrap items-start justify-between gap-2 rounded-lg px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            d.active ? 'led-mint' : 'led-off'
                          }`}
                        />
                        <span className="font-mono-num text-[10px] font-bold text-[#fdf6f5]">
                          {describeDirective(d)}
                        </span>
                        {d.appliedCount > 0 && (
                          <span className="rounded border border-[#D9A441]/45 bg-[#D9A441]/15 px-1.5 py-0.5 font-mono-num text-[9px] text-[#D9A441]">
                            blocked {d.appliedCount} entr{d.appliedCount === 1 ? 'y' : 'ies'}
                          </span>
                        )}
                      </div>
                      {d.reason && (
                        <p className="mt-0.5 text-[10px] italic leading-snug text-[#c7a8a5]">
                          “{d.reason}”
                        </p>
                      )}
                      <p className="mt-0.5 font-mono-num text-[9px] text-[#a58784]">
                        {d.active ? 'in force' : 'lifted'}
                        {d.lastAppliedAt
                          ? ` • last veto ${new Date(d.lastAppliedAt).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}`
                          : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onToggleDirective(d.id, !d.active)}
                      className={`skeuo-btn shrink-0 rounded-lg px-2.5 py-1 font-mono-num text-[10px] ${
                        d.active ? 'text-[#FF857A]' : 'text-[#ADEBB3]'
                      }`}
                    >
                      {d.active ? 'Lift' : 'Re-activate'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleAddRule} className="grid grid-cols-1 gap-2.5 sm:grid-cols-12">
              <div className={hasRuleField ? 'sm:col-span-4' : 'sm:col-span-5'}>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#e7cecc]">
                  Standing order
                </label>
                <LotusSelect
                  value={ruleKind}
                  onChange={(next) => setRuleKind(next as OperatorDirectiveKind)}
                  ariaLabel="Standing order type"
                  className="w-full"
                  options={DIRECTIVE_KINDS.map((k) => ({
                    value: k,
                    label: DIRECTIVE_LABEL[k],
                    badge:
                      DIRECTIVE_NEEDS[k] === 'symbol'
                        ? 'SYMBOL'
                        : DIRECTIVE_NEEDS[k] === 'value'
                        ? 'THRESHOLD'
                        : 'INSTANT',
                  }))}
                />
              </div>

              {DIRECTIVE_NEEDS[ruleKind] === 'symbol' && (
                <div className="sm:col-span-3">
                  <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#e7cecc]">
                    Symbol
                  </label>
                  <input
                    type="text"
                    value={ruleSymbol}
                    onChange={(e) => setRuleSymbol(e.target.value.toUpperCase())}
                    placeholder="DOGEUSDT"
                    className="skeuo-input w-full rounded-xl px-3 py-2 font-mono-num text-xs"
                  />
                </div>
              )}

              {DIRECTIVE_NEEDS[ruleKind] === 'value' && (
                <div className="sm:col-span-3">
                  <label className="mb-1 block truncate text-[10px] uppercase tracking-wider text-[#e7cecc]">
                    {VALUE_HINT[ruleKind]?.label ?? 'Threshold'}
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={ruleValue}
                    onChange={(e) => setRuleValue(e.target.value)}
                    placeholder={VALUE_HINT[ruleKind]?.example}
                    className="skeuo-input w-full rounded-xl px-3 py-2 font-mono-num text-xs"
                  />
                </div>
              )}

              <div className={hasRuleField ? 'sm:col-span-3' : 'sm:col-span-4'}>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-[#e7cecc]">
                  Why (quoted in every veto)
                </label>
                <input
                  type="text"
                  value={ruleReason}
                  onChange={(e) => setRuleReason(e.target.value)}
                  placeholder="e.g. this name prints headlines, not setups"
                  className="skeuo-input w-full rounded-xl px-3 py-2 text-xs"
                />
              </div>

              <div className={hasRuleField ? 'sm:col-span-2' : 'sm:col-span-3'}>
                <button
                  type="submit"
                  disabled={briefingBusy}
                  className="skeuo-btn w-full rounded-xl px-3 py-2 font-mono-num text-[11px] font-bold text-[#ADEBB3] disabled:opacity-50"
                >
                  Bind rule
                </button>
              </div>
            </form>

            {DIRECTIVE_NEEDS[ruleKind] === 'value' && VALUE_HINT[ruleKind]?.hint && (
              <p className="mt-1.5 text-[10px] text-[#a58784]">{VALUE_HINT[ruleKind]?.hint}</p>
            )}

            {/* Advisory briefings */}
            <div className="mt-4 border-t border-[#EBAEE6]/15 pt-3">
              <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#EBAEE6]">
                Market Read for the Agents
              </h4>
              {notes.length > 0 && (
                <div className="mb-2 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                  {notes.map((n) => (
                    <div
                      key={n.id}
                      className="skeuo-oled flex items-start justify-between gap-2 rounded-lg px-2.5 py-2"
                    >
                      <p className="min-w-0 flex-1 text-[11px] leading-snug text-[#f4e4e2]">
                        {n.text}
                      </p>
                      <span className="shrink-0 font-mono-num text-[9px] text-[#a58784]">
                        {new Date(n.createdAt).toLocaleDateString([], {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={() => onRemoveNote(n.id)}
                        aria-label="Remove briefing"
                        className="shrink-0 rounded p-0.5 text-[#a58784] hover:text-[#FF857A]"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form onSubmit={handleAddNote} className="flex flex-col gap-2 sm:flex-row">
                <textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  rows={2}
                  placeholder="e.g. BTC is bleeding into the US cash open — treat long pullbacks as counter-trend and size half"
                  className="skeuo-input min-w-0 flex-1 rounded-xl px-3 py-2 text-xs leading-snug"
                />
                <button
                  type="submit"
                  disabled={briefingBusy}
                  className="skeuo-btn shrink-0 rounded-xl px-3 py-2 font-mono-num text-[11px] font-bold text-[#EBAEE6] disabled:opacity-50"
                >
                  Brief the club
                </button>
              </form>
              {briefingError && (
                <p className="mt-1.5 font-mono-num text-[10px] text-[#FF857A]">{briefingError}</p>
              )}
            </div>
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
            {runtimeMessage && (
              <p
                role="status"
                className={`mt-2 font-mono-num text-[10px] ${
                  runtimeMessage.ok ? 'text-[#ADEBB3]' : 'text-[#FF857A]'
                }`}
              >
                {runtimeMessage.text}
              </p>
            )}
          </form>
        </div>
      </motion.div>
    </div>
  );
};

export type LogLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'EXEC' | 'AI';

export interface LogEntry {
  id: string;
  timestamp: number;
  isoTime: string;
  level: LogLevel;
  module: 'ENGINE' | 'BINANCE_API' | 'SCANNER' | 'CANDLE_15S' | 'MONITOR_1S' | 'EXECUTION' | 'AI_CLUB' | 'NETWORK';
  message: string;
  meta?: Record<string, unknown>;
}

export interface SymbolPrecisionFilter {
  symbol: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: number;
  tickDecimals: number;
  stepSize: number;
  stepDecimals: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
}

export interface Candle15s {
  symbol: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
  isClosed: boolean;
}

export type SignalStage =
  | 'MONITORING'
  | 'PULLBACK_DETECTED'
  | 'CONFIRMED_SIGNAL'
  | 'IN_POSITION'
  | 'COOLDOWN';

export interface ScannerAsset {
  symbol: string;
  directionBucket: 'POSITIVE_TOP20' | 'NEGATIVE_TOP20';
  intendedSide: 'LONG' | 'SHORT';
  rank: number;
  priceChangePercent24h: number;
  lastPrice: number;
  markPrice: number;
  high24h: number;
  low24h: number;
  quoteVolume24h: number;
  stage: SignalStage;
  rsi15s: number;
  ema9: number;
  ema21: number;
  pullbackDepthPct: number;
  orderflowDeltaRatio: number;
  aiConfidence: number;
  recommendedLeverage: number;
  candleCount15s: number;
  lastSignalReason: string;
  updatedAt: number;
}

export interface EntryFeatureVector {
  rsi15s: number;
  emaSpreadPct: number;
  pullbackDepthPct: number;
  orderflowDeltaRatio: number;
  candleBodyRatio: number;
  wickRejectionRatio: number;
  absChange24hPct: number;
  volatilityAtrPct: number;
  aiConfidence: number;
  leverageUsed: number;
}

export interface OpenTradePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  quantity: number;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  initialMargin: number;
  notionalValue: number;
  roiPct: number;
  grossPnl: number;
  binanceFees: number;
  netPnl: number;
  commissionRate: number;
  openedAt: number;
  runningTimeSec: number;
  trailingActive: boolean;
  peakRoiPct: number;
  worstRoiPct: number;
  trailingStopRoiPct: number | null;
  protectiveStopRoiPct: number;
  lastCheckedAt: number;
  entryFeatures?: EntryFeatureVector;
}

export interface AiPostMortemAnalysis {
  verdict: 'WIN_OPTIMAL' | 'WIN_EARLY_TRAIL' | 'LOSS_PREMATURE_PULLBACK' | 'LOSS_MOMENTUM_REVERSAL' | 'FEE_DRAG_BREAKEVEN';
  whatWorkedBest: string;
  whatWeMissed: string;
  styleAdjustments: string[];
  mfeCaptureRatio: number;
  brierLoss: number;
  agentConsensusSummary: string;
}

export interface ClosedTradeRecord {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  leverage: number;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  initialMargin: number;
  grossPnl: number;
  binanceFees: number;
  netPnl: number;
  finalRoiPct: number;
  peakRoiPct: number;
  worstRoiPct: number;
  openedAt: number;
  closedAt: number;
  durationSec: number;
  exitReason: string;
  entryFeatures: EntryFeatureVector;
  postMortem: AiPostMortemAnalysis;
}

export interface AdaptiveStyleParams {
  baseMarginUsd: number;              // Fixed $2.000000 per trade
  minLeverage: number;                // 10x
  maxLeverage: number;                // 15x
  capitalUtilizationCapPct: number;   // 95.000000%
  trailingTriggerRoiPct: number;      // 5.000000% ROI starts trailing stop
  trailingFloorRoiPct: number;        // Minimum locked ROI once trailing starts
  trailingCallbackRoiPct: number;     // Dynamic callback % behind peak ROI
  protectiveStopRoiPct: number;       // Protective max loss ROI % before 5% target
  pullbackRsiLongMax: number;         // Max 15s RSI during pullback for LONG
  pullbackRsiShortMin: number;        // Min 15s RSI during bounce for SHORT
  minOrderflowDeltaRatio: number;     // Buyer/Seller aggTrade volume confirmation ratio
  minConfirmationBodyRatio: number;   // Candle body / range conviction ratio
  max24hOverextensionPct: number;     // Filter extreme blow-off tops/bottoms if whipsawing
  cooldownSecondsAfterLoss: number;   // Per-symbol cooldown after loss
  minAiConfidenceScore: number;       // System-1 probability gate (0..1)
}

export type LocalDecisionProvider = 'builtin' | 'ollama_nimble' | 'laya_http' | 'kev_http';

export interface LocalDecisionConfig {
  provider: LocalDecisionProvider;
  endpointUrl: string;
  modelName: string;
  lastLatencyMs: number;
  lastStatus: string;
}

export interface AgentMemberStatus {
  id: string;
  name: string;
  role: string;
  framework: string;
  decisionsCount: number;
  lastAction: string;
  lastUpdatedAt: number;
  active: boolean;
}

export interface StyleMutationRecord {
  id: string;
  timestamp: number;
  symbol: string;
  tradeOutcome: 'WIN' | 'LOSS';
  netPnl: number;
  parameterChanges: Array<{
    param: string;
    before: number;
    after: number;
    reason: string;
  }>;
  summary: string;
}

export interface System1Weights {
  bias: number;
  rsiAlignment: number;
  pullbackQuality: number;
  orderflowDelta: number;
  candleConviction: number;
  wickRejection: number;
  momentum24hSweetSpot: number;
  volatilityHealth: number;
  temperature: number;
  brierScoreEma: number;
  totalUpdates: number;
  contrastivePairsCount: number;
}

export interface NetworkInterfaceIpv4 {
  interfaceName: string;
  localIpv4: string;
  netmask: string;
  isPublicRoutableNic: boolean;
  detectedEgressIpv4: string | null;
  isPrimaryRoute: boolean;
}

export interface ServerIpReport {
  whitelistPublicIpv4s: string[];
  interfaces: NetworkInterfaceIpv4[];
  boundLocalAddress: string | null;
  lastScannedAt: number;
  environmentHint: 'LOCALHOST_NAT' | 'SINGLE_IP_SERVER' | 'MULTI_IP_SERVER';
  notes: string[];
}

export interface ApiRateTelemetry {
  usedWeight1m: number;
  maxWeight1m: number;
  utilizationPct: number;
  orderCount10s: number;
  maxOrders10s: number;
  orderCount1m: number;
  maxOrders1m: number;
  wsConnected: boolean;
  userDataStreamConnected: boolean;
  wsStreamsCount: number;
  avgRestLatencyMs: number;
  serverTimeOffsetMs: number;
}

export type ScannerOperatingState =
  | 'DISCONNECTED'
  | 'ACTIVE_SCANNING'
  | 'PAUSED_MARGIN_FULL'
  | 'PAUSED_BOT_STOPPED';

export interface DashboardSnapshot {
  botName: string;
  copyright: string;
  timestamp: number;
  engineRunning: boolean;
  apiConfigured: boolean;
  apiConnected: boolean;
  maskedApiKey: string;
  hedgeMode: boolean;

  // Balance & Equity (All formatted to 0.000000 in UI)
  startBalance: number;
  startBalanceLocked: boolean;
  startBalanceLockedAt: number | null;
  currentEquity: number;
  walletBalance: number;
  availableBalance: number;
  unrealizedPnlTotal: number;
  usedMarginTotal: number;
  maxDeployable95Margin: number;
  remainingDeployable95Margin: number;
  capitalUtilizationPct: number;

  // Scanner & Open Positions
  scannerState: ScannerOperatingState;
  scannerPauseReason: string | null;
  openPositions: OpenTradePosition[];
  positiveAssets: ScannerAsset[];
  negativeAssets: ScannerAsset[];

  // AI Self-Learning Club
  styleParams: AdaptiveStyleParams;
  system1Weights: System1Weights;
  localDecisionConfig: LocalDecisionConfig;
  agents: AgentMemberStatus[];
  recentClosedTrades: ClosedTradeRecord[];
  styleMutations: StyleMutationRecord[];
  winCount: number;
  lossCount: number;
  winRatePct: number;
  realizedNetPnlTotal: number;

  // API Rate & System Telemetry
  rateTelemetry: ApiRateTelemetry;
  ipReport: ServerIpReport;
}

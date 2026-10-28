import fs from 'node:fs';
import path from 'node:path';
import type {
  EntryFeatureVector,
  LocalDecisionConfig,
  System1Weights,
} from '../types.js';
import { clamp } from '../utils/format.js';

export interface System1TypedDecision {
  noulExecute: boolean; // Kev/Nimble binary yes/no gate
  choiceAction: 'EXECUTE_NOW' | 'HOLD_FOR_DEEPER_PULLBACK' | 'VETO_OVEREXTENDED';
  calibratedScore: number; // Temperature-calibrated probability [0..1]
  recommendedLeverage: number; // 10..15
  latencyMs: number;
  source: string;
}

export function createDefaultSystem1Weights(): System1Weights {
  return {
    bias: 0.12,
    rsiAlignment: 0.55,
    pullbackQuality: 0.65,
    orderflowDelta: 0.78,
    candleConviction: 0.52,
    wickRejection: 0.38,
    momentum24hSweetSpot: 0.42,
    volatilityHealth: 0.35,
    temperature: 1.0,
    brierScoreEma: 0.18,
    totalUpdates: 0,
    contrastivePairsCount: 0,
  };
}

function sigmoid(z: number): number {
  if (z > 20) return 0.999999;
  if (z < -20) return 0.000001;
  return 1 / (1 + Math.exp(-z));
}

function normalizeFeatures(
  side: 'LONG' | 'SHORT',
  f: EntryFeatureVector
): {
  xRsi: number;
  xPullback: number;
  xDelta: number;
  xBody: number;
  xWick: number;
  xMom24h: number;
  xVol: number;
} {
  // Ideal pullback RSI: for LONG ~38-48 (oversold micro dip in strong 24h uptrend), for SHORT ~52-62
  const idealRsi = side === 'LONG' ? 44 : 56;
  const rsiDist = Math.abs(f.rsi15s - idealRsi);
  const xRsi = clamp(1 - rsiDist / 28, -1, 1);

  // Ideal 15s pullback depth: 0.12% to 0.85%
  const xPullback =
    f.pullbackDepthPct >= 0.08 && f.pullbackDepthPct <= 1.2
      ? clamp(f.pullbackDepthPct / 0.45, 0.2, 1)
      : f.pullbackDepthPct > 1.2
      ? 0.1
      : -0.3;

  // Orderflow delta ratio > 1.2 is bullish/bearish aggressive confirmation
  const xDelta = clamp((f.orderflowDeltaRatio - 1.0) / 0.85, -1, 1);

  // Candle body / range ratio
  const xBody = clamp((f.candleBodyRatio - 0.35) / 0.45, -1, 1);

  // Supporting rejection wick
  const xWick = clamp(f.wickRejectionRatio / 0.45, -0.5, 1);

  // 24h momentum sweet spot: 8%..45% strong trend; >80% has higher snapback risk
  const xMom24h =
    f.absChange24hPct >= 6 && f.absChange24hPct <= 48
      ? 0.75
      : f.absChange24hPct > 75
      ? -0.45
      : 0.25;

  // Micro ATR% health: enough movement to clear 5% leveraged ROI (>0.07% price move = >0.7%..1% -> 10x = 7..10% ROI)
  const xVol = f.volatilityAtrPct >= 0.06 && f.volatilityAtrPct <= 0.9 ? 0.65 : -0.25;

  return { xRsi, xPullback, xDelta, xBody, xWick, xMom24h, xVol };
}

export class System1DecisionEngine {
  private contrastiveFile = path.resolve(
    process.cwd(),
    'data',
    'nimble_kev_training_pairs.jsonl'
  );

  constructor() {
    try {
      fs.mkdirSync(path.dirname(this.contrastiveFile), { recursive: true });
    } catch {
      // ignore
    }
  }

  public async decide(params: {
    symbol: string;
    side: 'LONG' | 'SHORT';
    features: EntryFeatureVector;
    weights: System1Weights;
    minConfidence: number;
    max24hOverextensionPct: number;
    minNotional: number;
    baseMarginUsd: number;
    config: LocalDecisionConfig;
  }): Promise<System1TypedDecision> {
    const t0 = performance.now();
    const {
      symbol,
      side,
      features,
      weights,
      minConfidence,
      max24hOverextensionPct,
      minNotional,
      baseMarginUsd,
      config,
    } = params;

    const norm = normalizeFeatures(side, features);

    const logit =
      weights.bias +
      weights.rsiAlignment * norm.xRsi +
      weights.pullbackQuality * norm.xPullback +
      weights.orderflowDelta * norm.xDelta +
      weights.candleConviction * norm.xBody +
      weights.wickRejection * norm.xWick +
      weights.momentum24hSweetSpot * norm.xMom24h +
      weights.volatilityHealth * norm.xVol;

    const temp = clamp(weights.temperature, 0.5, 2.5);
    let prob = sigmoid(logit / temp);
    let source = 'builtin-system1-rlcd';

    // Optional Zero-Cost Local Nimble / Laya / Kev HTTP forward pass (<140ms budget for HFT)
    if (config.provider !== 'builtin' && config.endpointUrl) {
      const localScore = await this.tryLocalDecisionServer(symbol, side, features, config);
      if (localScore !== null) {
        // Ensemble 60% calibrated RLCD + 40% local System-1 checkpoint
        prob = clamp(0.6 * prob + 0.4 * localScore, 0.000001, 0.999999);
        source = `${config.provider}:${config.modelName}`;
      }
    }

    // Select base leverage 10x - 15x based on asset minNotional & micro-volatility
    const minLevForNotional = Math.ceil((minNotional * 1.02) / Math.max(0.5, baseMarginUsd));
    let volatilityLeverage = 10;
    if (features.volatilityAtrPct < 0.12 && prob >= 0.72) volatilityLeverage = 13;
    else if (features.volatilityAtrPct < 0.18 && prob >= 0.65) volatilityLeverage = 12;
    else if (features.volatilityAtrPct < 0.25 && prob >= 0.6) volatilityLeverage = 11;
    else volatilityLeverage = 10;

    // Note: Execution Engine still begins at 10x (or required leverage in 10..15) and steps 10->11->12->13->14->15 on any failure!
    const recommendedLeverage = clamp(Math.max(10, Math.min(15, Math.max(10, Math.min(minLevForNotional, 15), volatilityLeverage >= 10 ? 10 : 10))), 10, 15);

    let choiceAction: System1TypedDecision['choiceAction'] = 'HOLD_FOR_DEEPER_PULLBACK';
    if (features.absChange24hPct > max24hOverextensionPct && prob < minConfidence + 0.12) {
      choiceAction = 'VETO_OVEREXTENDED';
    } else if (prob >= minConfidence) {
      choiceAction = 'EXECUTE_NOW';
    }

    const latencyMs = performance.now() - t0;
    config.lastLatencyMs = latencyMs;
    config.lastStatus = `OK (${source})`;

    return {
      noulExecute: choiceAction === 'EXECUTE_NOW',
      choiceAction,
      calibratedScore: prob,
      recommendedLeverage,
      latencyMs,
      source,
    };
  }

  /**
   * Online RLCD (Reinforcement Learning against Strictly Proper Brier Scoring Rule)
   * Updates System-1 weights after every real WIN or LOSS trade + writes Nimble/Kev contrastive JSONL!
   */
  public learnFromOutcome(params: {
    symbol: string;
    side: 'LONG' | 'SHORT';
    features: EntryFeatureVector;
    weights: System1Weights;
    wonNetAfterFees: boolean;
    netPnl: number;
    peakRoiPct: number;
    worstRoiPct: number;
  }): { updatedWeights: System1Weights; brierLoss: number } {
    const { symbol, side, features, weights, wonNetAfterFees, netPnl, peakRoiPct, worstRoiPct } =
      params;
    const norm = normalizeFeatures(side, features);
    const targetY = wonNetAfterFees ? 1.0 : 0.0;
    const predP = clamp(features.aiConfidence, 0.01, 0.99);

    // Strictly proper Brier loss = (p - y)^2
    const brierLoss = Math.pow(predP - targetY, 2);

    // Gradient step minimizing Brier / log-loss with L2 regularization toward stable priors
    const lr = 0.045;
    const err = targetY - predP;

    const next: System1Weights = {
      ...weights,
      bias: clamp(weights.bias + lr * err * 0.5, -0.6, 0.6),
      rsiAlignment: clamp(weights.rsiAlignment + lr * err * norm.xRsi, 0.1, 1.5),
      pullbackQuality: clamp(weights.pullbackQuality + lr * err * norm.xPullback, 0.1, 1.5),
      orderflowDelta: clamp(weights.orderflowDelta + lr * err * norm.xDelta, 0.15, 1.8),
      candleConviction: clamp(weights.candleConviction + lr * err * norm.xBody, 0.1, 1.4),
      wickRejection: clamp(weights.wickRejection + lr * err * norm.xWick, 0.05, 1.2),
      momentum24hSweetSpot: clamp(
        weights.momentum24hSweetSpot + lr * err * norm.xMom24h,
        0.05,
        1.2
      ),
      volatilityHealth: clamp(weights.volatilityHealth + lr * err * norm.xVol, 0.05, 1.2),
      temperature: clamp(
        weights.temperature + (brierLoss > 0.25 ? 0.02 : -0.008),
        0.7,
        1.8
      ),
      brierScoreEma: weights.brierScoreEma * 0.9 + brierLoss * 0.1,
      totalUpdates: weights.totalUpdates + 1,
      contrastivePairsCount: weights.contrastivePairsCount + 1,
    };

    // Curate free Nimble / Kev / Laya typed decision example on disk
    const record = {
      ts: new Date().toISOString(),
      text: `Symbol=${symbol} Side=${side} 24hChg=${features.absChange24hPct.toFixed(4)}% RSI15s=${features.rsi15s.toFixed(4)} Pullback=${features.pullbackDepthPct.toFixed(4)}% OrderflowDelta=${features.orderflowDeltaRatio.toFixed(4)} BodyRatio=${features.candleBodyRatio.toFixed(4)} ATR15s=${features.volatilityAtrPct.toFixed(4)}%`,
      questions: [
        {
          type: 'noul',
          question: 'Does this 15s pullback confirmation achieve >=5% ROI net profit after Binance fees?',
          label: wonNetAfterFees,
        },
      ],
      outcome: { netPnl, peakRoiPct, worstRoiPct, brierLoss },
    };
    fs.promises
      .appendFile(this.contrastiveFile, JSON.stringify(record) + '\n', 'utf8')
      .catch(() => {});

    return { updatedWeights: next, brierLoss };
  }

  private async tryLocalDecisionServer(
    symbol: string,
    side: 'LONG' | 'SHORT',
    f: EntryFeatureVector,
    config: LocalDecisionConfig
  ): Promise<number | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 130); // Strict 130ms HFT budget

    try {
      const promptDoc = `HFT 15s Signal: ${symbol} ${side}, 24hMove=${f.absChange24hPct.toFixed(2)}%, RSI7=${f.rsi15s.toFixed(1)}, Pullback=${f.pullbackDepthPct.toFixed(3)}%, DeltaRatio=${f.orderflowDeltaRatio.toFixed(2)}, BodyRatio=${f.candleBodyRatio.toFixed(2)}.`;

      if (config.provider === 'laya_http' || config.provider === 'kev_http') {
        const res = await fetch(`${config.endpointUrl.replace(/\/$/, '')}/v1/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: promptDoc,
            questions: [
              {
                id: 'execute_gate',
                type: 'noul',
                question: 'Will this pullback confirmation reach 5% leveraged ROI before stop?',
              },
            ],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const json = (await res.json()) as {
          answers?: Array<{ probability?: number; score?: number }>;
          probability?: number;
        };
        const p = json.answers?.[0]?.probability ?? json.answers?.[0]?.score ?? json.probability;
        return typeof p === 'number' && Number.isFinite(p) ? clamp(p, 0, 1) : null;
      }

      if (config.provider === 'ollama_nimble') {
        const res = await fetch(`${config.endpointUrl.replace(/\/$/, '')}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.modelName || 'nimble',
            prompt: `${promptDoc}\nAnswer YES or NO only:`,
            stream: false,
            options: { num_predict: 2, temperature: 0 },
          }),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { response?: string };
        const txt = (json.response || '').trim().toUpperCase();
        if (txt.startsWith('YES')) return 0.78;
        if (txt.startsWith('NO')) return 0.25;
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

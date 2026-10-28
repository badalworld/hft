import type { ApiRateTelemetry } from '../types.js';
import { logger } from '../utils/logger.js';

export type RequestPriority =
  | 'P0_CRITICAL_EXIT'
  | 'P1_EXECUTION_POSITION'
  | 'P2_ACCOUNT_SYNC'
  | 'P3_BACKGROUND_SCAN';

export class BinanceRateGovernor {
  private usedWeight1m = 0;
  private readonly maxWeight1m = 2400; // Binance USDⓈ-M Futures standard IP/UID 1m weight limit
  private orderCount10s = 0;
  private readonly maxOrders10s = 300;
  private orderCount1m = 0;
  private readonly maxOrders1m = 1200;
  private backoffUntil = 0;
  private lastMinuteBucket = Math.floor(Date.now() / 60_000);
  private latencySamples: number[] = [];
  public wsConnected = false;
  public userDataStreamConnected = false;
  public wsStreamsCount = 0;
  public serverTimeOffsetMs = 0;

  private refreshBucketIfNeeded() {
    const bucket = Math.floor(Date.now() / 60_000);
    if (bucket !== this.lastMinuteBucket) {
      this.lastMinuteBucket = bucket;
      this.usedWeight1m = Math.max(0, Math.floor(this.usedWeight1m * 0.15));
      this.orderCount1m = 0;
    }
  }

  public async acquireSlot(priority: RequestPriority, estimatedWeight = 1): Promise<boolean> {
    this.refreshBucketIfNeeded();
    const now = Date.now();

    if (now < this.backoffUntil && priority !== 'P0_CRITICAL_EXIT') {
      return false;
    }

    const projected = this.usedWeight1m + estimatedWeight;
    const ratio = projected / this.maxWeight1m;

    if (priority === 'P0_CRITICAL_EXIT') {
      this.usedWeight1m = projected;
      return true;
    }
    if (priority === 'P1_EXECUTION_POSITION' && ratio <= 0.96) {
      this.usedWeight1m = projected;
      return true;
    }
    if (priority === 'P2_ACCOUNT_SYNC' && ratio <= 0.88) {
      this.usedWeight1m = projected;
      return true;
    }
    if (priority === 'P3_BACKGROUND_SCAN' && ratio <= 0.78) {
      this.usedWeight1m = projected;
      return true;
    }

    return false;
  }

  public recordHeaders(headers: Record<string, string | string[] | undefined>, latencyMs: number) {
    this.refreshBucketIfNeeded();

    const w1m = headers['x-mbx-used-weight-1m'];
    if (w1m !== undefined) {
      const parsed = parseInt(Array.isArray(w1m) ? w1m[0] : w1m, 10);
      if (Number.isFinite(parsed)) this.usedWeight1m = parsed;
    }

    const o10s = headers['x-mbx-order-count-10s'];
    if (o10s !== undefined) {
      const parsed = parseInt(Array.isArray(o10s) ? o10s[0] : o10s, 10);
      if (Number.isFinite(parsed)) this.orderCount10s = parsed;
    }

    const o1m = headers['x-mbx-order-count-1m'];
    if (o1m !== undefined) {
      const parsed = parseInt(Array.isArray(o1m) ? o1m[0] : o1m, 10);
      if (Number.isFinite(parsed)) this.orderCount1m = parsed;
    }

    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      this.latencySamples.push(latencyMs);
      if (this.latencySamples.length > 40) this.latencySamples.shift();
    }
  }

  public triggerRateLimitBackoff(retryAfterSec = 5, statusCode = 429) {
    this.backoffUntil = Date.now() + retryAfterSec * 1000;
    logger.warn(
      'BINANCE_API',
      `HTTP ${statusCode} rate-limit signal received from Binance. Cooling non-critical calls for ${retryAfterSec}s while keeping P0 trade exits armed.`
    );
  }

  public getTelemetry(): ApiRateTelemetry {
    this.refreshBucketIfNeeded();
    const avgLatency =
      this.latencySamples.length > 0
        ? this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length
        : 0;

    return {
      usedWeight1m: this.usedWeight1m,
      maxWeight1m: this.maxWeight1m,
      utilizationPct: Math.min(100, (this.usedWeight1m / this.maxWeight1m) * 100),
      orderCount10s: this.orderCount10s,
      maxOrders10s: this.maxOrders10s,
      orderCount1m: this.orderCount1m,
      maxOrders1m: this.maxOrders1m,
      wsConnected: this.wsConnected,
      userDataStreamConnected: this.userDataStreamConnected,
      wsStreamsCount: this.wsStreamsCount,
      avgRestLatencyMs: avgLatency,
      serverTimeOffsetMs: this.serverTimeOffsetMs,
    };
  }
}

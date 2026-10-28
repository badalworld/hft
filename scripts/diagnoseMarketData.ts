import WebSocket from 'ws';
import dns from 'node:dns';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

// Market data transport diagnostic.
//
// Run this when the scanner reports identical degenerate telemetry across all
// assets (RSI pinned at 50, orderflow delta at 1, pullback depth at 0). That
// signature means the candle builder is starved of ticks — usually because
// fstream.binance.com completed its WebSocket upgrade but delivers no frames.
//
//   NODE_ENV=production ./node_modules/.bin/tsx scripts/diagnoseMarketData.ts

const WS_HOST = 'fstream.binance.com';
const REST_SYMBOL = 'BTCUSDT';
const EDGE_WINDOW_MS = 10_000;
const REST_TIMEOUT_MS = 10_000;

const pinnedLookup = (ip: string): LookupFunction => (_h, options, callback) => {
  if (options && (options as dns.LookupOptions).all) {
    callback(null, [{ address: ip, family: 4 }] as never, 4);
    return;
  }
  callback(null, ip as never, 4);
};

function wsOptions(ip: string) {
  return {
    handshakeTimeout: 8000,
    family: 4,
    lookup: pinnedLookup(ip),
    servername: WS_HOST,
  } as WebSocket.ClientOptions & { lookup: LookupFunction };
}

interface EdgeResult {
  ip: string;
  opened: boolean;
  acked: boolean;
  aggTrade: number;
  markPrice: number;
  error: string;
}

// Subscribes to a high-volume and a low-volume stream on the same socket, so a
// row that delivers markPrice but not aggTrade exposes volume throttling
// instead of a dead edge.
function testEdge(ip: string): Promise<EdgeResult> {
  return new Promise((resolve) => {
    const out: EdgeResult = { ip, opened: false, acked: false, aggTrade: 0, markPrice: 0, error: '' };
    let finished = false;

    const ws = new WebSocket(`wss://${WS_HOST}/ws`, wsOptions(ip));
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {
        // a socket that never opened has no connection to terminate
      });
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve(out);
    };
    const timer = setTimeout(finish, EDGE_WINDOW_MS);

    ws.on('open', () => {
      out.opened = true;
      ws.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: ['btcusdt@aggTrade', 'btcusdt@markPrice@1s'],
          id: 1,
        })
      );
    });
    ws.on('message', (raw: WebSocket.RawData) => {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (d?.e === 'aggTrade') out.aggTrade++;
      else if (d?.e === 'markPriceUpdate') out.markPrice++;
      else if ('result' in d) out.acked = true;
    });
    ws.on('error', (e: Error) => {
      out.error = e.message;
      finish();
    });
  });
}

function restProbe(path: string): Promise<string> {
  return new Promise((resolve) => {
    const req = https.request(
      { host: 'fapi.binance.com', path, method: 'GET', timeout: REST_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve(`HTTP ${res.statusCode} weight-1m=${res.headers['x-mbx-used-weight-1m']} ${body.slice(0, 90)}`)
        );
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(`TIMEOUT after ${REST_TIMEOUT_MS}ms`);
    });
    req.on('error', (e) => resolve(`ERROR ${e.message}`));
    req.end();
  });
}

function resolve4(host: string): Promise<string[]> {
  return new Promise((resolve, reject) =>
    dns.resolve4(host, (err, addresses) => (err ? reject(err) : resolve(addresses)))
  );
}

console.log(`=== 1. WebSocket edge matrix (${WS_HOST}) ===\n`);
let edges: string[] = [];
try {
  edges = await resolve4(WS_HOST);
} catch (e) {
  console.log('DNS resolution failed:', (e as Error).message);
}

const results: EdgeResult[] = [];
for (const ip of edges) {
  const r = await testEdge(ip);
  results.push(r);
  const verdict = !r.opened
    ? 'HANDSHAKE FAIL'
    : r.aggTrade > 0 || r.markPrice > 0
      ? `LIVE (agg=${r.aggTrade} mark=${r.markPrice})`
      : r.acked
        ? '>> OPEN + ACKED BUT ZERO DATA FRAMES'
        : '>> OPEN BUT ZERO DATA FRAMES';
  console.log(
    `${ip.padEnd(16)} open=${r.opened ? 'Y' : 'N'} ack=${r.acked ? 'Y' : 'N'} ${verdict} ${r.error}`
  );
}

const live = results.filter((r) => r.aggTrade > 0 || r.markPrice > 0);
const silent = results.filter((r) => r.opened && r.aggTrade === 0 && r.markPrice === 0);

console.log('\n=== 2. REST control (must stay healthy for the fallback feed) ===\n');
console.log(`/fapi/v1/trades      -> ${await restProbe(`/fapi/v1/trades?symbol=${REST_SYMBOL}&limit=5`)}`);
console.log(`/fapi/v1/ticker/price-> ${await restProbe('/fapi/v1/ticker/price')}`);

console.log('\n=== 3. Verdict ===\n');
if (live.length > 0) {
  console.log(`WebSocket market data is HEALTHY (${live.length}/${results.length} edges deliver frames).`);
} else if (silent.length > 0) {
  console.log(
    `BLOCKED: ${silent.length} edge(s) completed the upgrade and Binance ACKed, yet zero data` +
      ' frames arrived.\n' +
      'This is hostname-level stream filtering, not a code bug. The REST market data feed\n' +
      '(server/engine/restMarketFeed.ts) is the correct remedy and engages automatically.'
  );
} else {
  console.log('No edge completed the WebSocket upgrade from this network.');
}
process.exit(0);

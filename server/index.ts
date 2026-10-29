import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { HftBotEngine } from './engine/hftBotEngine.js';
import { DIRECTIVE_KINDS } from './ai/operatorDirectives.js';
import type { OperatorDirectiveKind } from './types.js';
import { logger } from './utils/logger.js';
import { isValidIpv4 } from './utils/ipDiscovery.js';
import { lightenSnapshot } from './utils/streamFrame.js';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Ensure iframe preview & multi-host server compatibility
  app.use((_req, res, next) => {
    res.removeHeader('X-Frame-Options');
    next();
  });

  const engine = new HftBotEngine();

  // --- REST API ROUTES ---

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      bot: 'HFT',
      developer: 'Trading Lifestyle Quant.',
      timestamp: Date.now(),
    });
  });

  app.get('/api/snapshot', (_req, res) => {
    res.json(engine.getSnapshot());
  });

  app.post('/api/engine/toggle', async (req, res) => {
    try {
      const running = Boolean(req.body?.running);
      const out = await engine.setEngineRunning(running);
      res.json(out);
    } catch (err) {
      res.status(500).json({ running: false, message: (err as Error).message });
    }
  });

  app.post('/api/settings/credentials', async (req, res) => {
    try {
      const apiKey = String(req.body?.apiKey ?? '');
      const apiSecret = String(req.body?.apiSecret ?? '');
      const result = await engine.saveAndConnectApiKeys(apiKey, apiSecret);
      res.json({ ...result, snapshot: engine.getSnapshot() });
    } catch (err) {
      res.status(500).json({ connected: false, message: (err as Error).message });
    }
  });

  app.post('/api/settings/reset-start-balance', (_req, res) => {
    const out = engine.resetStartBalance();
    res.json({ ...out, snapshot: engine.getSnapshot() });
  });

  app.post('/api/settings/rescan-ips', async (_req, res) => {
    const ipReport = await engine.refreshIpDiscovery();
    res.json({ ipReport });
  });

  app.post('/api/settings/bind-ip', async (req, res) => {
    const raw = req.body?.localAddress ? String(req.body.localAddress).trim() : null;
    if (raw !== null && !isValidIpv4(raw)) {
      res.status(400).json({ ok: false, message: `"${raw}" is not an IPv4 address. Choose a discovered interface or clear the binding.` });
      return;
    }
    const ipReport = await engine.setBoundLocalAddress(raw);
    res.json({ ipReport });
  });

  app.post('/api/settings/local-ai', (req, res) => {
    const out = engine.updateLocalDecisionConfig({
      provider: req.body?.provider,
      endpointUrl: req.body?.endpointUrl,
      modelName: req.body?.modelName,
    });
    if (out.rejected.length > 0) {
      res.status(400).json({ ok: false, rejected: out.rejected, snapshot: engine.getSnapshot() });
      return;
    }
    res.json({ ok: true, snapshot: engine.getSnapshot() });
  });

  app.post('/api/settings/style-params', (req, res) => {
    const out = engine.updateStyleParams(req.body || {});
    if (out.accepted.length === 0 && out.rejected.length > 0) {
      res.status(400).json({ ok: false, rejected: out.rejected, snapshot: engine.getSnapshot() });
      return;
    }
    res.json({ ok: true, accepted: out.accepted, rejected: out.rejected, snapshot: engine.getSnapshot() });
  });

  const NUMERIC_DIRECTIVES = new Set<OperatorDirectiveKind>([
    'MAX_CONCURRENT_POSITIONS',
    'RSI_GATE',
    'MIN_24H_MOVE',
    'MAX_24H_OVEREXTENSION',
  ]);

  app.post('/api/settings/directives', (req, res) => {
    const kind = req.body?.kind as OperatorDirectiveKind;
    if (!DIRECTIVE_KINDS.includes(kind)) {
      res.status(400).json({ ok: false, message: `Unknown directive kind: ${String(kind)}` });
      return;
    }
    const symbolRaw = typeof req.body?.symbol === 'string' ? req.body.symbol.trim() : '';
    if (kind === 'STAND_DOWN_SYMBOL' && !/^[A-Z0-9]{5,20}USDT$/i.test(symbolRaw)) {
      res.status(400).json({ ok: false, message: 'A symbol stand-down needs a valid USDT symbol.' });
      return;
    }
    const value = typeof req.body?.value === 'number' ? req.body.value : Number(req.body?.value);
    if (NUMERIC_DIRECTIVES.has(kind) && !Number.isFinite(value)) {
      res.status(400).json({ ok: false, message: `${kind} needs a numeric threshold.` });
      return;
    }
    const directive = engine.addOperatorDirective({
      kind,
      symbol: symbolRaw || undefined,
      value: NUMERIC_DIRECTIVES.has(kind) ? value : undefined,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : '',
    });
    res.json({ ok: true, directive, snapshot: engine.getSnapshot() });
  });

  app.post('/api/settings/directives/toggle', (req, res) => {
    const id = String(req.body?.id || '');
    const active = Boolean(req.body?.active);
    const ok = engine.setOperatorDirectiveActive(id, active);
    if (!ok) {
      res.status(404).json({ ok: false, message: 'Directive not found.' });
      return;
    }
    res.json({ ok, snapshot: engine.getSnapshot() });
  });

  app.post('/api/settings/notes', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const note = engine.addOperatorNote(text);
    if (!note) {
      res.status(400).json({ ok: false, message: 'Briefing text is empty.' });
      return;
    }
    res.json({ ok: true, note, snapshot: engine.getSnapshot() });
  });

  app.post('/api/settings/notes/remove', (req, res) => {
    const ok = engine.removeOperatorNote(String(req.body?.id || ''));
    if (!ok) {
      res.status(404).json({ ok: false, message: 'Briefing not found.' });
      return;
    }
    res.json({ ok, snapshot: engine.getSnapshot() });
  });

  app.post('/api/positions/close', async (req, res) => {
    const symbol = String(req.body?.symbol || '');
    const positionSide = String(req.body?.positionSide || 'BOTH');
    const pos = engine
      .getSnapshot()
      .openPositions.find((p) => p.symbol === symbol && p.positionSide === positionSide);
    if (!pos) {
      res.status(404).json({ ok: false, message: 'Open position not found.' });
      return;
    }
    const ok = await engine.closePositionNow(pos, 'MANUAL_OPERATOR_CLOSE');
    res.json({ ok, snapshot: engine.getSnapshot() });
  });

  app.get('/api/logs', (req, res) => {
    const limit = Math.min(1500, parseInt(String(req.query.limit || '500'), 10) || 500);
    const level = req.query.level ? String(req.query.level) : 'ALL';
    const mod = req.query.module ? String(req.query.module) : 'ALL';
    res.json({ logs: logger.getLogs(limit, level, mod) });
  });

  app.post('/api/logs/clear', (_req, res) => {
    logger.clearMemoryLogs();
    res.json({ ok: true, logs: logger.getLogs(100) });
  });

  app.get('/api/logs/export', (_req, res) => {
    const text = logger.exportPlainText();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="hft-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log"`
    );
    res.send(text);
  });

  const httpServer = http.createServer(app);

  // --- REAL-TIME WEBSOCKET SERVER (/ws) ---
  const wss = new WebSocketServer({ noServer: true });

  interface StreamClient {
    ws: WebSocket;
    /** The ledger version this client already holds, so heavy blocks travel once per change. */
    ledgerVersion: number;
    alive: boolean;
    behindFrames: number;
  }

  const wsClients = new Set<StreamClient>();
  const MAX_BUFFERED_BYTES = 1_000_000;

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url?.split('?')[0] || '';
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Leave other upgrade paths (such as Vite HMR in dev) untouched!
  });

  function sendFrame(client: StreamClient, payload: string): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    // A backgrounded or throttled tab stops draining its send queue. Skipping its frames keeps
    // memory off the trading process, and a client that never catches up is dropped so it can
    // reconnect with a clean snapshot instead of streaming into a black hole.
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.behindFrames += 1;
      if (client.behindFrames > 30) {
        logger.warn(
          'NETWORK',
          'Dashboard client could not keep up with the live stream and was disconnected; it reconnects with a fresh snapshot.'
        );
        client.ws.terminate();
        wsClients.delete(client);
      }
      return;
    }
    client.behindFrames = 0;
    try {
      client.ws.send(payload);
    } catch {
      // ignore
    }
  }

  wss.on('connection', (ws) => {
    const client: StreamClient = { ws, ledgerVersion: -1, alive: true, behindFrames: 0 };
    wsClients.add(client);

    const full = engine.getSnapshot();
    client.ledgerVersion = full.ledgerVersion;
    try {
      ws.send(
        JSON.stringify({
          type: 'INIT',
          snapshot: full,
          logs: logger.getLogs(250),
        })
      );
    } catch {
      // ignore
    }

    ws.on('pong', () => {
      client.alive = true;
    });

    // The browser cannot see WebSocket protocol pings, so the dashboard's own application
    // heartbeat is what proves the duplex path still carries data.
    ws.on('message', (data) => {
      client.alive = true;
      let msg: { type?: string };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === 'PING') {
        sendFrame(client, JSON.stringify({ type: 'PONG', serverTime: Date.now() }));
      }
    });

    ws.on('close', () => {
      wsClients.delete(client);
    });
    ws.on('error', () => {
      wsClients.delete(client);
    });
  });

  engine.onSnapshot((snapshot) => {
    if (wsClients.size === 0) return;
    let lightStr: string | null = null;
    let fullStr: string | null = null;
    for (const client of wsClients) {
      if (client.ledgerVersion !== snapshot.ledgerVersion) {
        fullStr ??= JSON.stringify({ type: 'SNAPSHOT', snapshot });
        client.ledgerVersion = snapshot.ledgerVersion;
        sendFrame(client, fullStr);
        continue;
      }
      if (lightStr === null) {
        lightStr = JSON.stringify({ type: 'SNAPSHOT', snapshot: lightenSnapshot(snapshot) });
      }
      sendFrame(client, lightStr);
    }
  });

  logger.subscribe((entry) => {
    if (wsClients.size === 0) return;
    const msg = JSON.stringify({ type: 'LOG', entry });
    for (const client of wsClients) {
      sendFrame(client, msg);
    }
  });

  // Half-open TCP after a Wi-Fi blip or a laptop sleep never fires "close" on its own, which
  // is what makes a dashboard look frozen while still reporting itself connected. An
  // unanswered ping means the peer is gone; terminate rather than keep a dead socket.
  const heartbeat = setInterval(() => {
    for (const client of wsClients) {
      if (!client.alive) {
        logger.warn('NETWORK', 'Dashboard client stopped answering pings; dropping the dead socket.');
        client.ws.terminate();
        wsClients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        // ignore
      }
    }
  }, 10_000);
  heartbeat.unref?.();

  // --- FRONTEND SERVING (Vite Middleware in Dev, Compiled dist/ in Prod) ---
  const distPath = path.resolve(process.cwd(), 'dist');
  if (IS_PROD && fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: {
          server: httpServer,
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  await engine.initialize();

  httpServer.listen(PORT, HOST, () => {
    logger.success(
      'ENGINE',
      `HFT Command Server online at http://${HOST}:${PORT} (Localhost: http://localhost:${PORT})`
    );
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});

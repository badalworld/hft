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
    const localAddress = req.body?.localAddress ? String(req.body.localAddress) : null;
    const ipReport = await engine.setBoundLocalAddress(localAddress);
    res.json({ ipReport });
  });

  app.post('/api/settings/local-ai', (req, res) => {
    engine.updateLocalDecisionConfig({
      provider: req.body?.provider,
      endpointUrl: req.body?.endpointUrl,
      modelName: req.body?.modelName,
    });
    res.json({ snapshot: engine.getSnapshot() });
  });

  app.post('/api/settings/style-params', (req, res) => {
    engine.updateStyleParams(req.body || {});
    res.json({ snapshot: engine.getSnapshot() });
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
  const wsClients = new Set<WebSocket>();

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url?.split('?')[0] || '';
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Leave other upgrade paths (such as Vite HMR in dev) untouched!
  });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    try {
      ws.send(
        JSON.stringify({
          type: 'INIT',
          snapshot: engine.getSnapshot(),
          logs: logger.getLogs(250),
        })
      );
    } catch {
      // ignore
    }

    ws.on('close', () => {
      wsClients.delete(ws);
    });
    ws.on('error', () => {
      wsClients.delete(ws);
    });
  });

  engine.onSnapshot((snapshot) => {
    if (wsClients.size === 0) return;
    const msg = JSON.stringify({ type: 'SNAPSHOT', snapshot });
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(msg);
        } catch {
          // ignore
        }
      }
    }
  });

  logger.subscribe((entry) => {
    if (wsClients.size === 0) return;
    const msg = JSON.stringify({ type: 'LOG', entry });
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(msg);
        } catch {
          // ignore
        }
      }
    }
  });

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

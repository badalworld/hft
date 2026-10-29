import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DashboardSnapshot,
  LocalDecisionConfig,
  LogEntry,
  OperatorDirectiveKind,
} from '../types/hft';

/**
 * Blocks the stream only resends when settled-trade data changes. A light frame simply omits
 * them, so the hook keeps whatever is already on screen instead of blanking the history.
 */
const HEAVY_SNAPSHOT_KEYS = [
  'recentClosedTrades',
  'styleMutations',
  'pnlLedger',
  'lessons',
  'lessonPatterns',
] as const;

/**
 * `live` is a stream frame inside the last four seconds. `polling` means the socket is down and
 * the REST fallback is carrying the panel. `stalled` is the dangerous one — the socket looks
 * open but nothing is moving, which is what a frozen dashboard actually feels like.
 */
export type FeedStatus = 'live' | 'polling' | 'stalled' | 'offline';

const LIVE_FRAME_MS = 4_000;
const STALL_FRAME_MS = 8_000;
const WATCHDOG_MS = 2_000;
const HEARTBEAT_MS = 5_000;
const PONG_TIMEOUT_MS = 13_000;
const POLL_INTERVAL_MS = 3_000;

export function useHftRealtime() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('offline');
  const [actionBusy, setActionBusy] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const lastFrameAtRef = useRef(0);
  const lastSnapshotTsRef = useRef(0);
  const lastPongAtRef = useRef(0);
  const statusRef = useRef<FeedStatus>('offline');

  const setStatus = useCallback((next: FeedStatus) => {
    if (statusRef.current === next) return;
    statusRef.current = next;
    setFeedStatus(next);
  }, []);

  /**
   * Single write path for both transports: rejects out-of-order frames (a REST poll can answer
   * after a newer stream frame) and merges light frames over the existing snapshot.
   */
  const applySnapshot = useCallback((incoming: DashboardSnapshot | null | undefined) => {
    if (!incoming || typeof incoming.timestamp !== 'number') return;
    if (incoming.timestamp < lastSnapshotTsRef.current) return;
    lastSnapshotTsRef.current = incoming.timestamp;
    lastFrameAtRef.current = Date.now();
    setSnapshot((prev) => {
      if (!prev) return incoming;
      const merged: Record<string, unknown> = { ...incoming };
      for (const key of HEAVY_SNAPSHOT_KEYS) {
        if (merged[key] === undefined) merged[key] = prev[key as keyof DashboardSnapshot];
      }
      return merged as unknown as DashboardSnapshot;
    });
  }, []);

  const fetchSnapshotHttp = useCallback(async () => {
    try {
      const res = await fetch('/api/snapshot');
      if (!res.ok) return false;
      applySnapshot((await res.json()) as DashboardSnapshot);
      return true;
    } catch {
      return false;
    }
  }, [applySnapshot]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;
    let backoffMs = 1_000;

    const connectWs = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws`;

      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        backoffMs = 1_000;
        lastPongAtRef.current = Date.now();
        setWsConnected(true);
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        let msg: {
          type?: string;
          snapshot?: DashboardSnapshot;
          logs?: LogEntry[];
          entry?: LogEntry;
          serverTime?: number;
        };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'INIT') {
          applySnapshot(msg.snapshot);
          if (Array.isArray(msg.logs)) setLogs(msg.logs);
        } else if (msg.type === 'SNAPSHOT') {
          applySnapshot(msg.snapshot);
        } else if (msg.type === 'LOG' && msg.entry) {
          setLogs((prev) => [msg.entry as LogEntry, ...prev].slice(0, 600));
        } else if (msg.type === 'PONG') {
          lastPongAtRef.current = Date.now();
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        socketRef.current = null;
        scheduleReconnect();
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      const jitter = 0.8 + Math.random() * 0.4;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectWs();
      }, Math.min(15_000, backoffMs * jitter));
      backoffMs = Math.min(15_000, backoffMs * 2);
    };

    connectWs();

    // Application-level heartbeat. The browser never sees the protocol pings the server sends,
    // so an unanswered PING is the only way to notice a socket that is open but half-dead.
    const heartbeat = window.setInterval(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'PING' }));
      if (Date.now() - lastPongAtRef.current > PONG_TIMEOUT_MS) {
        lastPongAtRef.current = Date.now();
        socket.close();
      }
    }, HEARTBEAT_MS);

    // The panel is only as fresh as the last frame, whatever the socket claims.
    const watchdog = window.setInterval(() => {
      const sinceFrame = Date.now() - lastFrameAtRef.current;
      const socketOpen = socketRef.current?.readyState === WebSocket.OPEN;
      if (sinceFrame < LIVE_FRAME_MS && socketOpen) {
        setStatus('live');
        return;
      }
      if (socketOpen && sinceFrame < STALL_FRAME_MS) return; // still inside one tick
      if (socketOpen) {
        setStatus('stalled');
        void fetchSnapshotHttp().then((ok) => {
          if (!disposed && !ok) setStatus('offline');
        });
        return;
      }
      setStatus('polling');
      void fetchSnapshotHttp().then((ok) => {
        if (!disposed && !ok) setStatus('offline');
      });
    }, WATCHDOG_MS);

    // Even a healthy stream gets polled occasionally, so a missed frame is never a frozen panel.
    const poll = window.setInterval(() => {
      if (Date.now() - lastFrameAtRef.current > POLL_INTERVAL_MS) void fetchSnapshotHttp();
    }, POLL_INTERVAL_MS * 2);

    // Sleep, tab throttling and Wi-Fi blips all leave a socket that never fires "close".
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      lastPongAtRef.current = Date.now();
      void fetchSnapshotHttp();
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        backoffMs = 1_000;
        connectWs();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      disposed = true;
      window.clearInterval(heartbeat);
      window.clearInterval(watchdog);
      window.clearInterval(poll);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [applySnapshot, fetchSnapshotHttp, setStatus]);

  const toggleEngine = useCallback(async (running: boolean) => {
    setActionBusy(true);
    try {
      const res = await fetch('/api/engine/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ running }),
      });
      const data = await res.json();
      await fetchSnapshotHttp();
      return data as { running: boolean; message: string };
    } finally {
      setActionBusy(false);
    }
  }, [fetchSnapshotHttp]);

  const saveCredentials = useCallback(async (apiKey: string, apiSecret: string) => {
    setActionBusy(true);
    try {
      const res = await fetch('/api/settings/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, apiSecret }),
      });
      const data = await res.json();
      applySnapshot(data.snapshot);
      return data as { connected: boolean; message: string };
    } finally {
      setActionBusy(false);
    }
  }, [applySnapshot]);

  const resetStartBalance = useCallback(async () => {
    setActionBusy(true);
    try {
      const res = await fetch('/api/settings/reset-start-balance', {
        method: 'POST',
      });
      const data = await res.json();
      applySnapshot(data.snapshot);
      return data;
    } finally {
      setActionBusy(false);
    }
  }, [applySnapshot]);

  const rescanIps = useCallback(async () => {
    setActionBusy(true);
    try {
      const res = await fetch('/api/settings/rescan-ips', { method: 'POST' });
      const data = await res.json();
      await fetchSnapshotHttp();
      return data;
    } finally {
      setActionBusy(false);
    }
  }, [fetchSnapshotHttp]);

  const bindLocalIp = useCallback(async (localAddress: string | null) => {
    setActionBusy(true);
    try {
      const res = await fetch('/api/settings/bind-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localAddress }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, message: data?.message || 'That address was refused.' };
      await fetchSnapshotHttp();
      return { ok: true, message: '' };
    } finally {
      setActionBusy(false);
    }
  }, [fetchSnapshotHttp]);

  const updateLocalAi = useCallback(
    async (cfg: Partial<LocalDecisionConfig>) => {
      const res = await fetch('/api/settings/local-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const data = await res.json().catch(() => null);
      applySnapshot(data?.snapshot);
      if (!res.ok) {
        return {
          ok: false,
          message: (data?.rejected as string[] | undefined)?.join(' ') || 'The server refused that runtime.',
        };
      }
      return { ok: true, message: '' };
    },
    [applySnapshot]
  );

  const manualClosePosition = useCallback(async (symbol: string, positionSide: string) => {
    const res = await fetch('/api/positions/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, positionSide }),
    });
    const data = await res.json();
    applySnapshot(data.snapshot);
    return Boolean(data.ok);
  }, [applySnapshot]);

  const clearLogs = useCallback(async () => {
    const res = await fetch('/api/logs/clear', { method: 'POST' });
    const data = await res.json();
    if (Array.isArray(data.logs)) setLogs(data.logs);
  }, []);

  const postSetting = useCallback(async (route: string, body?: unknown) => {
    const res = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => null);
    applySnapshot(data?.snapshot);
    if (!res.ok || !data) {
      const detail = Array.isArray(data?.rejected) ? data.rejected.join(' ') : data?.message;
      return { ok: false, message: detail || `${route} failed (HTTP ${res.status}).` };
    }
    return data as { ok?: boolean; message?: string };
  }, [applySnapshot]);

  const setOrderFlowMode = useCallback(
    (mode: 'shadow' | 'enforce') => postSetting('/api/settings/order-flow-mode', { mode }),
    [postSetting]
  );

  const addDirective = useCallback(
    (directive: {
      kind: OperatorDirectiveKind;
      symbol?: string;
      value?: number;
      reason?: string;
    }) => postSetting('/api/settings/directives', directive),
    [postSetting]
  );

  const toggleDirective = useCallback(
    (id: string, active: boolean) => postSetting('/api/settings/directives/toggle', { id, active }),
    [postSetting]
  );

  const addNote = useCallback(
    (text: string) => postSetting('/api/settings/notes', { text }),
    [postSetting]
  );

  const removeNote = useCallback(
    (id: string) => postSetting('/api/settings/notes/remove', { id }),
    [postSetting]
  );

  return {
    snapshot,
    logs,
    wsConnected,
    feedStatus,
    actionBusy,
    toggleEngine,
    saveCredentials,
    resetStartBalance,
    rescanIps,
    bindLocalIp,
    updateLocalAi,
    manualClosePosition,
    clearLogs,
    setOrderFlowMode,
    addDirective,
    toggleDirective,
    addNote,
    removeNote,
  };
}

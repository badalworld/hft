import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdaptiveStyleParams,
  DashboardSnapshot,
  LocalDecisionConfig,
  LogEntry,
  OperatorDirectiveKind,
} from '../types/hft';

export function useHftRealtime() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const reconnectTimer = useRef<number | null>(null);

  const fetchSnapshotHttp = useCallback(async () => {
    try {
      const res = await fetch('/api/snapshot');
      if (res.ok) {
        const data = (await res.json()) as DashboardSnapshot;
        setSnapshot(data);
      }
    } catch {
      // ignore initial network hiccup
    }
  }, []);

  useEffect(() => {
    fetchSnapshotHttp();

    let unmounted = false;
    let socket: WebSocket | null = null;

    const connectWs = () => {
      if (unmounted) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws`;

      try {
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
          if (!unmounted) setWsConnected(true);
        };

        socket.onmessage = (event) => {
          if (unmounted) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'INIT') {
              if (msg.snapshot) setSnapshot(msg.snapshot);
              if (Array.isArray(msg.logs)) setLogs(msg.logs);
            } else if (msg.type === 'SNAPSHOT' && msg.snapshot) {
              setSnapshot(msg.snapshot);
            } else if (msg.type === 'LOG' && msg.entry) {
              setLogs((prev) => [msg.entry, ...prev].slice(0, 600));
            }
          } catch {
            // ignore parse error
          }
        };

        socket.onclose = () => {
          if (unmounted) return;
          setWsConnected(false);
          reconnectTimer.current = window.setTimeout(connectWs, 2500);
        };

        socket.onerror = () => {
          socket?.close();
        };
      } catch {
        reconnectTimer.current = window.setTimeout(connectWs, 2500);
      }
    };

    connectWs();

    return () => {
      unmounted = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      socket?.close();
    };
  }, [fetchSnapshotHttp]);

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
      if (data.snapshot) setSnapshot(data.snapshot);
      return data as { connected: boolean; message: string };
    } finally {
      setActionBusy(false);
    }
  }, []);

  const resetStartBalance = useCallback(async () => {
    setActionBusy(true);
    try {
      const res = await fetch('/api/settings/reset-start-balance', {
        method: 'POST',
      });
      const data = await res.json();
      if (data.snapshot) setSnapshot(data.snapshot);
      return data;
    } finally {
      setActionBusy(false);
    }
  }, []);

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
      await fetch('/api/settings/bind-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localAddress }),
      });
      await fetchSnapshotHttp();
    } finally {
      setActionBusy(false);
    }
  }, [fetchSnapshotHttp]);

  const updateLocalAi = useCallback(async (cfg: Partial<LocalDecisionConfig>) => {
    const res = await fetch('/api/settings/local-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (data.snapshot) setSnapshot(data.snapshot);
  }, []);

  const updateStyleParams = useCallback(async (params: Partial<AdaptiveStyleParams>) => {
    const res = await fetch('/api/settings/style-params', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.snapshot) setSnapshot(data.snapshot);
  }, []);

  const manualClosePosition = useCallback(async (symbol: string, positionSide: string) => {
    const res = await fetch('/api/positions/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, positionSide }),
    });
    const data = await res.json();
    if (data.snapshot) setSnapshot(data.snapshot);
    return Boolean(data.ok);
  }, []);

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
    if (data?.snapshot) setSnapshot(data.snapshot);
    if (!res.ok || !data) {
      return { ok: false, message: data?.message || `${route} failed (HTTP ${res.status}).` };
    }
    return data as { ok?: boolean; message?: string };
  }, []);

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
    actionBusy,
    toggleEngine,
    saveCredentials,
    resetStartBalance,
    rescanIps,
    bindLocalIp,
    updateLocalAi,
    updateStyleParams,
    manualClosePosition,
    clearLogs,
    addDirective,
    toggleDirective,
    addNote,
    removeNote,
  };
}

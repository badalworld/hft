import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Download, ScrollText, Search, Trash2, X } from 'lucide-react';
import type { LogEntry, LogLevel } from '../types/hft';

interface SystemLogsDrawerProps {
  open: boolean;
  logs: LogEntry[];
  onClose: () => void;
  onClearLogs: () => Promise<void>;
}

const LEVEL_STYLES: Record<LogLevel, string> = {
  INFO: 'border-[#EBAEE6]/25 bg-[#6B403C]/35 text-[#f2dedc]',
  SUCCESS: 'border-[#ADEBB3]/50 bg-[#ADEBB3]/18 text-[#ADEBB3]',
  WARN: 'border-[#FF857A]/45 bg-[#FF857A]/15 text-[#FF857A]',
  ERROR: 'border-[#FF857A]/70 bg-[#FF857A]/28 text-[#ffe4e1]',
  EXEC: 'border-[#EBAEE6]/55 bg-[#EBAEE6]/20 text-[#EBAEE6]',
  AI: 'border-[#ADEBB3]/40 bg-[#EBAEE6]/15 text-[#EBAEE6]',
};

export const SystemLogsDrawer: React.FC<SystemLogsDrawerProps> = ({
  open,
  logs,
  onClose,
  onClearLogs,
}) => {
  const [levelFilter, setLevelFilter] = useState<string>('ALL');
  const [moduleFilter, setModuleFilter] = useState<string>('ALL');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    return logs.filter((entry) => {
      if (levelFilter !== 'ALL' && entry.level !== levelFilter) return false;
      if (moduleFilter !== 'ALL' && entry.module !== moduleFilter) return false;
      if (query.trim()) {
        const q = query.toLowerCase();
        const hitMsg = entry.message.toLowerCase().includes(q);
        const hitMeta = entry.meta
          ? JSON.stringify(entry.meta).toLowerCase().includes(q)
          : false;
        if (!hitMsg && !hitMeta) return false;
      }
      return true;
    });
  }, [logs, levelFilter, moduleFilter, query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-md sm:p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="skeuo-chassis skeuo-lotus-trim relative flex max-h-[92vh] w-full max-w-5xl flex-col rounded-2xl p-5 sm:p-6"
      >
        <div className="lotus-ribbon absolute top-0 left-0 right-0 h-[3px]" />

        {/* Header */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[#EBAEE6]/15 pb-4">
          <div className="flex items-center gap-3">
            <div className="skeuo-oled flex h-10 w-10 items-center justify-center rounded-xl border border-[#ADEBB3]/45">
              <ScrollText className="h-5 w-5 text-[#ADEBB3]" />
            </div>
            <div>
              <h2 className="font-crest text-lg font-bold tracking-wider text-lotus-crest">
                HFT SYSTEM, EXECUTION & ERROR DIAGNOSTIC LOGS
              </h2>
              <p className="text-xs text-[#d5b8b5]">
                Full real-time trace of Binance FAPI calls, 10x→15x leverage escalations, 15s signals, 1s checks & error diagnostics
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href="/api/logs/export"
              className="skeuo-btn-lotus inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export .LOG</span>
            </a>

            <button
              type="button"
              onClick={onClearLogs}
              className="skeuo-btn inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs text-[#FF857A]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Clear</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="skeuo-btn rounded-xl p-2 text-[#fdf6f5]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[#b99895]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol, order ID, error code (-2015, -4164, -1021)..."
              className="skeuo-input w-full rounded-xl py-2 pl-9 pr-3 text-xs"
            />
          </div>

          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="skeuo-input rounded-xl px-3 py-2 text-xs"
          >
            <option value="ALL">All Levels</option>
            <option value="EXEC">EXEC (Orders & Ladder)</option>
            <option value="ERROR">ERROR (Failures)</option>
            <option value="WARN">WARN</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="AI">AI_CLUB</option>
            <option value="INFO">INFO</option>
          </select>

          <select
            value={moduleFilter}
            onChange={(e) => setModuleFilter(e.target.value)}
            className="skeuo-input rounded-xl px-3 py-2 text-xs"
          >
            <option value="ALL">All Modules</option>
            <option value="EXECUTION">EXECUTION</option>
            <option value="BINANCE_API">BINANCE_API</option>
            <option value="MONITOR_1S">MONITOR_1S</option>
            <option value="CANDLE_15S">CANDLE_15S</option>
            <option value="SCANNER">SCANNER</option>
            <option value="AI_CLUB">AI_CLUB</option>
            <option value="NETWORK">NETWORK</option>
            <option value="ENGINE">ENGINE</option>
          </select>
        </div>

        {/* Log Console */}
        <div className="skeuo-oled flex-1 overflow-y-auto rounded-xl p-3 font-mono-num text-xs">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-[#b99895]">
              No log entries match your current filter.
            </div>
          ) : (
            <div className="space-y-1.5">
              {filtered.map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-col gap-1 rounded-lg border border-[#EBAEE6]/[0.08] bg-[#6B403C]/12 px-3 py-2 sm:flex-row sm:items-start sm:gap-3"
                >
                  <span className="shrink-0 text-[10px] text-[#b99895]">
                    {entry.isoTime.slice(11, 23)}
                  </span>
                  <span
                    className={`inline-block w-16 shrink-0 rounded border px-1.5 py-0.5 text-center text-[10px] font-bold ${
                      LEVEL_STYLES[entry.level]
                    }`}
                  >
                    {entry.level}
                  </span>
                  <span className="w-24 shrink-0 text-[10px] font-semibold text-[#EBAEE6]">
                    [{entry.module}]
                  </span>
                  <div className="flex-1 break-words text-[11px] leading-relaxed text-[#fdf6f5]">
                    {entry.message}
                    {entry.meta && (
                      <pre className="mt-1 overflow-x-auto rounded bg-black/50 p-1.5 text-[10px] text-[#c7a8a5]">
                        {JSON.stringify(entry.meta)}
                      </pre>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};

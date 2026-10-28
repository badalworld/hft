import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { useHftRealtime } from './hooks/useHftRealtime';
import { HeaderChassis } from './components/HeaderChassis';
import { EquityBezel } from './components/EquityBezel';
import { OpenTradesDeck } from './components/OpenTradesDeck';
import { MarketScannerDeck } from './components/MarketScannerDeck';
import { SettingsVaultModal } from './components/SettingsVaultModal';
import { AiAgentClubModal } from './components/AiAgentClubModal';
import { PnlLedgerModal } from './components/PnlLedgerModal';
import { SystemLogsDrawer } from './components/SystemLogsDrawer';
import { HftBrandLogo } from './components/HftBrandLogo';

export const App: React.FC = () => {
  const {
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
    manualClosePosition,
    clearLogs,
    addDirective,
    toggleDirective,
    addNote,
    removeNote,
  } = useHftRealtime();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiClubOpen, setAiClubOpen] = useState(false);
  const [pnlLedgerOpen, setPnlLedgerOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const errorCount = useMemo(
    () => logs.filter((l) => l.level === 'ERROR').length,
    [logs]
  );

  const handleToggleEngine = async (next: boolean) => {
    if (next && !snapshot?.apiConfigured) {
      setSettingsOpen(true);
      setToastMsg('Input your Binance API Key & Secret Key in Vault Settings to arm live trading.');
      window.setTimeout(() => setToastMsg(null), 5000);
      return;
    }
    const res = await toggleEngine(next);
    if (!res.running && next) {
      setToastMsg(res.message);
      window.setTimeout(() => setToastMsg(null), 5500);
    }
  };

  return (
    <div className="min-h-screen px-3 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-5">
        {/* Toast Alert Banner */}
        <AnimatePresence>
          {toastMsg && (
            <motion.div
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="skeuo-chassis flex items-center justify-between gap-3 rounded-xl border border-[#FF857A]/60 px-4 py-3 text-xs text-[#ffe5e2]"
            >
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 text-[#FF857A]" />
                <span>{toastMsg}</span>
              </div>
              <button
                type="button"
                onClick={() => setToastMsg(null)}
                className="text-[#c7a8a5] hover:text-white cursor-pointer"
              >
                ✕
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 1. Luxury Machined Header Chassis */}
        <HeaderChassis
          snapshot={snapshot}
          wsConnected={wsConnected}
          actionBusy={actionBusy}
          errorCount={errorCount}
          onToggleEngine={handleToggleEngine}
          onOpenPnlLedger={() => setPnlLedgerOpen(true)}
          onOpenAiClub={() => setAiClubOpen(true)}
          onOpenLogs={() => setLogsOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* 2. Fixed Start Balance & Live Current Equity Bezel */}
        <EquityBezel snapshot={snapshot} />

        {/* 3. Live 1-Second Open Trades Deck */}
        <OpenTradesDeck
          positions={snapshot?.openPositions ?? []}
          trailingTriggerRoi={snapshot?.styleParams.trailingTriggerRoiPct ?? 5.0}
          onManualClose={manualClosePosition}
        />

        {/* 4. 40-Asset Market Scanner (20 Positive + 20 Negative | 15s Candles) */}
        <MarketScannerDeck
          positiveAssets={snapshot?.positiveAssets ?? []}
          negativeAssets={snapshot?.negativeAssets ?? []}
          scannerState={snapshot?.scannerState ?? 'DISCONNECTED'}
          scannerPauseReason={snapshot?.scannerPauseReason ?? null}
        />

        {/* Engraved Luxury Lotus Garden Copyright Footer */}
        <footer className="mt-1 flex flex-col items-center justify-between gap-2 border-t border-[#EBAEE6]/15 px-2 pt-4 pb-2 text-[11px] text-[#c7a8a5] sm:flex-row">
          <div className="flex items-center gap-2.5">
            <HftBrandLogo variant="footer" />
            <span>
              <strong className="text-white">AUTOMATION TRADING BOT</strong> • Trade Smarter, Grow Faster — Production Binance USDⓈ-M Environment
            </span>
          </div>
          <div>
            Copyright © & Developed by{' '}
            <strong className="text-[#FF857A]">Trading Lifestyle Quant.</strong> All Rights Reserved.
          </div>
        </footer>
      </div>

      {/* Hardware Modals & Diagnostic Console */}
      <SettingsVaultModal
        open={settingsOpen}
        snapshot={snapshot}
        actionBusy={actionBusy}
        onClose={() => setSettingsOpen(false)}
        onSaveCredentials={saveCredentials}
        onResetStartBalance={resetStartBalance}
        onRescanIps={rescanIps}
        onBindLocalIp={bindLocalIp}
      />

      <PnlLedgerModal
        open={pnlLedgerOpen}
        snapshot={snapshot}
        onClose={() => setPnlLedgerOpen(false)}
      />

      <AiAgentClubModal
        open={aiClubOpen}
        snapshot={snapshot}
        onClose={() => setAiClubOpen(false)}
        onUpdateLocalAi={updateLocalAi}
        onAddDirective={addDirective}
        onToggleDirective={toggleDirective}
        onAddNote={addNote}
        onRemoveNote={removeNote}
      />

      <SystemLogsDrawer
        open={logsOpen}
        logs={logs}
        onClose={() => setLogsOpen(false)}
        onClearLogs={clearLogs}
      />
    </div>
  );
};

export default App;

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Network,
  RefreshCw,
  RotateCcw,
  Shield,
  X,
} from 'lucide-react';
import type { DashboardSnapshot } from '../types/hft';
import { fmtUsd6 } from '../utils/format';

interface SettingsVaultModalProps {
  open: boolean;
  snapshot: DashboardSnapshot | null;
  actionBusy: boolean;
  onClose: () => void;
  onSaveCredentials: (
    apiKey: string,
    apiSecret: string
  ) => Promise<{ connected: boolean; message: string }>;
  onResetStartBalance: () => Promise<unknown>;
  onRescanIps: () => Promise<unknown>;
  onBindLocalIp: (localAddress: string | null) => Promise<void>;
}

export const SettingsVaultModal: React.FC<SettingsVaultModalProps> = ({
  open,
  snapshot,
  actionBusy,
  onClose,
  onSaveCredentials,
  onResetStartBalance,
  onRescanIps,
  onBindLocalIp,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  if (!open) return null;

  const ipReport = snapshot?.ipReport;
  const publicIps = ipReport?.whitelistPublicIpv4s ?? [];
  const interfaces = ipReport?.interfaces ?? [];

  const allCopyableWhitelistStr =
    publicIps.length > 0
      ? publicIps.join(' ')
      : interfaces.map((i) => i.localIpv4).join(' ');

  const copyText = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // ignore clipboard error
    }
  };

  const handleSaveKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveFeedback(null);
    const res = await onSaveCredentials(apiKey, apiSecret);
    setSaveFeedback({ ok: res.connected, msg: res.message });
    if (res.connected) {
      setApiKey('');
      setApiSecret('');
    }
  };

  const handleConfirmResetBalance = async () => {
    await onResetStartBalance();
    setConfirmReset(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-md sm:p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="skeuo-chassis skeuo-lotus-trim relative max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl p-5 sm:p-6"
      >
        <div className="lotus-ribbon absolute top-0 left-0 right-0 h-[3px]" />

        {/* Modal Header */}
        <div className="mb-5 flex items-center justify-between border-b border-[#EBAEE6]/15 pb-4">
          <div className="flex items-center gap-3">
            <div className="skeuo-oled flex h-10 w-10 items-center justify-center rounded-xl border border-[#EBAEE6]/40">
              <Shield className="h-5 w-5 text-[#EBAEE6]" />
            </div>
            <div>
              <h2 className="font-crest text-lg font-bold tracking-wider text-lotus-crest">
                HFT VAULT SETTINGS & IP WHITELIST
              </h2>
              <p className="text-xs text-[#d5b8b5]">
                Production Binance USDⓈ-M Futures Credentials, Multi-IPv4 Whitelist & Start Balance Lock
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="skeuo-btn rounded-xl p-2 text-[#fdf6f5]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6">
          {/* 1. SERVER IPv4 WHITELIST SECTION (CRITICAL FOR BINANCE API KEY) */}
          <div className="skeuo-plate rounded-xl p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Network className="h-4 w-4 text-[#ADEBB3]" />
                <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                  Server IPv4 Addresses for Binance API Key Whitelist
                </h3>
                {ipReport?.environmentHint === 'MULTI_IP_SERVER' && (
                  <span className="rounded-full border border-[#FF857A]/60 bg-[#FF857A]/20 px-2 py-0.5 text-[10px] font-bold text-[#FF857A]">
                    MULTI-IP SERVER DETECTED ({publicIps.length} IPv4s)
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {allCopyableWhitelistStr && (
                  <button
                    type="button"
                    onClick={() => copyText(allCopyableWhitelistStr, 'all-ips')}
                    className="skeuo-btn-lotus inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs"
                  >
                    {copiedId === 'all-ips' ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {copiedId === 'all-ips'
                        ? 'Copied All IPv4s!'
                        : 'Copy All Whitelist IPv4s'}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => onRescanIps()}
                  className="skeuo-btn inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[#fdf6f5]"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${actionBusy ? 'animate-spin' : ''}`} />
                  <span>Re-Scan IPs</span>
                </button>
              </div>
            </div>

            <p className="mb-3 text-xs leading-relaxed text-[#f2dedc]">
              In Binance API Management →{' '}
              <strong className="text-white">
                &ldquo;Restrict access to trusted IPs only (Recommended)&rdquo;
              </strong>
              , paste <strong className="text-[#ADEBB3]">ALL public IPv4 addresses</strong>{' '}
              shown below (Binance accepts multiple space-separated IPv4s). Whitelisting every server IPv4 prevents critical{' '}
              <code className="text-[#FF857A]">-2015 Invalid API-key, IP, or permissions</code>{' '}
              failures if your server routes across multiple interfaces.
            </p>

            {/* Public Whitelist IPv4 Cards */}
            <div className="skeuo-oled mb-3 rounded-xl p-3.5">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[#c7a8a5]">
                Detected Public Outbound IPv4 Address(es) ({publicIps.length})
              </div>

              {publicIps.length > 0 ? (
                <div className="flex flex-wrap gap-2.5">
                  {publicIps.map((ip, idx) => (
                    <div
                      key={ip}
                      className="flex items-center gap-2.5 rounded-lg border border-[#ADEBB3]/40 bg-[#ADEBB3]/10 px-3 py-2"
                    >
                      <span className="h-2.5 w-2.5 rounded-full led-mint" />
                      <div>
                        <div className="font-mono-num text-sm font-bold text-white">
                          {ip}
                        </div>
                        <div className="text-[10px] text-[#ADEBB3]">
                          Public Egress IPv4 #{idx + 1}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyText(ip, `pub-${ip}`)}
                        className="skeuo-btn rounded-md p-1.5 text-[#fdf6f5]"
                        title="Copy IPv4"
                      >
                        {copiedId === `pub-${ip}` ? (
                          <Check className="h-3.5 w-3.5 text-[#ADEBB3]" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-[#EBAEE6]">
                  Public IP echo lookup has not returned yet in this network; inspect detected Server NIC IPv4s below and click Re-Scan IPs on your PC / Online Server.
                </div>
              )}
            </div>

            {/* All Network Interfaces Breakdown + Multi-IP Pinning */}
            <div className="skeuo-oled overflow-x-auto rounded-xl p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-[#c7a8a5]">
                  All Server Network Interfaces (NIC IPv4s: {interfaces.length})
                </span>
                {interfaces.length > 1 && (
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-[#c7a8a5]">Outbound Socket Route:</span>
                    <select
                      value={ipReport?.boundLocalAddress || ''}
                      onChange={(e) => onBindLocalIp(e.target.value || null)}
                      className="skeuo-input rounded-lg px-2 py-1 font-mono-num text-[11px]"
                    >
                      <option value="">OS Automatic Primary IPv4</option>
                      {interfaces.map((nic) => (
                        <option key={`${nic.interfaceName}-${nic.localIpv4}`} value={nic.localIpv4}>
                          Pin to {nic.interfaceName} ({nic.localIpv4})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-[#EBAEE6]/15 text-[10px] uppercase tracking-wider text-[#b99895]">
                    <th className="py-2 pr-3">Interface</th>
                    <th className="px-3 py-2">Local NIC IPv4</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Detected Outbound Public IPv4</th>
                    <th className="py-2 pl-3 text-right">Copy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EBAEE6]/[0.07]">
                  {interfaces.map((nic) => {
                    const targetCopy = nic.detectedEgressIpv4 || nic.localIpv4;
                    return (
                      <tr key={`${nic.interfaceName}-${nic.localIpv4}`}>
                        <td className="py-2 pr-3 font-mono-num font-semibold text-[#fdf6f5]">
                          {nic.interfaceName}
                          {nic.isPrimaryRoute && (
                            <span className="ml-1.5 rounded bg-[#ADEBB3]/20 px-1.5 py-0.5 text-[9px] font-bold text-[#ADEBB3]">
                              PRIMARY
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono-num text-[#f2dedc]">
                          {nic.localIpv4}
                        </td>
                        <td className="px-3 py-2 text-[11px]">
                          {nic.isPublicRoutableNic ? (
                            <span className="text-[#ADEBB3]">Direct Public IPv4</span>
                          ) : (
                            <span className="text-[#c7a8a5]">LAN / Cloud NAT IPv4</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono-num font-bold text-[#EBAEE6]">
                          {nic.detectedEgressIpv4 || 'Pending WAN Echo'}
                        </td>
                        <td className="py-2 pl-3 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              copyText(targetCopy, `nic-${nic.interfaceName}-${nic.localIpv4}`)
                            }
                            className="skeuo-btn inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-[#fdf6f5]"
                          >
                            {copiedId === `nic-${nic.interfaceName}-${nic.localIpv4}` ? (
                              <Check className="h-3 w-3 text-[#ADEBB3]" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                            <span>Copy</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {ipReport?.notes && ipReport.notes.length > 0 && (
                <div className="mt-2.5 border-t border-[#EBAEE6]/10 pt-2 text-[11px] text-[#c7a8a5]">
                  {ipReport.notes.map((n, i) => (
                    <div key={i}>• {n}</div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 2. BINANCE FUTURES API KEY & SECRET KEY VAULT */}
          <form onSubmit={handleSaveKeys} className="skeuo-plate rounded-xl p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-[#EBAEE6]" />
                <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                  Binance USDⓈ-M Futures API Credentials (Real Production)
                </h3>
              </div>
              {snapshot?.apiConfigured && (
                <span className="rounded-full border border-[#ADEBB3]/45 bg-[#ADEBB3]/15 px-2.5 py-0.5 font-mono-num text-[11px] text-[#ADEBB3]">
                  Active Key: {snapshot.maskedApiKey}
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[#f2dedc]">
                  Binance API Key
                </label>
                <input
                  type="text"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    snapshot?.apiConfigured
                      ? 'Enter new API Key to replace stored key...'
                      : 'Paste your real Binance API Key...'
                  }
                  className="skeuo-input w-full rounded-xl px-3.5 py-2.5 font-mono-num text-xs"
                  autoComplete="off"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[#f2dedc]">
                  Binance Secret Key
                </label>
                <div className="relative">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    placeholder="Paste your real Binance Secret Key..."
                    className="skeuo-input w-full rounded-xl py-2.5 pl-3.5 pr-10 font-mono-num text-xs"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute top-1/2 right-2.5 -translate-y-1/2 text-[#c7a8a5] hover:text-white cursor-pointer"
                  >
                    {showSecret ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            {saveFeedback && (
              <div
                className={`mt-3 rounded-xl border px-3.5 py-2.5 text-xs ${
                  saveFeedback.ok
                    ? 'border-[#ADEBB3]/50 bg-[#ADEBB3]/15 text-[#ADEBB3]'
                    : 'border-[#FF857A]/50 bg-[#FF857A]/15 text-[#FF857A]'
                }`}
              >
                {saveFeedback.msg}
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-[#e7cecc]">
                Keys are encrypted locally with AES-256-GCM inside <code className="text-[#EBAEE6]">./data/hft_vault.json</code>. Enable{' '}
                <strong className="text-white">&ldquo;Enable Futures&rdquo;</strong> on your Binance API key (do NOT enable withdrawal permission).
              </p>

              <button
                type="submit"
                disabled={actionBusy || (!apiKey.trim() && !apiSecret.trim())}
                className="skeuo-btn-lotus rounded-xl px-5 py-2.5 text-xs uppercase tracking-wider"
              >
                {actionBusy ? 'Connecting to Binance...' : 'Save & Connect Live API'}
              </button>
            </div>
          </form>

          {/* 3. FIXED START BALANCE RESET CONTROL */}
          <div className="skeuo-plate flex flex-col justify-between gap-4 rounded-xl p-4 sm:flex-row sm:items-center sm:p-5">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-white">
                Fixed Start Balance Vault ({fmtUsd6(snapshot?.startBalance ?? 0)} USDT)
              </h3>
              <p className="mt-1 text-xs text-[#e7cecc]">
                Your Start Balance is automatically captured on your 1st Binance API connection and stays permanently fixed until you explicitly reset it here.
              </p>
            </div>

            {!confirmReset ? (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="skeuo-btn inline-flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold text-[#FF857A]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reset Start Balance</span>
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleConfirmResetBalance}
                  className="skeuo-btn rounded-xl border-[#FF857A]/60 px-3.5 py-2 text-xs font-bold text-[#FF857A]"
                >
                  Confirm Reset Now
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="skeuo-btn rounded-xl px-3 py-2 text-xs text-[#fdf6f5]"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
};

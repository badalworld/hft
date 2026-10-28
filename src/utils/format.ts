export function fmt6(val: number | string | null | undefined): string {
  const n = typeof val === 'string' ? parseFloat(val) : Number(val ?? 0);
  if (!Number.isFinite(n)) return '0.000000';
  return n.toFixed(6);
}

export function fmtSigned6(val: number | string | null | undefined): string {
  const n = typeof val === 'string' ? parseFloat(val) : Number(val ?? 0);
  if (!Number.isFinite(n)) return '+0.000000';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(6)}`;
}

export function fmtUsd6(val: number | string | null | undefined): string {
  const n = typeof val === 'string' ? parseFloat(val) : Number(val ?? 0);
  if (!Number.isFinite(n)) return '$0.000000';
  if (n < 0) return `-$${Math.abs(n).toFixed(6)}`;
  return `$${n.toFixed(6)}`;
}

export function fmtSignedUsd6(val: number | string | null | undefined): string {
  const n = typeof val === 'string' ? parseFloat(val) : Number(val ?? 0);
  if (!Number.isFinite(n)) return '+$0.000000';
  if (n < 0) return `-$${Math.abs(n).toFixed(6)}`;
  return `+$${n.toFixed(6)}`;
}

export function formatDurationClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00 (0.000000s)';
  const whole = Math.floor(seconds);
  const hrs = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const hh = String(hrs).padStart(2, '0');
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return `${hh}:${mm}:${ss} (${seconds.toFixed(6)}s)`;
}

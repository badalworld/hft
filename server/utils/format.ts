export function f6(value: number | string | null | undefined): string {
  const num = typeof value === 'string' ? parseFloat(value) : Number(value ?? 0);
  if (!Number.isFinite(num)) return '0.000000';
  return num.toFixed(6);
}

export function countStepDecimals(stepStrOrNum: string | number): number {
  const s = String(stepStrOrNum).trim();
  if (s.includes('e-')) {
    const exp = parseInt(s.split('e-')[1] || '0', 10);
    return Number.isFinite(exp) ? exp : 8;
  }
  const dotIdx = s.indexOf('.');
  if (dotIdx === -1) return 0;
  const trimmed = s.slice(dotIdx + 1).replace(/0+$/, '');
  return trimmed.length;
}

export function floorToStepSize(value: number, stepSize: number, stepDecimals: number): number {
  if (!Number.isFinite(value) || value <= 0 || stepSize <= 0) return 0;
  // Add tiny epsilon to avoid float floor issues like 2.9999999999999996 -> 2
  const steps = Math.floor(value / stepSize + 1e-9);
  const raw = steps * stepSize;
  return Number(raw.toFixed(Math.min(Math.max(stepDecimals, 0), 12)));
}

export function formatOrderQty(value: number, stepSize: number, stepDecimals: number): string {
  const floored = floorToStepSize(value, stepSize, stepDecimals);
  return floored.toFixed(Math.min(Math.max(stepDecimals, 0), 12));
}

export function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export function maskApiKey(key: string): string {
  if (!key || key.length < 10) return key ? '••••••••' : '';
  return `${key.slice(0, 6)}••••••••••••${key.slice(-4)}`;
}

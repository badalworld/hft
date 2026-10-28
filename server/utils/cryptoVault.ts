import crypto from 'node:crypto';
import os from 'node:os';

function deriveVaultKey(): Buffer {
  const secretSeed =
    process.env.HFT_VAULT_SECRET ||
    `tlq-hft-vault-${os.hostname()}-${os.platform()}-${os.arch()}`;
  return crypto.scryptSync(secretSeed, 'trading-lifestyle-quant-salt-v1', 32);
}

export function encryptSecret(plainText: string): string {
  if (!plainText) return '';
  const key = deriveVaultKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  if (!payload) return '';
  try {
    const parts = payload.split(':');
    if (parts.length !== 3) return '';
    const [ivHex, tagHex, encHex] = parts;
    const key = deriveVaultKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

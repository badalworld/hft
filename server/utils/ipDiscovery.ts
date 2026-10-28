import os from 'node:os';
import https from 'node:https';
import type { NetworkInterfaceIpv4, ServerIpReport } from '../types.js';
import { logger } from './logger.js';

const IPV4_REGEX =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const EGRESS_PROVIDERS = [
  'https://api.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://checkip.amazonaws.com',
  'https://v4.ident.me',
];

export function isValidIpv4(ip: string): boolean {
  return IPV4_REGEX.test(ip.trim());
}

export function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // Loopback
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // Link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // Multicast / reserved
  return false;
}

function probeSingleUrl(urlStr: string, localAddress?: string, timeoutMs = 2800): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: string | null) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    try {
      const req = https.get(
        urlStr,
        {
          family: 4,
          localAddress: localAddress || undefined,
          timeout: timeoutMs,
          headers: {
            'User-Agent': 'HFT-TradingLifestyleQuant/1.0',
            Accept: 'text/plain',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            finish(null);
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (body.length < 128) body += chunk;
          });
          res.on('end', () => {
            const candidate = body.trim();
            finish(isValidIpv4(candidate) ? candidate : null);
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        finish(null);
      });
      req.on('error', () => {
        finish(null);
      });
    } catch {
      finish(null);
    }
  });
}

async function discoverEgressIpv4(localAddress?: string): Promise<string | null> {
  // Probe providers concurrently and return first valid IPv4, plus collect any distinct multi-NAT IPs
  const results = await Promise.all(
    EGRESS_PROVIDERS.map((url) => probeSingleUrl(url, localAddress))
  );
  for (const ip of results) {
    if (ip && isValidIpv4(ip)) return ip;
  }
  return null;
}

async function discoverAllDefaultEgressIpv4s(): Promise<string[]> {
  const results = await Promise.all(EGRESS_PROVIDERS.map((url) => probeSingleUrl(url)));
  const unique = new Set<string>();
  for (const ip of results) {
    if (ip && isValidIpv4(ip)) unique.add(ip);
  }
  return Array.from(unique);
}

export async function scanServerIpv4Addresses(
  boundLocalAddress: string | null = null
): Promise<ServerIpReport> {
  const rawIfaces = os.networkInterfaces();
  const interfaces: NetworkInterfaceIpv4[] = [];
  const publicSet = new Set<string>();
  const notes: string[] = [];

  for (const [ifaceName, addrs] of Object.entries(rawIfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      const isV4 = addr.family === 'IPv4' || (addr.family as unknown) === 4;
      if (!isV4 || addr.internal) continue;
      if (!isValidIpv4(addr.address)) continue;

      const isPublicNic = !isPrivateOrReservedIpv4(addr.address);
      if (isPublicNic) {
        publicSet.add(addr.address);
      }

      interfaces.push({
        interfaceName: ifaceName,
        localIpv4: addr.address,
        netmask: addr.netmask,
        isPublicRoutableNic: isPublicNic,
        detectedEgressIpv4: isPublicNic ? addr.address : null,
        isPrimaryRoute: false,
      });
    }
  }

  // 1. Probe default outbound route across multiple echo providers (catches load-balanced NAT too)
  const defaultEgressIps = await discoverAllDefaultEgressIpv4s();
  for (const ip of defaultEgressIps) {
    publicSet.add(ip);
  }
  const primaryEgress = defaultEgressIps[0] ?? null;

  // 2. Probe per-interface bound outbound route so secondary ENIs / multi-IP VPS routes are ALL found
  await Promise.all(
    interfaces.map(async (nic) => {
      const egress = await discoverEgressIpv4(nic.localIpv4);
      if (egress) {
        nic.detectedEgressIpv4 = egress;
        publicSet.add(egress);
        if (primaryEgress && egress === primaryEgress) {
          nic.isPrimaryRoute = true;
        }
      }
    })
  );

  if (interfaces.length > 0 && !interfaces.some((i) => i.isPrimaryRoute)) {
    interfaces[0].isPrimaryRoute = true;
  }

  const whitelistPublicIpv4s = Array.from(publicSet);

  let environmentHint: ServerIpReport['environmentHint'] = 'LOCALHOST_NAT';
  if (whitelistPublicIpv4s.length > 1) {
    environmentHint = 'MULTI_IP_SERVER';
    notes.push(
      `Multiple public IPv4 addresses (${whitelistPublicIpv4s.length}) detected! Add ALL listed IPv4s to your Binance API Key IP Whitelist so failover or secondary routes never trigger -2015 Invalid API-key/IP rejections.`
    );
  } else if (interfaces.some((i) => i.isPublicRoutableNic)) {
    environmentHint = 'SINGLE_IP_SERVER';
    notes.push('Direct public IPv4 interface detected on server.');
  } else if (whitelistPublicIpv4s.length === 1) {
    environmentHint = 'LOCALHOST_NAT';
    notes.push(
      'NAT/Router environment detected (Localhost PC or Cloud NAT). Whitelist the detected Public Egress IPv4 in Binance API Management.'
    );
  } else {
    notes.push(
      'Outbound IPv4 echo services were unreachable from current network sandbox. Local network interface IPv4s are shown below; once running on your PC or VPS with internet access, click Re-Scan IPs to populate all public WAN IPv4s.'
    );
  }

  logger.info(
    'NETWORK',
    `IPv4 Whitelist Discovery complete: ${whitelistPublicIpv4s.length} public IPv4(s), ${interfaces.length} NIC interface(s).`,
    { whitelistPublicIpv4s, interfaces: interfaces.map((i) => `${i.interfaceName}:${i.localIpv4}`) }
  );

  return {
    whitelistPublicIpv4s,
    interfaces,
    boundLocalAddress,
    lastScannedAt: Date.now(),
    environmentHint,
    notes,
  };
}

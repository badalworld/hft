import { isValidIpv4 } from './ipDiscovery.js';
import type { LocalDecisionProvider } from '../types.js';

/**
 * Guards for URLs and addresses the server accepts from the dashboard.
 *
 * The System-1 decision endpoint is stored, then fetched from by the engine. Without an
 * allowlist, anything that can reach this server can make the trading process issue GET
 * requests to whatever address it likes — the cloud metadata endpoint, a router admin page,
 * or an internal database — and read the answer back through the status line. That is the
 * classic SSRF shape, and the fix is to only ever accept a literal loopback or site-local
 * address rather than a name that could resolve elsewhere later.
 */

export interface EndpointCheck {
  ok: boolean;
  reason: string;
  normalizedUrl: string;
}

const ALLOWED_DNS_HOSTS = new Set(['localhost', 'api.threerouter.com']);

export const LOCAL_DECISION_PROVIDERS: LocalDecisionProvider[] = [
  'builtin',
  'ollama_nimble',
  'laya_http',
  'kev_http',
  'threerouter',
];

/**
 * `builtin` scores entirely in-process, so only the three HTTP providers turn `endpointUrl`
 * into an outbound request. Requiring the URL only for those keeps the operator able to park
 * the runtime on the built-in judge with a stale endpoint field.
 */
export function providerNeedsEndpoint(provider: LocalDecisionProvider): boolean {
  return provider !== 'builtin';
}

function isLoopbackOrSiteLocalIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 127 || // loopback
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) // 192.168.0.0/16
  );
}

export function checkDecisionEndpoint(raw: unknown): EndpointCheck {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, reason: 'endpointUrl is required', normalizedUrl: '' };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `"${text}" is not an absolute URL`, normalizedUrl: '' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `only http/https endpoints are allowed (${url.protocol})`, normalizedUrl: '' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials inside the endpoint URL are not allowed', normalizedUrl: '' };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: 'endpoint URL must not carry a query string or fragment', normalizedUrl: '' };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::1' || ALLOWED_DNS_HOSTS.has(host)) {
    return { ok: true, reason: '', normalizedUrl: url.toString() };
  }
  if (!isValidIpv4(host) || !isLoopbackOrSiteLocalIpv4(host)) {
    return {
      ok: false,
      reason:
        `"${host}" is not a loopback or site-local IPv4 address. The decision endpoint must be a local model server (127.0.0.1, ::1, localhost, 10.x, 172.16-31.x, 192.168.x); hostnames and public addresses are refused so this process cannot be pointed at internal services.`,
      normalizedUrl: '',
    };
  }

  return { ok: true, reason: '', normalizedUrl: url.toString() };
}

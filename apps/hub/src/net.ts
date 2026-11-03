import { isIPv4, isIPv6 } from 'node:net';

function v4ToBig(ip: string): bigint {
  return ip.split('.').reduce((acc, p) => (acc << 8n) | BigInt(Number(p) & 255), 0n);
}

function v6ToBig(ip: string): bigint {
  let s = ip;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded IPv4 tail.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const b = v4ToBig(v4[1]!);
    s = `${s.slice(0, -v4[1]!.length)}${(b >> 16n).toString(16)}:${(b & 0xffffn).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : [];
  const parts = [...h, ...fill, ...t];
  return parts.reduce((acc, p) => (acc << 16n) | BigInt(Number.parseInt(p || '0', 16)), 0n);
}

/** Normalise IPv4-mapped IPv6 (::ffff:1.2.3.4) to IPv4. */
export function normaliseIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

export function ipInCidr(ipRaw: string, cidr: string): boolean {
  const ip = normaliseIp(ipRaw);
  const [range, bitsStr] = cidr.split('/') as [string, string | undefined];
  if (isIPv4(ip) && isIPv4(range)) {
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    if (bits === 0) return true;
    const mask = ((1n << 32n) - 1n) ^ ((1n << BigInt(32 - bits)) - 1n);
    return (v4ToBig(ip) & mask) === (v4ToBig(range) & mask);
  }
  if (isIPv6(ip) && isIPv6(range)) {
    const bits = bitsStr === undefined ? 128 : Number(bitsStr);
    if (bits === 0) return true;
    const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
    return (v6ToBig(ip) & mask) === (v6ToBig(range) & mask);
  }
  return false;
}

export function ipInAny(ip: string, cidrs: string[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c));
}

/** Loopback and private networks (the Docker bridge, the LAN). */
export const PRIVATE_NETS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/** Hostname of a Host header value: lower-cased, port and IPv6 brackets removed. */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (v6) return v6[1]!;
  return h.replace(/:\d+$/, '');
}

/**
 * Host allow-list: the venue domain and any label under it (`op.`, `out3.`, `stage.`), localhost and its
 * labels, loopback addresses, plus configured extras. An empty hostname is refused.
 */
export function hostAllowed(hostname: string, domain: string, extra: string[] = []): boolean {
  if (!hostname) return false;
  const d = domain.toLowerCase();
  if (hostname === d || hostname.endsWith(`.${d}`)) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '127.0.0.1' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true;
  return extra.includes(hostname);
}

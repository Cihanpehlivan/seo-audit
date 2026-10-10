// SSRF guard: on a public server the tool must not reach private or internal addresses
// (localhost, office networks, the cloud metadata service at 169.254.169.254).
// Active only when the crawl gets blockPrivate: true (server sets it in PUBLIC_MODE).
import dns from 'node:dns/promises';
import net from 'node:net';

export const BLOCKED = 'blocked-private';

const V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const toInt = (ip) => ip.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0);

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = toInt(ip);
    return V4.some(([base, bits]) => (n ^ toInt(base)) >>> (32 - bits) === 0);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); return isPrivateIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true; // not an IP address: treat as unsafe
}

// Returns check(url) → BLOCKED or null. DNS answers are cached per host for one crawl.
// Known limit: the address is checked before fetch resolves it again (DNS rebinding is not fully closed).
export function makeGuard() {
  const cache = new Map();
  return async function check(url) {
    let u;
    try { u = new URL(url); } catch { return BLOCKED; }
    if (!/^https?:$/.test(u.protocol)) return BLOCKED;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!cache.has(host)) {
      cache.set(host, (async () => {
        if (net.isIP(host)) return isPrivateIp(host);
        if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
        try { return (await dns.lookup(host, { all: true })).some((a) => isPrivateIp(a.address)); }
        catch { return false; } // DNS error: fetch reports the real error
      })());
    }
    return (await cache.get(host)) ? BLOCKED : null;
  };
}

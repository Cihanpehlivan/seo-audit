// Shared helpers for rules.
import { bareHost } from '../normalize.js';

export const isHtml = (p) => /html/i.test(p.contentType || '') && !p.redirectChain?.length;
export const isOk = (p) => p.status === 200 && isHtml(p);
export const isNoindex = (p) => /noindex|none/.test(`${p.metaRobots || ''} ${p.xRobotsTag || ''}`.toLowerCase());
export const isCanonicalized = (p) => !!p.canonical && p.canonical !== p.url;
export const isIndexable = (p) => isOk(p) && !isNoindex(p) && !p.blockedByRobots && !isCanonicalized(p);

// Rough pixel width of a Google title (Arial ~20px). Good enough for a warning.
const NARROW = new Set('ilIjtf.,;:\'|!() '.split(''));
const WIDE = new Set('mwMWŞĞÖÜ@%'.split(''));
export function titlePx(s) {
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w += 5.5;
    else if (NARROW.has(ch)) w += 5.5;
    else if (WIDE.has(ch)) w += 15.5;
    else if (ch >= 'A' && ch <= 'Z' || 'ÇİÂ'.includes(ch)) w += 12.5;
    else w += 10;
  }
  return Math.round(w);
}

export function isStagingHost(host, cfg) {
  const h = host.toLowerCase();
  if (h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (cfg.stagingSuffixes.some((s) => h.endsWith(s))) return true;
  const labels = h.split('.');
  return labels.slice(0, -2).some((l) => cfg.stagingHosts.some((k) => l === k || l.startsWith(k + '-') || l.endsWith('-' + k)));
}

export function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
export const sameSite = (a, b) => bareHost(a) === bareHost(b);

export function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x); if (k == null || k === '') continue; (m.get(k) || m.set(k, []).get(k)).push(x); }
  return m;
}

export const short = (s, n = 90) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

// A checked resource is broken when it errors. Bot-protection codes (403, 429…) and timeouts are not counted.
export function isBroken(r, cfg) {
  if (!r) return false;
  if (r.status === 0) return r.error !== 'timeout' && r.error !== 'blocked-private';
  return r.status >= 400 && !(cfg.brokenIgnoreStatuses || []).includes(r.status);
}
export const resLabel = (r) => r.status || r.error || 'hata';

const TLS_ERR = {
  CERT_HAS_EXPIRED: 'süresi dolmuş',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'kendinden imzalı',
  SELF_SIGNED_CERT_IN_CHAIN: 'zincirde kendinden imzalı sertifika',
  ERR_TLS_CERT_ALTNAME_INVALID: 'alan adı sertifikada yok',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'ara sertifika eksik',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'ara sertifika eksik',
  CERT_NOT_YET_VALID: 'henüz geçerli değil',
};
export const tlsErrorText = (code) => `${TLS_ERR[code] || 'doğrulanamadı'} (${code})`;
// Only certificate problems. Protocol errors (plain http on the https port) are not counted.
export const isTlsError = (code) => /CERT|SELF_SIGNED|VERIFY|ALTNAME/i.test(code || '');

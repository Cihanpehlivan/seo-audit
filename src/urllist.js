// Old address list (v0.12.0). The crawl finds old pages only by links and sitemaps. A page without links that
// gets traffic is not in the crawl: it gets no 301 and gives 404 after launch. The list adds these pages.
// Sources: Search Console export (Pages), Analytics export (often paths only), a backlink tool export (target URL)
// or a plain list (one address per line). No API, no account: the user uploads the file.
// This module reads, cleans and merges the lists, picks the addresses to ask on the old site and adds the pages
// that answered to the old page set. It makes no requests (the server asks with the crawler in list mode).
import { createHash } from 'node:crypto';
import { parseCsv } from './validate.js';
import { normalizeUrl, bareHost, looksLikeAsset } from './normalize.js';
import { pathKey } from './compare.js';
import { isOk } from './rules/helpers.js';

export const METRICS = ['clicks', 'impressions', 'views', 'links'];
// Short keys in the stored rows: [path, c, i, v, l].
const SHORT = { clicks: 'c', impressions: 'i', views: 'v', links: 'l' };
export const KIND_NAME = { gsc: 'Search Console', ga: 'Analytics', backlink: 'Backlink', plain: 'Düz liste' };
const bad = (msg, code = 400) => Object.assign(new Error(msg), { code });
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// A cell that is an address: a full URL, a path (/a/b) or a host with a path (www.ornek.com/a).
const looksLikeAddress = (v) => /^https?:\/\//i.test(v) || v.startsWith('/') || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(v);

// Counts are whole numbers. Exports write them as 1240, 1.240, 1,240 or "1 240": all separators go.
function count(v) {
  const s = clean(v);
  if (!s || !/\d/.test(s)) return null;
  const n = Number(s.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Finds the header line and the columns. The header is the first line (of the first 10) with an address column name.
// No header: the column where most cells are addresses (a plain list or an export without a header line).
// chosen: column names the user picked ({ url: 'Top pages', clicks: '' }); an empty name means "no column".
export function detectColumns(rows, cfg = {}, chosen = null) {
  const names = cfg.columns || {};
  const lower = (r) => r.map((c) => clean(c).toLowerCase());
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 10) && hi < 0; i++) {
    const h = lower(rows[i]);
    if ((chosen?.url && h.includes(clean(chosen.url).toLowerCase())) || (names.url || []).some((n) => h.includes(n))) hi = i;
  }
  const idx = {};
  let header = [];
  if (hi >= 0) {
    header = rows[hi].map(clean);
    const h = lower(rows[hi]);
    for (const key of ['url', ...METRICS]) {
      if (chosen && key in chosen) {
        const c = clean(chosen[key]).toLowerCase();
        const i = c ? h.indexOf(c) : -1;
        if (i >= 0) idx[key] = i;
        continue;
      }
      const i = (names[key] || []).map((n) => h.indexOf(n)).find((x) => x >= 0);
      if (i !== undefined) idx[key] = i;
    }
  } else {
    // No known header: the column with most address cells (first 50 lines).
    const sample = rows.slice(0, 50);
    const width = Math.max(0, ...sample.map((r) => r.length));
    let best = -1, bestN = 0;
    for (let c = 0; c < width; c++) {
      const n = sample.filter((r) => looksLikeAddress(clean(r[c]))).length;
      if (n > bestN) { best = c; bestN = n; }
    }
    if (best >= 0 && bestN >= Math.max(1, Math.ceil(sample.length / 2))) idx.url = best;
    // The first line may still be an unknown header ("Adres;Değer"): it is not an address, so it is skipped as invalid.
  }
  const kind = idx.clicks !== undefined || idx.impressions !== undefined ? 'gsc' : idx.views !== undefined ? 'ga' : idx.links !== undefined ? 'backlink' : 'plain';
  const columns = {};
  for (const [k, i] of Object.entries(idx)) columns[k] = hi >= 0 ? header[i] : `${i + 1}. sütun`;
  return { headerIndex: hi, idx, kind, columns, header };
}

// Reads a list (CSV, ; separated CSV or one address per line). Returns the raw rows with their numbers.
export function readList(text, cfg = {}, chosen = null) {
  const src = String(text ?? '');
  if (!src.trim()) throw bad('Liste boş. CSV dosyası seçin veya adresleri yapıştırın.');
  const rows = parseCsv(src);
  const det = detectColumns(rows, cfg, chosen);
  if (det.idx.url === undefined) {
    throw Object.assign(bad('Adres sütunu bulunamadı. Adres sütununu seçin.'), { columns: det.header.length ? det.header : (rows[0] || []).map(clean).filter(Boolean).slice(0, 40) });
  }
  const out = [];
  for (const r of rows.slice(det.headerIndex + 1)) {
    const row = { raw: clean(r[det.idx.url]) };
    for (const m of METRICS) if (det.idx[m] !== undefined) row[m] = count(r[det.idx[m]]);
    out.push(row);
  }
  return { kind: det.kind, columns: det.columns, header: det.header, rows: out };
}

// Cleans the rows for one old site. oldStartUrl: start address of the old crawl (its scheme is used for paths).
// www and http/https are the same site. Tracking parameters go (the crawler's normalization). The same path is merged:
// counts are added, the number of linking domains takes the larger value (the same domain links to both variants).
export function cleanList(rows, oldStartUrl) {
  const base = new URL(oldStartUrl);
  const oldHost = bareHost(base.hostname);
  const urls = new Map();
  const other = {};
  let invalid = 0, assets = 0, merged = 0;
  for (const r of rows) {
    const v = r.raw;
    if (!v || !looksLikeAddress(v)) { if (v) invalid++; continue; }
    const abs = v.startsWith('/') ? new URL(v.replace(/^\/{2,}/, '/'), base.origin).href : /^https?:\/\//i.test(v) ? v : `${base.protocol}//${v}`;
    const url = normalizeUrl(abs);
    if (!url) { invalid++; continue; }
    const host = bareHost(new URL(url).hostname);
    if (host !== oldHost) { other[host] = (other[host] || 0) + 1; continue; }
    if (looksLikeAsset(url)) { assets++; continue; }
    const key = pathKey(url);
    const prev = urls.get(key);
    if (prev) merged++;
    urls.set(key, addMetrics(prev || {}, r));
  }
  return { urls, other, invalid, assets, merged };
}

function addMetrics(a, b) {
  const out = { ...a };
  for (const m of METRICS) {
    if (b[m] == null) continue;
    out[m] = m === 'links' ? Math.max(out[m] ?? 0, b[m]) : (out[m] ?? 0) + b[m];
  }
  return out;
}

// One source as stored in the list file. urls: [[path, c, i, v, l]] (null: no column).
export function makeSource({ text, name, file, kind, columns, cleaned, rows, at = new Date() }, id) {
  return {
    id, kind, name: clean(name).slice(0, 60) || KIND_NAME[kind], file: clean(file).slice(0, 120), columns,
    hash: createHash('sha1').update(String(text)).digest('hex'),
    rows, addedAt: at.toISOString(), other: cleaned.other, invalid: cleaned.invalid, assets: cleaned.assets, merged: cleaned.merged,
    urls: [...cleaned.urls].map(([p, m]) => [p, ...METRICS.map((k) => m[k] ?? null)]),
  };
}

// Merged list of every source: path → { clicks, impressions, views, links, src: [ids] }.
// The same metric of two sources is added (links: larger value).
export function mergeSources(sources = []) {
  const out = new Map();
  for (const s of sources) {
    for (const [p, ...vals] of s.urls || []) {
      const m = {};
      METRICS.forEach((k, i) => { if (vals[i] != null) m[k] = vals[i]; });
      const prev = out.get(p);
      const next = addMetrics(prev || {}, m);
      next.src = [...(prev?.src || []), s.id];
      out.set(p, next);
    }
  }
  return out;
}

// Traffic order: clicks, then impressions, then views, then linking domains. Rows without numbers come last.
export function trafficCompare(a, b) {
  for (const k of METRICS) {
    const d = (b?.[k] ?? -1) - (a?.[k] ?? -1);
    if (d) return d;
  }
  return 0;
}
export const hasTraffic = (m) => !!m && METRICS.some((k) => m[k] != null);
// Short numbers for the screen and Excel: { c, i, v, l } (only the ones that exist).
export function trafficOf(m) {
  if (!hasTraffic(m)) return null;
  const out = {};
  for (const k of METRICS) if (m[k] != null) out[SHORT[k]] = m[k];
  return out;
}

// Checks a list file (from "Projeyi indir" or from disk). Bad sources are dropped.
export function validateList(input, { maxSources = 5, maxRows = 30000 } = {}) {
  const raw = Array.isArray(input?.sources) ? input.sources : [];
  const sources = [];
  let total = 0;
  const seen = new Set();
  for (const s of raw.slice(0, maxSources)) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.urls)) continue;
    const id = /^l[0-9a-z]{1,12}$/.test(String(s.id)) && !seen.has(s.id) ? String(s.id) : `l${sources.length + 1}x`;
    seen.add(id);
    const urls = [];
    for (const u of s.urls) {
      if (!Array.isArray(u) || typeof u[0] !== 'string' || !u[0].startsWith('/') || u[0].length > 2000) continue;
      if (total >= maxRows) break;
      urls.push([u[0], ...METRICS.map((_, i) => (Number.isFinite(u[i + 1]) && u[i + 1] >= 0 ? Math.round(u[i + 1]) : null))]);
      total++;
    }
    const other = {};
    if (s.other && typeof s.other === 'object') for (const [h, n] of Object.entries(s.other).slice(0, 200)) if (Number.isFinite(n)) other[clean(h).slice(0, 200)] = n;
    sources.push({
      id, kind: KIND_NAME[s.kind] ? s.kind : 'plain', name: clean(s.name).slice(0, 60) || KIND_NAME[s.kind] || 'Liste', file: clean(s.file).slice(0, 120),
      columns: s.columns && typeof s.columns === 'object' ? Object.fromEntries(Object.entries(s.columns).filter(([k]) => ['url', ...METRICS].includes(k)).map(([k, v]) => [k, clean(v).slice(0, 80)])) : {},
      hash: /^[0-9a-f]{40}$/.test(String(s.hash)) ? s.hash : '', rows: Number.isFinite(s.rows) ? s.rows : urls.length,
      addedAt: typeof s.addedAt === 'string' ? s.addedAt.slice(0, 40) : new Date().toISOString(),
      other, invalid: Number(s.invalid) || 0, assets: Number(s.assets) || 0, merged: Number(s.merged) || 0, urls,
      ...(s.afterLaunch ? { afterLaunch: true } : {}),
    });
  }
  return { version: 1, sources };
}
export const rowCount = (list) => (list?.sources || []).reduce((n, s) => n + (s.urls?.length || 0), 0);

// Paths of the old crawl (every status: a known redirect or 404 needs no new request).
export const crawlPaths = (oldRes) => new Set((oldRes?.pages || []).map((p) => { try { return pathKey(p.url); } catch { return null; } }).filter(Boolean));

// Addresses to ask on the old site: in the list, not in the old crawl. Highest traffic first.
// max: the request limit (public mode). The rest is "not asked (limit)".
export function toFetch(merged, oldRes, max = Infinity) {
  const known = crawlPaths(oldRes);
  const want = [...merged].filter(([p]) => !known.has(p)).sort((a, b) => trafficCompare(a[1], b[1]) || a[0].localeCompare(b[0]));
  const origin = new URL(oldRes.meta.startUrl).origin;
  return { urls: want.slice(0, max).map(([p]) => new URL(p, origin).href), rest: new Set(want.slice(max).map(([p]) => p)), total: want.length };
}

// Old page set with the list: the old crawl + the pages of the list crawl that answered with HTML 200 and are
// still in the list. A page in the old crawl wins. The new pages carry discoveredBy: 'list'.
export function withListPages(oldRes, listRes, merged) {
  if (!listRes || !merged?.size) return oldRes;
  const known = crawlPaths(oldRes);
  const add = [];
  for (const p of listRes.pages || []) {
    if (!isOk(p)) continue;
    const k = pathKey(p.url);
    if (known.has(k) || !merged.has(k)) continue;
    known.add(k);
    add.push({ ...p, discoveredBy: 'list', depth: null, inlinks: 0, orphan: false, foundOn: null });
  }
  return add.length ? { ...oldRes, pages: [...oldRes.pages, ...add] } : oldRes;
}

// v0.12.1 (decision 7b): addresses of the list that the old site never answered: not in the old crawl and not asked
// by the list crawl. Only after launch: before launch they are still to ask ("İstenmedi"). After launch the old domain
// serves the new site, so the tool can never ask the old site again. Both a source added after launch and an address
// added before launch but not asked go here.
export function latePaths(merged, oldRes, listRes) {
  const known = crawlPaths(oldRes);
  for (const p of listRes?.pages || []) { try { known.add(pathKey(p.url)); } catch {} }
  return new Set([...merged.keys()].filter((p) => !known.has(p)));
}
// Old pages without content for the late addresses. late: true marks them everywhere. status 200 only lets the
// steps use them as old pages: no step writes that the old site answered 200 (the tool never asked it).
// The comparison asks nothing for them (no staging request) and the 301 map can only use the address.
export function withLatePages(oldRes, late) {
  if (!late?.size) return oldRes;
  const origin = new URL(oldRes.meta.startUrl).origin;
  const add = [...late].sort().map((p) => ({ url: new URL(p, origin).href, status: 200, contentType: 'text/html', late: true, discoveredBy: 'late',
    title: '', h1: [], metaDescription: '', depth: null, inlinks: 0, orphan: false, foundOn: null, simhash: null }));
  return { ...oldRes, pages: [...oldRes.pages, ...add] };
}
// Proof that a late address was a real page: a number of the list at or over its threshold (urlList.lateProof).
// A Search Console row has clicks or impressions, so it is almost always proof. A plain list is never proof.
export function hasProof(m, proof = {}) {
  if (!m) return false;
  return METRICS.some((k) => m[k] != null && proof[k] != null && m[k] >= proof[k]);
}

// v0.12.2: what an old redirect did on the old site (from the crawls before launch, no request).
// off: the first hop that left the old host (the old site sent the address to another domain). to: off or the last
// address on the old host. broken: the last address on the old host did not answer with 2xx (404, loop, no answer).
// same: the redirect only changed the scheme, the host variant or the last "/" (same path): no 301 row is needed.
export function redirectInfo(p, oldHost) {
  if (!p?.redirectChain?.length) return null;
  const host = bareHost(oldHost);
  let off = null;
  for (const h of p.redirectChain) {
    if (!h.to) break;
    try { if (bareHost(new URL(h.to).hostname) !== host) { off = h.to; break; } } catch { break; }
  }
  if (off) return { to: off, toPath: null, off: true, broken: false, same: false, hops: p.redirectChain.length };
  const to = p.finalUrl || '';
  let toPath = null;
  try { toPath = pathKey(to); } catch {}
  const broken = !toPath || !!p.error || !(p.finalStatus >= 200 && p.finalStatus < 300);
  let same = false;
  try { same = !!toPath && toPath === pathKey(p.url); } catch {}
  return { to, toPath, off: false, broken, same, hops: p.redirectChain.length, html: /html/i.test(p.contentType || '') };
}

// v0.12.2: redirects of the old site that need a 301 on the new site. Before this version (decision 5 of v0.12.0)
// they did not enter the 301 map, so the address gave 404 after launch when the old server rules were lost.
// Sources: the old crawl (a link found the redirect) and the list crawl (an address of the list; only while it is
// still in the list). A redirect to the same path (http → https, www, last "/") is not one: the new site does it.
// The redirects are not old pages: the counts and the comparison never see them.
export function oldRedirects(oldCrawl, listRes, merged) {
  const out = new Map();
  const host = oldCrawl?.meta?.host;
  const add = (p, src) => {
    if (p.blockedByRobots) return;
    const info = redirectInfo(p, host);
    if (!info || info.same) return;
    let path;
    try { path = pathKey(p.url); } catch { return; }
    if (out.has(path)) return;
    out.set(path, { path, oldUrl: p.url, src, inlinks: p.inlinks || 0, ...info });
  };
  for (const p of oldCrawl?.pages || []) add(p, 'crawl');
  if (merged?.size) {
    const known = crawlPaths(oldCrawl);
    for (const p of listRes?.pages || []) {
      let k;
      try { k = pathKey(p.url); } catch { continue; }
      if (!known.has(k) && merged.has(k)) add(p, 'list');
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// Result of every list address. Groups: crawl (in the old crawl), found (new old page), gone (4xx/5xx on the old
// site), redirect (the old site redirects it; v0.12.2: a 301 row follows its target), redirectBad (it redirects to an
// address that fails), nothtml (not an HTML page), error (no answer), blocked (robots.txt),
// pending (not asked yet), limit (not asked: request limit), late (not asked before launch: v0.12.1 checks it on the
// live domain only, as an old page without content).
export const RESULT = {
  crawl: 'Taramada vardı', found: 'Yeni bulundu', gone: 'Eski sitede hata', redirect: 'Eski sitede yönleniyor', redirectBad: 'Yönleniyor · hedef hata',
  nothtml: 'HTML değil', error: 'Yanıt yok', blocked: 'robots.txt engeli', pending: 'İstenmedi', limit: 'İstenmedi (sınır)', late: 'Canlıda kontrol edilir',
};
export function listResults({ list, merged, oldRes, listRes, launched = false, limitPaths = null }) {
  const m = merged || mergeSources(list?.sources);
  const known = crawlPaths(oldRes);
  const asked = new Map();
  for (const p of listRes?.pages || []) { try { asked.set(pathKey(p.url), p); } catch {} }
  const rows = [];
  for (const [path, t] of m) {
    let result, detail = '';
    if (known.has(path)) result = 'crawl';
    else if (asked.has(path)) {
      const p = asked.get(path);
      if (p.blockedByRobots) result = 'blocked';
      else if (p.redirectChain?.length) {
        // v0.12.2: the redirect gets a 301 row (the target's new address). A broken target gets none.
        const info = redirectInfo(p, oldRes?.meta?.host || new URL(p.url).hostname);
        result = info?.broken ? 'redirectBad' : 'redirect';
        detail = info?.broken ? `${p.finalUrl || ''} · ${p.finalStatus || p.error || 'yanıt yok'}` : info?.off ? info.to : p.finalUrl || '';
      }
      else if (!p.status) { result = 'error'; detail = p.error || ''; }
      else if (p.status >= 400) { result = 'gone'; detail = String(p.status); }
      else if (!isOk(p)) { result = 'nothtml'; detail = `${p.status} ${p.contentType || ''}`.trim(); }
      else result = 'found';
    } else result = launched ? 'late' : limitPaths?.has(path) ? 'limit' : 'pending';
    rows.push({ path, result, detail, traffic: trafficOf(t), src: t.src });
  }
  rows.sort((a, b) => trafficCompare(expand(a.traffic), expand(b.traffic)) || a.path.localeCompare(b.path));
  const counts = Object.fromEntries(Object.keys(RESULT).map((k) => [k, 0]));
  for (const r of rows) counts[r.result]++;
  return { rows, counts };
}
const expand = (t) => (t ? { clicks: t.c, impressions: t.i, views: t.v, links: t.l } : null);
// v0.12.1: traffic order of rows with short traffic ({ c, i, v, l }). The work list, the launch list and the live check.
export const byTraffic = (a, b) => trafficCompare(expand(a), expand(b));
// Stable sort of a list by traffic. get: the short traffic of a row. Rows without traffic keep their order at the end.
export const sortByTraffic = (list, get = (x) => x.traffic) => list.map((x, i) => [x, i]).sort((a, b) => byTraffic(get(a[0]), get(b[0])) || a[1] - b[1]).map(([x]) => x);

// Summary of the sources for the screen: rows, other hosts, invalid lines.
export function sourceSummary(list) {
  const other = {};
  let rows = 0, invalid = 0, assets = 0;
  for (const s of list?.sources || []) {
    rows += s.rows || 0; invalid += s.invalid || 0; assets += s.assets || 0;
    for (const [h, n] of Object.entries(s.other || {})) other[h] = (other[h] || 0) + n;
  }
  return {
    sources: (list?.sources || []).map(({ id, kind, name, file, columns, rows: r, addedAt, afterLaunch, urls }) => ({ id, kind, name, file, columns, rows: r, addresses: urls.length, addedAt, afterLaunch: !!afterLaunch })),
    rows, invalid, assets, otherCount: Object.values(other).reduce((a, b) => a + b, 0),
    other: Object.entries(other).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([host, n]) => ({ host, n })),
  };
}

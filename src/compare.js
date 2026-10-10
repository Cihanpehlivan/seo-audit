// Compares two crawls: old site (before renewal) and new site (staging or live).
// Pages are matched by URL path, not by host, because the two sites usually run on different hosts.
import { isOk, isIndexable, isNoindex } from './rules/helpers.js';

export function pathKey(url) {
  const u = new URL(url);
  let p = u.pathname.replace(/\/+$/, '') || '/';
  try { p = decodeURI(p); } catch {}
  return p + u.search;
}

const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
const FIELDS = [
  ['title', 'Title', (p) => p.title || ''],
  ['meta', 'Meta description', (p) => p.metaDescription || ''],
  ['h1', 'H1', (p) => first(p.h1)],
];

// Content changes between the old and the new version of the same page.
function diffPage(o, n) {
  const out = [];
  for (const [field, label, get] of FIELDS) {
    const a = get(o).trim(), b = get(n).trim();
    if (a && !b) out.push({ field, label, kind: 'lost', old: a, new: '' });
    else if (a !== b) out.push({ field, label, kind: 'changed', old: a, new: b });
  }
  if (isIndexable(o) && isNoindex(n)) out.push({ field: 'noindex', label: 'İndekslenme', kind: 'lost', old: 'indexlenebilir', new: 'noindex' });
  return out;
}

const side = (r) => ({ host: r.meta.host, startUrl: r.meta.startUrl, startedAt: r.meta.startedAt, pages: r.pages.length, limitReached: !!r.meta.limitReached, cancelled: !!r.meta.cancelled });

export function compareCrawls(oldRes, newRes) {
  const newByKey = new Map();
  for (const p of newRes.pages) {
    const k = pathKey(p.url);
    // A page that answered wins over a redirect or an error with the same path.
    if (!newByKey.has(k) || (isOk(p) && !isOk(newByKey.get(k)))) newByKey.set(k, p);
  }
  const oldKeys = new Set();
  const rows = { lost: [], redirected: [], changed: [], same: 0, unlinked: [], unknown: [], added: [] };

  for (const o of oldRes.pages.filter(isOk)) {
    const key = pathKey(o.url);
    if (oldKeys.has(key)) continue;
    oldKeys.add(key);
    const base = { path: key, oldUrl: o.url, oldTitle: o.title || '', indexable: isIndexable(o), inlinks: o.inlinks || 0 };
    const n = newByKey.get(key);
    if (!n) { rows.lost.push({ ...base, reason: 'Yeni sitede bulunamadı', newStatus: null, probe: true }); continue; }
    if (n.blockedByRobots) { rows.unknown.push({ ...base, newUrl: n.url, reason: 'robots.txt engeli, taranmadı' }); continue; }
    if (n.status === 0) { rows.unknown.push({ ...base, newUrl: n.url, reason: `Bağlantı hatası (${n.error || 'yanıt yok'})` }); continue; }
    if (n.redirectChain?.length) {
      rows.redirected.push({ ...base, newUrl: n.url, target: n.finalUrl, status: n.status, finalStatus: n.finalStatus, hops: n.redirectChain.length, targetBroken: !(n.finalStatus >= 200 && n.finalStatus < 300) });
      continue;
    }
    if (n.status >= 400) { rows.lost.push({ ...base, reason: `Yeni sitede ${n.status} veriyor`, newStatus: n.status, newUrl: n.url }); continue; }
    if (!isOk(n)) { rows.unknown.push({ ...base, newUrl: n.url, reason: `HTML değil (${n.status}, ${n.contentType || 'tür yok'})` }); continue; }
    const changes = diffPage(o, n);
    if (changes.length) rows.changed.push({ ...base, newUrl: n.url, newTitle: n.title || '', changes, lostCount: changes.filter((c) => c.kind === 'lost').length });
    else rows.same++;
  }

  for (const n of newRes.pages.filter(isOk)) {
    const key = pathKey(n.url);
    if (!oldKeys.has(key) && newByKey.get(key) === n) rows.added.push({ path: key, newUrl: n.url, newTitle: n.title || '', indexable: isIndexable(n) });
  }

  // Important pages first: indexable, then many internal links on the old site.
  const byWeight = (a, b) => (b.indexable - a.indexable) || (b.inlinks - a.inlinks) || a.path.localeCompare(b.path);
  rows.lost.sort(byWeight); rows.redirected.sort(byWeight); rows.unknown.sort(byWeight);
  rows.changed.sort((a, b) => (b.lostCount - a.lostCount) || byWeight(a, b));
  rows.added.sort((a, b) => a.path.localeCompare(b.path));

  const warnings = [];
  if (newRes.meta.limitReached) warnings.push('Yeni site taraması URL limitine ulaştı. Bazı "kaybolan" sayfalar sadece taranmamış olabilir.');
  if (oldRes.meta.limitReached) warnings.push('Eski site taraması URL limitine ulaştı. Eski sitenin bütün sayfaları listede değil.');
  if (newRes.meta.cancelled || oldRes.meta.cancelled) warnings.push('Taramalardan biri yarıda durduruldu. Sonuçlar eksik olabilir.');

  const cmp = { old: side(oldRes), new: side(newRes), baseWarnings: warnings, rows, probed: 0 };
  summarize(cmp, oldKeys.size);
  return cmp;
}

function summarize(cmp, oldPages = cmp.summary.oldPages) {
  const { rows } = cmp;
  cmp.warnings = [...cmp.baseWarnings];
  if (rows.unknown.length) cmp.warnings.push(`${rows.unknown.length} sayfa yeni sitede kontrol edilemedi. Neden: robots.txt engeli, şifreli staging veya bağlantı hatası. Liste "Kontrol edilemedi" bölümünde.`);
  cmp.summary = {
      oldPages, lost: rows.lost.length, redirected: rows.redirected.length, unlinked: rows.unlinked.length,
      redirectBroken: rows.redirected.filter((r) => r.targetBroken).length,
      changed: rows.changed.length, contentLost: rows.changed.filter((r) => r.lostCount).length,
      same: rows.same, unknown: rows.unknown.length, added: rows.added.length,
      kept: oldPages ? Math.round(((rows.same + rows.changed.length + rows.unlinked.length) / oldPages) * 100) : 0,
  };
}

// The new crawl follows only the links of the new site. Old URLs live on as 301s with no links to them,
// so every old path that the new crawl did not see is requested on the new host one by one.
// request(url) → { status, location, contentType } for one hop (no redirect following), or throws.
export async function probeLost(cmp, newOrigin, request, { concurrency = 5, maxHops = 5 } = {}) {
  const todo = cmp.rows.lost.filter((r) => r.probe);
  let i = 0;
  const results = new Map();
  const worker = async () => {
    while (i < todo.length) {
      const r = todo[i++];
      const chain = [];
      let url = newOrigin + r.path, res = null, error = null;
      try {
        for (let hop = 0; hop <= maxHops; hop++) {
          res = await request(url);
          if (res.status >= 300 && res.status < 400 && res.location) { chain.push(res.status); url = new URL(res.location, url).href; continue; }
          break;
        }
      } catch (e) { error = e.cause?.code || e.message || 'hata'; }
      results.set(r, { chain, url, res, error });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));

  const lost = [];
  for (const r of cmp.rows.lost) {
    const x = results.get(r);
    delete r.probe;
    if (!x) { lost.push(r); continue; }
    const { chain, url, res, error } = x;
    const newUrl = newOrigin + r.path;
    if (error) { cmp.rows.unknown.push({ ...r, newUrl, reason: `Yeni sitede istenemedi (${error})` }); continue; }
    const st = res.status;
    if (chain.length) {
      cmp.rows.redirected.push({ ...r, newUrl, target: url, status: chain[0], finalStatus: st, hops: chain.length, targetBroken: !(st >= 200 && st < 300) });
    } else if (st === 401 || st === 403) {
      cmp.rows.unknown.push({ ...r, newUrl, reason: `Erişim engeli (${st}). Staging şifreli olabilir.` });
    } else if (st >= 200 && st < 300) {
      cmp.rows.unlinked.push({ ...r, newUrl, reason: `Açılıyor (${st}) ama yeni sitede bu sayfaya link yok` });
    } else {
      lost.push({ ...r, newUrl, newStatus: st, reason: `Yeni sitede ${st} veriyor` });
    }
  }
  cmp.rows.lost = lost;
  cmp.probed = results.size;
  const byWeight = (a, b) => (b.indexable - a.indexable) || (b.inlinks - a.inlinks) || a.path.localeCompare(b.path);
  cmp.rows.redirected.sort(byWeight); cmp.rows.unknown.sort(byWeight); cmp.rows.unlinked.sort(byWeight);
  summarize(cmp);
  return cmp;
}

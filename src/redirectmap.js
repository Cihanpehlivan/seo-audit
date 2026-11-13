// 301 map (v0.8.0, Sprint 3 Part 2). For every old page that needs a new address, the tool suggests a new page.
// Signals: slug words, title, H1, content (simhash). Words are weighted by rarity (IDF): words on many new pages
// (istanbul, procedures) count little. A rare shared word counts much. No new dependency.
//
// Map rows:
//   rule     the section rule already moves the page and the target page exists (moved, no301).
//   approved the user approved a suggestion or wrote an address.      gone: the user chose 410.
//   pending  a suggestion waits for approval.                          none: no suggestion (score too low).
//   follow   v0.12.2: an old redirect (kind 'follow'). It takes the new address of its target (or its 410).
//   wait     v0.12.2: an old redirect whose target has no decision yet. It follows when the target gets one.
// Only user decisions are saved in the project (project.map). Suggestions are computed again on every match.
import { trafficCompare, trafficOf } from './urllist.js';
import { pathKey, langCode } from './compare.js';
import { isOk, isNoindex, isStagingHost } from './rules/helpers.js';

const TR = { ğ: 'g', ü: 'u', ş: 's', ı: 'i', ö: 'o', ç: 'c', İ: 'i' };
export function words(text, stop = new Set()) {
  return String(text || '').toLocaleLowerCase('tr').replace(/[ğüşıöçİ]/g, (c) => TR[c])
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !stop.has(w));
}
const firstSeg = (key) => key.split('?')[0].split('/')[1] || '';
const slugWords = (key, stop) => { let p = key.split('?')[0]; try { p = decodeURIComponent(p); } catch {} return words(p.replace(/[/_.-]+/g, ' '), stop); };
const first = (v) => (Array.isArray(v) ? v[0] : v) || '';

// Two words match when equal (1), when they share a long prefix (0.8: estetik ~ estetigi), or when they are
// close in spelling (0.7: prosedur ~ procedures, rinoplasti ~ rhinoplasty). Only words of 5 or more letters.
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const matchMemo = new Map();
function wordMatch(a, b) {
  if (a === b) return 1;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  let v = matchMemo.get(key);
  if (v === undefined) {
    v = wordMatchRaw(a, b);
    if (matchMemo.size > 500000) matchMemo.clear();
    matchMemo.set(key, v);
  }
  return v;
}
function wordMatchRaw(a, b) {
  const n = Math.min(a.length, b.length), m = Math.max(a.length, b.length);
  if (n < 5) return 0;
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i >= 5 && i >= 0.75 * n) return 0.8;
  if (m - n > 3 || a[0] !== b[0]) return 0;
  return 1 - editDistance(a, b) / m >= 0.7 ? 0.7 : 0;
}
// Weighted Dice similarity of two word lists. Returns { sim, shared: words of A that matched }.
function similarity(A, B, idf) {
  const a = [...new Set(A)], b = [...new Set(B)];
  if (!a.length || !b.length) return null;
  let wa = 0, wb = 0, ma = 0, mb = 0;
  const shared = [];
  for (const x of a) {
    const w = idf(x); wa += w;
    let best = 0;
    for (const y of b) { const m = wordMatch(x, y); if (m > best) best = m; if (best === 1) break; }
    if (best) { ma += w * best; shared.push(x); }
  }
  for (const y of b) {
    const w = idf(y); wb += w;
    let best = 0;
    for (const x of a) { const m = wordMatch(x, y); if (m > best) best = m; if (best === 1) break; }
    mb += w * best;
  }
  // Half Dice (both sides alike), half coverage of the better covered side: a short new slug (/facelift) that
  // the old page fully contains is a strong match, even when the old slug has extra words (turkey).
  const dice = (ma + mb) / (wa + wb), cover = Math.max(ma / wa, mb / wb);
  return { sim: (dice + cover) / 2, shared };
}
// simhash: 16 hex chars. Distance 0-64. Near copies are ≤ 3, unrelated pages are near 32.
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) { d += x & 1; x >>>= 1; }
  }
  return d;
}

// The new pages a suggestion may point to: answered HTML pages, not noindex. The home page of a site is not in the
// pool: a mass 301 to the home page is a soft 404. v0.8.1: it is a candidate only for an old home page (homes).
// sites: [{ key, host, origin, liveOrigin, pages }]
function candidatePool(sites, stop) {
  const pool = [], homes = [];
  for (const s of sites) {
    const seen = new Set();
    for (const p of s.pages) {
      if (!isOk(p) || isNoindex(p) || p.redirectChain?.length) continue;
      const key = pathKey(p.url);
      if (seen.has(key)) continue;
      seen.add(key);
      const lang = langCode(p.htmlLang);
      if (key === '/') { homes.push({ site: s.key, path: key, url: p.url, title: p.title || '', lang }); continue; }
      pool.push({ site: s.key, path: key, url: p.url, title: p.title || '', seg: firstSeg(key), lang,
        slug: slugWords(key, stop), titleW: words(p.title, stop), h1W: words(first(p.h1), stop), simhash: p.simhash || null });
    }
  }
  return { pool, homes };
}

// v0.8.1: an old page is a home page when its last path segment is a home word (home, anasayfa, page-daccueil)
// or when it is the root of a language section (/tr, /fr, /en-gb).
export function isHomeLike(path, cfg) {
  const segs = path.split('?')[0].split('/').filter(Boolean);
  if (!segs.length) return false;
  let last = segs[segs.length - 1];
  try { last = decodeURIComponent(last); } catch {}
  last = last.toLowerCase();
  return (cfg.homeSlugs || []).includes(last) || (segs.length === 1 && /^[a-z]{2}(-[a-z]{2})?$/.test(last));
}

export const confOf = (score, t) => (score >= t.high ? 'high' : score >= t.mid ? 'mid' : score >= t.low ? 'low' : null);
const CONF_TEXT = { high: 'Yüksek', mid: 'Orta', low: 'Düşük' };

// Scores old pages against the pool. olds: [{ path, title, h1, simhash, prefer (site key or null), lang, dropped, home }].
// v0.8.1: the search is narrowed before scoring, in this order:
//   1. Language: when the old page has a language and a new page has the same language, only those pages.
//   2. Else, when the old page has a language that no new site has: the heir only (the site on the old domain).
//      A French page goes to the English site, never to the Turkish site. No heir candidate: no suggestion.
//      When the languages are unknown and the section is removed: the heir, if it has candidates.
//   3. Section decision (prefer): only that site, if it still has candidates.
// Returns Map path → candidates (best first, score ≥ low, at most cfg.maxCandidates).
export function suggestTargets(olds, sites, cfg) {
  const stop = new Set(cfg.stopWords || []);
  const { pool, homes } = candidatePool(sites, stop);
  const poolLangs = new Set(pool.map((c) => c.lang).filter(Boolean));
  const heirKey = sites[0]?.key;
  const narrow = (o, list) => {
    if (o.lang && poolLangs.has(o.lang)) list = list.filter((c) => c.lang === o.lang);
    else if (o.lang && poolLangs.size) list = list.filter((c) => c.site === heirKey); // no site in this language: heir only
    else if (o.dropped && list.some((c) => c.site === heirKey)) list = list.filter((c) => c.site === heirKey);
    if (o.prefer && list.some((c) => c.site === o.prefer)) list = list.filter((c) => c.site === o.prefer);
    return list;
  };
  const N = pool.length;
  const out = new Map();
  if (!N || !olds.length) { for (const o of olds) out.set(o.path, []); return out; }
  // Document frequency over slug, title and H1 words of the pool AND of the old pages. A word on many old pages
  // (istanbul, prosedur) is weak too, even when no new page has it.
  const df = new Map(), index = new Map();
  pool.forEach((c, i) => {
    for (const w of new Set([...c.slug, ...c.titleW, ...c.h1W])) {
      df.set(w, (df.get(w) || 0) + 1);
      (index.get(w) || index.set(w, []).get(w)).push(i);
    }
  });
  const oldWords = olds.map((o) => ({ ...o, slug: slugWords(o.path, stop), titleW: words(o.title, stop), h1W: words(o.h1, stop),
    segW: o.path.split('/').length > 2 ? words(firstSeg(o.path), stop) : [] }));
  for (const o of oldWords) for (const w of new Set([...o.slug, ...o.titleW, ...o.h1W])) df.set(w, (df.get(w) || 0) + 1);
  const D = N + oldWords.length;
  const idfMemo = new Map();
  const idf = (w) => { let v = idfMemo.get(w); if (v === undefined) idfMemo.set(w, (v = Math.log(1 + D / (1 + (df.get(w) || 0))))); return v; };
  const maxDf = N >= 20 ? Math.max(2, Math.floor(N * cfg.maxDfRatio)) : Infinity;
  // Words for the candidate search: exact words and their 5-letter prefix (for the prefix match).
  const prefixIndex = new Map();
  for (const [w, list] of index) if (w.length >= 5) { const k = w.slice(0, 5); (prefixIndex.get(k) || prefixIndex.set(k, []).get(k)).push(...list); }
  const W = cfg.weights;

  const scoreOne = (o, c) => {
    const parts = [], why = [];
    const s = similarity(o.slug, c.slug, idf);
    if (s) {
      parts.push([W.slug, s.sim]);
      // The section word (prosedur) is no reason to show. Show the topic words.
      const topic = s.shared.filter((w) => !o.segW.includes(w));
      if (topic.length && s.sim >= 0.2) why.push(`Slug ortak: ${topic.slice(0, 3).join(', ')}`);
    }
    const t = similarity(o.titleW, c.titleW, idf);
    if (t) { parts.push([W.title, t.sim]); if (t.sim >= 0.3) why.push(`Title %${Math.round(t.sim * 100)} benzer`); }
    const h = similarity(o.h1W, c.h1W, idf);
    if (h) { parts.push([W.h1, h.sim]); if (h.sim >= 0.95) why.push('H1 aynı'); else if (h.sim >= 0.3) why.push(`H1 %${Math.round(h.sim * 100)} benzer`); }
    if (o.simhash && c.simhash) {
      const d = hamming(o.simhash, c.simhash);
      const sim = Math.max(0, Math.min(1, 1 - (d - 3) / 21));
      parts.push([W.content, sim]);
      if (sim >= 0.6) why.push('İçerik benzer');
    }
    const wsum = parts.reduce((a, [w]) => a + w, 0);
    const fields = wsum ? parts.reduce((a, [w, v]) => a + w * v, 0) / wsum : 0;
    // All words together: a topic word in the old slug may be in the new title only (eyelid → /blepharoplasty).
    const bag = similarity([...o.slug, ...o.titleW, ...o.h1W], [...c.slug, ...c.titleW, ...c.h1W], idf)?.sim || 0;
    const score = Math.round((cfg.bagWeight * bag + (1 - cfg.bagWeight) * fields) * 100);
    return { score, why };
  };

  const scored = oldWords.map((ow) => {
    const o = ow;
    // Quick pre-score: shared words by rarity. Only the best cfg.maxScored pages get the full score.
    const pre = new Map();
    for (const w of new Set([...ow.slug, ...ow.titleW, ...ow.h1W])) {
      const list = index.get(w), wi = idf(w);
      if (list && list.length <= maxDf) for (const i of list) pre.set(i, (pre.get(i) || 0) + wi);
      if (w.length >= 5) {
        const pl = prefixIndex.get(w.slice(0, 5));
        if (pl && pl.length <= maxDf) for (const i of pl) pre.set(i, (pre.get(i) || 0) + wi / 2);
      }
    }
    let list = narrow(o, [...pre].sort((a, b) => b[1] - a[1]).map(([i]) => pool[i]));
    list = list.slice(0, cfg.maxScored);
    const cands = list.map((c) => ({ c, ...scoreOne(ow, c) })).filter((x) => x.score > 0);
    return { o, seg: firstSeg(o.path), cands };
  });

  // Same section: when most good matches of an old section go to one new section, the other pages of the
  // old section get a bonus for that new section (/prosedur/ → /procedures/).
  const pairs = new Map();
  for (const r of scored) {
    if (!r.seg) continue;
    const best = r.cands.reduce((a, x) => (!a || x.score > a.score ? x : a), null);
    if (!best || best.score < cfg.mid) continue;
    const m = pairs.get(r.seg) || pairs.set(r.seg, new Map()).get(r.seg);
    const k = `${best.c.site}|${best.c.seg}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  const bonusOf = new Map();
  for (const [seg, m] of pairs) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [k, n] = [...m].sort((a, b) => b[1] - a[1])[0];
    if (n >= cfg.sectionMinPairs && n / total >= cfg.sectionMinRatio) bonusOf.set(seg, k);
  }
  for (const r of scored) {
    const k = bonusOf.get(r.seg);
    const list = r.cands.map((x) => {
      const hit = k && `${x.c.site}|${x.c.seg}` === k && x.c.seg;
      const score = hit ? Math.min(100, x.score + cfg.sectionBonus) : x.score;
      const why = hit ? [...x.why, `Aynı bölüm (/${r.seg}/ → /${x.c.seg}/)`] : x.why;
      return { site: x.c.site, path: x.c.path, url: x.c.url, title: x.c.title, score, conf: confOf(score, cfg), why: why.join(' · ') };
    }).filter((x) => x.conf).sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path));
    // An old home page: the home page of the right site comes first (same language, else the heir).
    const home = r.o.home && (narrow(r.o, homes)[0] || homes.find((h) => h.site === heirKey));
    if (home) {
      const score = cfg.homeScore;
      list.unshift({ site: home.site, path: '/', url: home.url, title: home.title, score, conf: confOf(score, cfg), why: 'Eski sayfa bir ana sayfa' });
    }
    out.set(r.o.path, list.slice(0, cfg.maxCandidates));
  }
  return out;
}

// Builds the map rows. cmp: the project comparison (after the requests). oldRes: old crawl.
// sites: [{ key, host, origin, liveOrigin, pages }] (heir first). decisions: project.map.
// traffic (v0.12.0): path → { clicks, impressions, views, links } from the old address list. Rows show it and sort by it.
// redirects (v0.12.2): old redirects (src/urllist.js → oldRedirects). staging: { stagingHosts, stagingSuffixes }.
export function buildRedirectMap(cmp, oldRes, sites, decisions = {}, cfg, traffic = null, { redirects = [], staging = null } = {}) {
  const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
  const siteOfHost = (h) => sites.find((s) => bare(s.host) === bare(h));
  const byKey = new Map(sites.map((s) => [s.key, s]));
  const liveUrl = (key, path) => { const s = byKey.get(key); return s ? new URL(path, s.liveOrigin || s.origin).href : ''; };
  const oldPage = new Map();
  for (const p of oldRes.pages) { const k = pathKey(p.url); if (isOk(p) && !oldPage.has(k)) oldPage.set(k, p); }
  // Pages in the crawls of the target sites: an approved target that is not here gets a warning.
  const inCrawl = new Set();
  for (const s of sites) for (const p of s.pages) if (isOk(p) || p.redirectChain?.length) inCrawl.add(`${s.key}|${pathKey(p.url)}`);

  const rows = [];
  const R = cmp.rows;
  for (const r of [...R.moved, ...R.no301]) {
    const s = siteOfHost(r.site) || sites[0];
    const path = r.newUrl ? pathKey(r.newUrl) : r.newPath;
    rows.push({ path: r.path, oldUrl: r.oldUrl, oldTitle: r.oldTitle, kind: 'rule', installed: R.moved.includes(r),
      target: { site: s.key, path, url: liveUrl(s.key, path) }, why: `Kural: ${r.rule}`, rule: r.rule });
  }
  // Pages without a working new address. A broken redirect also needs a new target.
  const need = [...R.lost, ...R.notarget, ...(R.removed || []), ...R.redirected.filter((r) => r.targetBroken)];
  const olds = need.map((r) => {
    const p = oldPage.get(r.path) || {};
    const prefer = r.rule && !r.dropped ? siteOfHost(r.site)?.key || null : null;
    return { path: r.path, title: r.oldTitle || p.title || '', h1: first(p.h1), simhash: p.simhash || null, prefer,
      lang: langCode(p.htmlLang), dropped: !!r.dropped, home: isHomeLike(r.path, cfg) };
  });
  // v0.12.2: an old redirect to an address that is not an old page (a page without links that the list crawl did not
  // keep, a file) has no target row to follow: it gets its own suggestion from the target's address.
  const R0 = new Set(need.map((r) => r.path));
  const follows = redirects.filter((rd) => !oldPage.has(rd.path) && !R0.has(rd.path) && !rd.broken);
  const extra = new Map();
  for (const rd of follows) {
    if (rd.off || oldPage.has(rd.toPath) || extra.has(rd.toPath)) continue;
    extra.set(rd.toPath, { path: rd.toPath, title: '', h1: '', simhash: null, prefer: null, lang: '', dropped: false, home: isHomeLike(rd.toPath, cfg) });
  }
  const sug = suggestTargets([...olds, ...extra.values()], sites, cfg);
  for (const r of need) {
    const cands = (sug.get(r.path) || []).map((c) => ({ ...c, url: liveUrl(c.site, c.path) }));
    rows.push({ path: r.path, oldUrl: r.oldUrl, oldTitle: r.oldTitle, kind: 'suggest', candidates: cands, from: r.dropped ? 'removed' : r.targetBroken ? 'broken' : r.moved ? 'notarget' : 'lost' });
  }

  // User decisions win over rules and suggestions.
  const decide = (row) => {
    const d = decisions[row.path];
    if (d?.gone) { Object.assign(row, { status: 'gone', target: null, decision: d }); return true; }
    if (d && (d.site || d.url)) {
      const t = d.url ? { site: null, path: '', url: d.url } : { site: d.site, path: d.path, url: liveUrl(d.site, d.path) };
      const warn = d.site && !byKey.has(d.site) ? 'Hedef site projede yok. Adresi tekrar seçin.'
        : d.site && !inCrawl.has(`${d.site}|${d.path}`) ? 'Hedef sayfa son taramada yok. Sayfayı kontrol edin.' : '';
      Object.assign(row, { status: 'approved', target: t, decision: d, warn });
      return true;
    }
    return false;
  };
  const suggestState = (row) => {
    const best = row.candidates[0];
    if (best) Object.assign(row, { status: 'pending', target: best.ext ? { site: null, path: '', url: best.url } : { site: best.site, path: best.path, url: best.url }, score: best.score, conf: best.conf, why: best.why });
    else Object.assign(row, { status: 'none', target: null, why: row.noneWhy || 'Benzer sayfa yok. En yakın sayfayı seçin veya 410 verin. Ana sayfaya toplu 301 vermeyin: Google bunu soft 404 sayar.' });
  };
  for (const row of rows) {
    if (decide(row)) continue;
    if (row.kind === 'rule') { row.status = 'rule'; continue; }
    suggestState(row);
  }

  // v0.12.2: old redirects (/indirim → /kampanya on the old site). After launch the old server rules are gone. The row
  // takes the new address of its target in one step (/indirim → /yeni/kampanya): no chain. The row saves nothing:
  // it follows the target on every match. A decision of the user on the row wins (another address or 410).
  // Not a row: a redirect to an address that fails on the old site (the list screen shows it), and an address that
  // the heir already serves as a page (the new site owns the address).
  const stgCfg = staging || { stagingHosts: [], stagingSuffixes: [] };
  const isStg = (h) => sites.some((s) => bare(s.host) === bare(h) && (!s.liveOrigin || bare(new URL(s.liveOrigin).hostname) !== bare(h))) || isStagingHost(bare(h), stgCfg);
  const heirPage = new Map();
  for (const p of sites[0]?.pages || []) { try { const k = pathKey(p.url); if (!heirPage.has(k) || isOk(p)) heirPage.set(k, p); } catch {} }
  const mapRow = new Map(rows.map((r) => [r.path, r]));
  const redirected = new Map(R.redirected.filter((r) => !r.targetBroken && r.target).map((r) => [r.path, r]));
  const unknownKeys = new Set([...R.unknown, ...(R.moving || [])].map((r) => r.path));
  const heirKey = sites[0]?.key;
  for (const rd of follows) {
    if (mapRow.has(rd.path)) continue;
    const hp = heirPage.get(rd.path);
    if (hp && isOk(hp)) continue;
    const row = { path: rd.path, oldUrl: rd.oldUrl, oldTitle: '', kind: 'follow', candidates: [],
      follow: { path: rd.toPath, url: rd.to, off: rd.off, hops: rd.hops, src: rd.src } };
    rows.push(row);
    mapRow.set(rd.path, row);
    if (rd.off) {
      // Another domain: the old site sent the address there on purpose. The tool does not carry it over by itself.
      const h = new URL(rd.to).hostname;
      if (isStg(h)) row.noneWhy = 'Eski site bu adresi staging alan adına yönlendiriyordu. 301 hedefi canlı alan adıdır. Adres seçin veya 410 verin.';
      else row.candidates = [{ ext: true, site: null, path: '', url: rd.to, score: null, conf: null, why: 'Eski site bu adresi başka alan adına yönlendiriyordu. Aynı adresi onaylayın veya başka adres seçin.' }];
      if (!decide(row)) suggestState(row);
      continue;
    }
    if (!oldPage.has(rd.toPath)) {
      // The target is not an old page: no decision to follow. Suggestion from the target's address.
      row.candidates = (sug.get(rd.toPath) || []).map((c) => ({ ...c, url: liveUrl(c.site, c.path), why: `Eski hedef ${rd.toPath}: ${c.why}` }));
      row.noneWhy = `Eski hedef ${rd.toPath} eski sayfa değil. Benzer sayfa yok. Adres seçin veya 410 verin.`;
      if (!decide(row)) suggestState(row);
      continue;
    }
    if (decide(row)) continue;
    const m = mapRow.get(rd.toPath);
    if (m && (m.status === 'rule' || m.status === 'approved')) Object.assign(row, { status: 'follow', target: { ...m.target } });
    else if (m && m.status === 'gone') Object.assign(row, { status: 'follow', gone: true, target: null });
    else if (m) Object.assign(row, { status: 'wait', target: null, hint: m.target?.url || '' });
    else if (redirected.has(rd.toPath)) {
      // Staging already redirects the target: the same page, with its live address.
      const t = redirected.get(rd.toPath).target;
      const s = siteOfHost(new URL(t).hostname);
      Object.assign(row, { status: 'follow', target: s ? { site: s.key, path: pathKey(t), url: liveUrl(s.key, pathKey(t)) } : { site: null, path: '', url: t } });
    } else if (unknownKeys.has(rd.toPath)) Object.assign(row, { status: 'wait', target: null, hint: '' });
    // The target is on the heir at the same path: the live old domain serves it.
    else Object.assign(row, { status: 'follow', target: { site: heirKey, path: rd.toPath, url: liveUrl(heirKey, rd.toPath) } });
    if (row.status === 'follow' && row.target && (rd.toPath === '/' || isHomeLike(rd.toPath, cfg))) row.warn = 'Eski site bu adresi ana sayfaya yönlendiriyordu. Google bunu soft 404 sayabilir. Daha yakın bir sayfa varsa onu seçin.';
  }
  // Staging state of a redirect row: the heir crawl found the address as a redirect (no new request).
  for (const row of rows) {
    if (row.kind !== 'follow' || !row.target?.url) continue;
    const hp = heirPage.get(row.path);
    if (!hp?.redirectChain?.length || !hp.finalUrl) continue;
    const s = row.target.site ? byKey.get(row.target.site) : null;
    let ok;
    try {
      const fh = bare(new URL(hp.finalUrl).hostname);
      const hosts = s ? [s.host, s.liveOrigin ? new URL(s.liveOrigin).hostname : ''].map(bare) : [bare(new URL(row.target.url).hostname)];
      ok = pathKey(hp.finalUrl) === pathKey(row.target.url) && hosts.includes(fh);
    } catch { ok = false; }
    Object.assign(row, ok ? { staging: 'installed' } : { staging: 'other', stagingTo: hp.finalUrl });
  }
  // v0.12.0: inside every state, the page with more traffic comes first. A page from the old address list is marked.
  for (const row of rows) {
    const t = traffic?.get(row.path);
    if (t) row.traffic = trafficOf(t);
    if (oldPage.get(row.path)?.discoveredBy === 'list' || row.follow?.src === 'list') row.fromList = true;
    // v0.12.1: a late address (never asked on the old site) has no title, H1 or content: the suggestion uses the address only.
    if (oldPage.get(row.path)?.late) row.late = true;
  }
  const tr = (r) => traffic?.get(r.path) || null;
  const order = { pending: 0, none: 1, approved: 2, gone: 3, rule: 4, wait: 5, follow: 6 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || trafficCompare(tr(a), tr(b)) || ((b.score || 0) - (a.score || 0)) || a.path.localeCompare(b.path));
  const count = (st) => rows.filter((r) => r.status === st).length;
  const summary = {
    total: rows.length, rule: count('rule'), approved: count('approved'), gone: count('gone'), pending: count('pending'), none: count('none'),
    high: rows.filter((r) => r.status === 'pending' && r.conf === 'high').length, warn: rows.filter((r) => r.warn).length,
    // v0.12.2: old redirects: rows that follow their target, rows that wait for the target's decision, all redirect rows.
    follow: count('follow'), wait: count('wait'), redirects: rows.filter((r) => r.kind === 'follow').length,
    // Decisions for pages that no longer need a new address (the old page is gone or now found).
    stale: Object.keys(decisions).filter((k) => !rows.some((r) => r.path === k)).length,
  };
  return { rows, summary, confText: CONF_TEXT };
}

// Final list for the developer: rule rows, approved rows (301) and gone rows (410).
const CSV_SAFE = (v) => { const s = String(v ?? ''); const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export function mapCsv(map) {
  const src = (r) => (r.status === 'rule' ? 'Kural' : r.status === 'follow' ? 'Eski yönlendirme' : r.decision?.src === 'elle' ? 'Elle' : 'Onay');
  const lines = [['eski_url', 'yeni_url', 'durum', 'kaynak'].join(',')];
  for (const r of map.rows) {
    if (!['rule', 'approved', 'gone', 'follow'].includes(r.status)) continue;
    const gone = r.status === 'gone' || (r.status === 'follow' && r.gone);
    lines.push([r.oldUrl, gone ? '' : r.target.url, gone ? '410' : '301', src(r)].map(CSV_SAFE).join(','));
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

// Checks project.map from the browser or from a project file. Entries: { site, path, src } | { url, src } | { gone: true }.
export function cleanDecision(d, siteKeys) {
  if (!d || typeof d !== 'object') return null;
  const src = d.src === 'elle' ? 'elle' : 'oneri';
  if (d.gone) return { gone: true, src };
  if (d.url) {
    let u;
    try { u = new URL(String(d.url)); } catch { return null; }
    return /^https?:$/.test(u.protocol) ? { url: u.href.slice(0, 2000), src } : null;
  }
  if (d.site && siteKeys.has(String(d.site))) {
    const p = String(d.path || '');
    if (!p.startsWith('/') || p.length > 2000) return null;
    return { site: String(d.site), path: pathKey('http://x' + p), src };
  }
  return null;
}

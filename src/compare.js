// Compares two or more crawls: the old site (before renewal) and one or more new sites (staging or live).
// Pages are matched by URL path, not by host, because the sites usually run on different hosts.
// Path rules move old paths to other paths or other targets: /tr/* → tr.ornek.com/*, /en/* → /*.
// Every row explains itself: which rule, which URL was checked, what to do.
import { isOk, isIndexable, isNoindex } from './rules/helpers.js';

export function pathKey(url) {
  const u = new URL(url);
  let p = u.pathname.replace(/\/+$/, '') || '/';
  try { p = decodeURI(p); } catch {}
  return p + u.search;
}
// Path written by a person or by a rule → the same key form as pathKey.
const keyOf = (p) => pathKey('http://x' + ('/' + p).replace(/\/{2,}/g, '/'));
const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const pathPart = (key) => key.split('?')[0];
const firstSeg = (key) => pathPart(key).split('/')[1] || '';

// ---------- Path rules ----------
// { from: '/tr/*', host: 'tr.ornek.com', to: '/*' }  → old /tr/x is expected at tr.ornek.com/x
// { from: '/en/*', to: '/*' }                         → host empty = heir: the site that takes the old domain (first new crawl)
// { from: '/fr/*', drop: true }                       → section removed on purpose: not found = "Bölüm kaldırıldı"
// "*" is allowed only at the end. "/tr/" is read as "/tr/*". The longest "from" wins.
function pattern(s, field) {
  let v = String(s ?? '').trim();
  if (!v.startsWith('/')) throw new Error(`${field} "/" ile başlamalı: ${v || '(boş)'}`);
  if (v.length > 1 && v.endsWith('/')) v += '*';
  const star = v.endsWith('/*');
  const body = star ? v.slice(0, -2) : v;
  if (body.includes('*')) throw new Error(`${field} içinde "*" sadece sonda olabilir: ${v}`);
  const base = star ? (body ? keyOf(body) : '') : keyOf(body);
  return { text: star ? `${base}/*` : base, base: base === '/' && star ? '' : base, star };
}

export function parseRule(r) {
  if (!r || typeof r !== 'object') throw new Error('Kural okunamadı.');
  const from = pattern(r.from, 'Eski yol');
  const host = bareHost(String(r.host || '').trim().replace(/^[a-z]+:\/\//i, '')).replace(/[/:?#].*$/, '');
  if (host && !/^[a-z0-9.-]+$/.test(host)) throw new Error(`Hedef alan adı geçersiz: ${r.host}`);
  if (r.drop) return { from: from.text, drop: true, f: from, text: `${from.text} → bölüm kaldırıldı` };
  const to = pattern(r.to ?? '/*', 'Yeni yol');
  return { from: from.text, host, to: to.text, f: from, t: to, text: `${from.text} → ${host || 'geçecek site '}${to.text}` };
}

// Longest "from" first, exact before "*" at the same length. Same "from" twice: the first one stays.
export function parseRules(list, max = 50) {
  if (!Array.isArray(list)) throw new Error('Kurallar liste olmalı.');
  if (list.length > max) throw new Error(`En fazla ${max} kural yazılabilir.`);
  const seen = new Set(), out = [];
  list.forEach((r, i) => {
    let p;
    try { p = parseRule(r); } catch (e) { throw new Error(`Kural ${i + 1}: ${e.message}`); }
    if (!seen.has(p.from)) { seen.add(p.from); out.push(p); }
  });
  return out.sort((a, b) => (b.f.base.length - a.f.base.length) || (a.f.star - b.f.star));
}

function ruleMatches(rule, key) {
  const { base, star } = rule.f;
  if (!star) return key === base;
  const p = pathPart(key);
  return !base || p === base || p.startsWith(base + '/');
}
function applyRule(rule, key) {
  const rest = rule.f.star ? key.slice(rule.f.base.length) : '';
  return keyOf(rule.t.star ? rule.t.base + rest : rule.t.base || '/');
}

// ---------- Comparison ----------
const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
const FIELDS = [
  ['title', 'Title', (p) => p.title || ''],
  ['meta', 'Meta description', (p) => p.metaDescription || ''],
  ['h1', 'H1', (p) => first(p.h1)],
];
export const FIX = { title: 'Title etiketini yeni sayfaya ekleyin.', meta: 'Meta description etiketini yeni sayfaya ekleyin.', h1: 'H1 başlığını yeni sayfaya ekleyin.', noindex: 'noindex etiketini kaldırın.' };

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

// What to do for a redirect. Empty = the redirect is fine.
function redirectTodo(r) {
  if (r.targetBroken) return `Hedef ${r.finalStatus || 'yanıt vermiyor'}${r.finalStatus ? ' veriyor' : ''}. Yönlendirmeyi çalışan bir sayfaya değiştirin.`;
  if (r.hops > 1) return `Zincir ${r.hops} adım. Tek adımlı 301 yapın.`;
  if (![301, 308].includes(r.status)) return `${r.status} geçici yönlendirmedir. 301 kullanın.`;
  return '';
}
const LOST_TODO = 'Bu adresi yeni sitede en yakın sayfaya 301 ile yönlendirin.';
const lostTodo = (r) => (r.indexable ? LOST_TODO : `Sayfa indexlenmiyordu. ${LOST_TODO}`);
const REMOVED_TODO = 'Bölüm bilerek kaldırıldı. Sayfayı en yakın karşılığa 301 ile yönlendirin veya 410 verin.';
const FOUND = new Set(['same', 'changed', 'redirected', 'unlinked', 'moved', 'no301', 'moving-found']);
const MOVE_TODO = (path, url) => `Eski alan adına geçecek sitede 301 kurun: ${path} → ${url}`;

const side = (r) => ({ host: r.meta.host, startUrl: r.meta.startUrl, startedAt: r.meta.startedAt, pages: r.pages.length, limitReached: !!r.meta.limitReached, cancelled: !!r.meta.cancelled });

// Hidden state for summaries and suggestions. Not sent to the browser.
const CTX = new WeakMap();

// Where the old path lives on the heir crawl (the site that takes the old domain).
// A redirect counts up to the first hop that leaves the heir host: we judge the 301 by its Location, not by the far site.
function heirFromCrawl(p, heirHost) {
  if (!p || p.blockedByRobots || p.status === 0 || p.status == null) return null;
  if (p.redirectChain?.length) {
    let hops = 0, location = p.finalUrl, finalStatus = p.finalStatus;
    for (const c of p.redirectChain) {
      hops++;
      if (c.to && bareHost(new URL(c.to).hostname) !== heirHost) { location = c.to; finalStatus = null; break; }
    }
    return { kind: 'redirect', status: p.status, hops, location, finalStatus };
  }
  return p.status >= 200 && p.status < 300 ? { kind: 'page', status: p.status } : { kind: 'error', status: p.status };
}

// The target page of a moved path, from the target crawl.
function targetFromCrawl(n, o) {
  if (!n) return null;
  if (n.blockedByRobots) return { state: 'unknown', url: n.url, reason: 'robots.txt engeli, taranmadı', todo: 'Hedef siteyi robots.txt engeli olmadan tarayın.' };
  if (n.status === 0) return { state: 'unknown', url: n.url, reason: `Bağlantı hatası (${n.error || 'yanıt yok'})`, todo: 'Hedef siteye erişimi kontrol edin. Sonra tekrar tarayın.' };
  if (n.redirectChain?.length) {
    const ok = n.finalStatus >= 200 && n.finalStatus < 300;
    return ok ? { state: 'ok', url: n.finalUrl, viaRedirect: true } : { state: 'missing', url: n.url, status: n.finalStatus };
  }
  if (n.status >= 400) return { state: 'missing', url: n.url, status: n.status };
  if (!isOk(n)) return { state: 'unknown', url: n.url, reason: `HTML değil (${n.status}, ${n.contentType || 'tür yok'})`, todo: 'Adresin bir HTML sayfası verdiğini kontrol edin.' };
  return { state: 'ok', url: n.url, title: n.title || '', changes: diffPage(o, n) };
}

// A moved page needs two things: the target page exists, and the old path on the heir 301s to it.
function resolveMove(row, t, h, accept) {
  const out = { ...row };
  delete out.probe; delete out.probeTarget; delete out.probeHeir; delete out.pendingTarget; delete out.pendingHeir;
  if (t.url) out.newUrl = t.url;
  if (h?.kind === 'redirect') Object.assign(out, { status: h.status, hops: h.hops, target: h.location, finalStatus: h.finalStatus });
  else if (h) out.heirStatus = h.status ?? null;
  if (t.state === 'unknown') return ['unknown', { ...out, reason: `Hedef kontrol edilemedi: ${t.reason}`, todo: t.todo }];
  if (t.state === 'missing') {
    return ['notarget', { ...out, newStatus: t.status ?? null, reason: t.status ? `Hedef sayfa ${t.status} veriyor` : 'Hedef sayfa yeni taramada yok',
      todo: `Hedef sitede ${row.checkUrl} sayfasını oluşturun. Sayfa bu sitede olmayacaksa bölüm için başka hedef seçin.` }];
  }
  const changes = t.changes || [];
  const lostOnes = changes.filter((c) => c.kind === 'lost');
  Object.assign(out, { newTitle: t.title || '', changes, lostCount: lostOnes.length });
  const extra = [t.unlinked ? 'Hedef sayfaya yeni sitede link verin.' : '', ...lostOnes.map((c) => FIX[c.field])].filter(Boolean);
  const install = MOVE_TODO(row.path, row.expectUrl);
  if (!h || h.kind === 'unknown') {
    return ['unknown', { ...out, reason: `Hedef hazır. Eski adresin yönlendirmesi kontrol edilemedi${h?.reason ? ` (${h.reason})` : ''}.`, todo: h?.todo || 'Geçecek siteye erişimi kontrol edin. Sonra tekrar eşleştirin.' }];
  }
  if (h.kind === 'redirect') {
    const u = new URL(h.location);
    const pathOk = pathKey(h.location) === row.newPath || (t.url && pathKey(h.location) === pathKey(t.url));
    const hostOk = accept.has(bareHost(u.hostname));
    if (pathOk && hostOk) {
      const fix = h.hops > 1 ? `Zincir ${h.hops} adım. Tek adımlı 301 yapın.` : ![301, 308].includes(h.status) ? `${h.status} geçici yönlendirmedir. 301 kullanın.` : '';
      return ['moved', { ...out, reason: 'Hedef hazır, 301 kurulu', todo: [fix, ...extra].filter(Boolean).join(' ') }];
    }
    if (pathOk) {
      return ['no301', { ...out, reason: `301 ${u.hostname} alan adına gidiyor. Bu alan adı projede yok.`,
        todo: [`Hedef sitenin canlı alan adını projeye yazın. Yönlendirme yanlışsa ${row.expectUrl} adresine değiştirin.`, ...extra].join(' ') }];
    }
    return ['no301', { ...out, reason: `Eski adres başka sayfaya yönleniyor: ${h.location}`, todo: [`Yönlendirmeyi ${row.expectUrl} adresine değiştirin.`, ...extra].join(' ') }];
  }
  const why = h.kind === 'page' ? `Eski adres açılıyor, yönlenmiyor (${h.status})` : `Eski adres ${h.status} veriyor. 301 yok.`;
  return ['no301', { ...out, reason: why, todo: [install, ...extra].join(' ') }];
}

// newList: one crawl or a list. The first one is the heir: it takes the old domain after launch, so paths without
// a rule go there and every 301 is checked there. options.live: { '<crawl host>': '<live host>' } for other sites.
export function compareCrawls(oldRes, newList, { rules = [], suggest = {}, live = {} } = {}) {
  const list = Array.isArray(newList) ? newList : [newList];
  const parsed = rules.length && !rules[0].f ? parseRules(rules) : rules;
  const targets = list.map((res) => {
    const byKey = new Map();
    for (const p of res.pages) {
      const k = pathKey(p.url);
      // A page that answered wins over a redirect or an error with the same path.
      if (!byKey.has(k) || (isOk(p) && !isOk(byKey.get(k)))) byKey.set(k, p);
    }
    return { res, host: res.meta.host, origin: new URL(res.meta.startUrl).origin, byKey, used: new Set() };
  });
  const findTarget = (host) => (host ? targets.find((t) => bareHost(t.host) === host) : targets[0]);
  const heir = targets[0];
  const oldOrigin = new URL(oldRes.meta.startUrl);
  const liveOf = (t) => (t === heir ? bareHost(oldRes.meta.host) : bareHost(live[bareHost(t.host)] || ''));
  // Hosts a 301 may point to for a target: its crawl host and its live host. The heir's live host is the old domain.
  const acceptOf = (t) => new Set([bareHost(t.host), liveOf(t)].filter(Boolean));
  const ruleLabel = (r) => (r.drop || r.host ? r.text : `${r.from} → ${heir.host}${r.to}`);

  const kindByKey = new Map(), ruleByKey = new Map(), oldKeys = [];
  const rows = { lost: [], redirected: [], changed: [], same: 0, unlinked: [], unknown: [], removed: [], added: [], moved: [], no301: [], notarget: [], moving: [] };
  const seen = new Set();

  for (const o of oldRes.pages.filter(isOk)) {
    const key = pathKey(o.url);
    if (seen.has(key)) continue;
    seen.add(key); oldKeys.push(key);
    const rule = parsed.find((r) => ruleMatches(r, key)) || null;
    ruleByKey.set(key, rule);
    const target = rule?.drop ? heir : rule ? findTarget(rule.host) : heir;
    const base = { path: key, oldUrl: o.url, oldTitle: o.title || '', indexable: isIndexable(o), inlinks: o.inlinks || 0, rule: rule ? ruleLabel(rule) : '' };
    const put = (kind, row) => { kindByKey.set(key, kind); if (kind === 'same') rows.same++; else rows[kind.startsWith('moving') ? 'moving' : kind].push(row); };
    if (!target) {
      put('unknown', { ...base, site: rule.host, newPath: applyRule(rule, key), reason: `Kural hedefi ${rule.host} taranmadı`, todo: `${rule.host} sitesini tarayın. Sonra tekrar eşleştirin.` });
      continue;
    }
    const newPath = rule && !rule.drop ? applyRule(rule, key) : key;
    const checkUrl = new URL(newPath, target.origin).href;
    Object.assign(base, { site: target.host, newPath, checkUrl, dropped: !!rule?.drop });
    target.used.add(newPath);
    const n = target.byKey.get(newPath);

    // Moved page: another site or another path. The old URL lives on only as a 301 on the heir.
    if (target !== heir || newPath !== key) {
      const liveHost = liveOf(target);
      const expectUrl = liveHost ? `${oldOrigin.protocol}//${liveHost}${newPath}` : checkUrl;
      const row = { ...base, moved: true, heirUrl: new URL(key, heir.origin).href, expectUrl };
      const t = targetFromCrawl(n, o);
      const h = heirFromCrawl(heir.byKey.get(key), bareHost(heir.host));
      // Both answers are in the crawls (or the target is already missing): no request needed.
      if (t && (t.state !== 'ok' || h)) { const [kind, r] = resolveMove(row, t, h, acceptOf(target)); put(kind, r); continue; }
      put(t ? 'moving-found' : 'moving', { ...row, probe: true, probeTarget: !t, probeHeir: !h, pendingTarget: t, pendingHeir: h });
      continue;
    }

    if (!n) { put('lost', { ...base, reason: 'Yeni taramada yok', newStatus: null, probe: true, todo: lostTodo(base) }); continue; }
    const at = { ...base, newUrl: n.url };
    if (n.blockedByRobots) { put('unknown', { ...at, reason: 'robots.txt engeli, taranmadı', todo: 'Yeni siteyi robots.txt engeli olmadan tarayın.' }); continue; }
    if (n.status === 0) { put('unknown', { ...at, reason: `Bağlantı hatası (${n.error || 'yanıt yok'})`, todo: 'Yeni siteye erişimi kontrol edin. Sonra tekrar tarayın.' }); continue; }
    if (n.redirectChain?.length) {
      const r = { ...at, target: n.finalUrl, status: n.status, finalStatus: n.finalStatus, hops: n.redirectChain.length, targetBroken: !(n.finalStatus >= 200 && n.finalStatus < 300) };
      put('redirected', { ...r, reason: 'Yeni taramada yönleniyor', todo: redirectTodo(r) });
      continue;
    }
    if (n.status >= 400) {
      put(rule?.drop ? 'removed' : 'lost', { ...at, newStatus: n.status, reason: `Yeni sitede ${n.status} veriyor`, todo: rule?.drop ? REMOVED_TODO : lostTodo(base) });
      continue;
    }
    if (!isOk(n)) { put('unknown', { ...at, reason: `HTML değil (${n.status}, ${n.contentType || 'tür yok'})`, todo: 'Adresin bir HTML sayfası verdiğini kontrol edin.' }); continue; }
    const changes = diffPage(o, n);
    if (!changes.length) { put('same'); continue; }
    const lostOnes = changes.filter((c) => c.kind === 'lost');
    put('changed', { ...at, newTitle: n.title || '', changes, lostCount: lostOnes.length, todo: lostOnes.map((c) => FIX[c.field]).join(' ') });
  }

  for (const t of targets) {
    for (const n of t.res.pages.filter(isOk)) {
      const key = pathKey(n.url);
      if (!t.used.has(key) && t.byKey.get(key) === n) rows.added.push({ path: key, site: t.host, newUrl: n.url, newTitle: n.title || '', indexable: isIndexable(n) });
    }
  }
  rows.added.sort((a, b) => a.site.localeCompare(b.site) || a.path.localeCompare(b.path));

  const warnings = [];
  targets.forEach((t, i) => {
    const name = i === 0 ? `Eski alan adına geçecek site (${t.host})` : `Hedef site (${t.host})`;
    if (t.res.meta.limitReached) warnings.push(`${name} URL limitine ulaştı. Bazı "kaybolan" sayfalar sadece taranmamış olabilir.`);
    if (t.res.meta.cancelled) warnings.push(`${name} taraması yarıda durduruldu. Sonuçlar eksik olabilir.`);
  });
  if (oldRes.meta.limitReached) warnings.push('Eski site taraması URL limitine ulaştı. Eski sitenin bütün sayfaları listede değil.');
  if (oldRes.meta.cancelled) warnings.push('Eski site taraması yarıda durduruldu. Sonuçlar eksik olabilir.');
  for (const r of parsed) {
    if (!r.drop && r.host && !findTarget(r.host)) warnings.push(`Kural ${r.text}: ${r.host} taranmadı. Bu kurala giren sayfalar "Kontrol edilemedi" grubunda.`);
  }

  const cmp = {
    old: side(oldRes), new: side(list[0]), targets: targets.map((t) => side(t.res)),
    rules: parsed.map((r) => ({ from: r.from, host: r.host, to: r.to, drop: r.drop, text: ruleLabel(r) })),
    baseWarnings: warnings, rows, probed: 0,
  };
  CTX.set(cmp, { targets, kindByKey, ruleByKey, oldKeys, suggest, acceptOf, findTarget });
  summarize(cmp);
  return cmp;
}

const byWeight = (a, b) => (b.indexable - a.indexable) || (b.inlinks - a.inlinks) || a.path.localeCompare(b.path);

function summarize(cmp) {
  const { rows } = cmp;
  const ctx = CTX.get(cmp);
  for (const k of ['lost', 'redirected', 'unknown', 'unlinked', 'removed', 'no301', 'notarget', 'moving']) rows[k].sort(byWeight);
  rows.moved.sort((a, b) => (!!b.todo - !!a.todo) || byWeight(a, b));
  rows.changed.sort((a, b) => (b.lostCount - a.lostCount) || byWeight(a, b));
  cmp.warnings = [...cmp.baseWarnings];
  if (rows.unknown.length) cmp.warnings.push(`${rows.unknown.length} sayfa yeni sitede kontrol edilemedi. Neden: robots.txt engeli, şifreli staging, bağlantı hatası veya taranmayan hedef. Her satırda çözüm yazılı. Liste "Kontrol edilemedi" bölümünde.`);
  const oldPages = ctx.oldKeys.length;
  cmp.summary = {
    oldPages, lost: rows.lost.length, redirected: rows.redirected.length, unlinked: rows.unlinked.length,
    redirectBroken: rows.redirected.filter((r) => r.targetBroken).length,
    redirectFix: rows.redirected.filter((r) => r.todo).length,
    changed: rows.changed.length, contentLost: rows.changed.filter((r) => r.lostCount).length + rows.moved.filter((r) => r.lostCount).length,
    same: rows.same, unknown: rows.unknown.length, removed: rows.removed.length, added: rows.added.length,
    moved: rows.moved.length, moveFix: rows.moved.filter((r) => r.todo).length, no301: rows.no301.length, notarget: rows.notarget.length,
    pending: rows.moving.length,
    kept: oldPages ? Math.round(((rows.same + rows.changed.length + rows.unlinked.length + rows.moved.length) / oldPages) * 100) : 0,
  };
  // Per rule: how many old pages it took and how many it found on the new site.
  const stats = new Map(cmp.rules.map((r) => [r.from, { pages: 0, found: 0 }]));
  const none = { pages: 0, found: 0 };
  for (const key of ctx.oldKeys) {
    const s = stats.get(ctx.ruleByKey.get(key)?.from) || none;
    s.pages++;
    if (FOUND.has(ctx.kindByKey.get(key))) s.found++;
  }
  cmp.rules = cmp.rules.map((r) => ({ ...r, ...stats.get(r.from) }));
  cmp.noRule = none;
  cmp.suggestions = suggestRules(ctx, cmp.rules, ctx.suggest);
}

// ---------- Pattern suggestions ----------
// Groups old pages by first path segment (/tr, /fr, /blog). For each group, tries simple path moves on each
// target crawl: same path, drop the segment, swap it for a segment of the target. A move is suggested when it
// finds more pages than the current state. A group that no move can find gets a "bölüm kaldırıldı" suggestion.
export function suggestRules(ctx, rules, { minPages = 3, minRatio = 0.5, max = 8 } = {}) {
  const { targets, kindByKey, oldKeys } = ctx;
  const ruled = new Set(rules.map((r) => r.from));
  const keys = oldKeys;
  const count = new Map();
  for (const k of keys) { const s = firstSeg(k); if (s) count.set(s, (count.get(s) || 0) + 1); }
  const groups = [...count].filter(([, n]) => n >= minPages).map(([s]) => s);
  const inGroup = new Set(groups);
  const segsOf = (t) => {
    const c = new Map();
    for (const k of t.byKey.keys()) { const s = firstSeg(k); if (s) c.set(s, (c.get(s) || 0) + 1); }
    return [...c].filter(([, n]) => n >= minPages).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([s]) => s);
  };
  const tSegs = targets.map(segsOf);
  const has = (t, key) => { const p = t.byKey.get(key); return !!p && (isOk(p) || p.redirectChain?.length > 0); };
  const hostOf = (t, i) => (i === 0 ? '' : bareHost(t.host));
  const out = [];

  const consider = (from, members, label) => {
    if (ruled.has(from)) return;
    const current = members.filter((k) => FOUND.has(kindByKey.get(k))).length;
    const seg = from === '/*' ? '' : from.slice(1, -2);
    let best = null;
    targets.forEach((t, i) => {
      const moves = seg ? ['/' + seg + '/*', '/*', ...tSegs[i].filter((q) => q !== seg).map((q) => `/${q}/*`)] : ['/*', ...tSegs[i].map((q) => `/${q}/*`)];
      for (const to of moves) {
        if (i === 0 && to === from) continue; // this is the state without a rule
        const rule = parseRule({ from, host: hostOf(t, i), to });
        const hits = members.filter((k) => has(t, applyRule(rule, k))).length;
        if (!best || hits > best.hits) best = { rule, hits, t, to };
      }
    });
    const total = members.length;
    if (best && best.hits >= minPages && best.hits / total >= minRatio && best.hits >= current + minPages) {
      const { rule, hits, t, to } = best;
      const how = to === from ? 'aynı yolda' : to === '/*' ? `${label} öneki olmadan` : `${to.slice(0, -1)} öneki ile`;
      out.push({ from: rule.from, host: rule.host, to: rule.to, text: rule.text, hits, total,
        why: `${seg ? `${label} altındaki` : 'Öneksiz'} ${total} sayfanın ${hits} tanesi ${t.host} taramasında ${how} var.` });
    } else if (seg && total >= minPages && current / total < minRatio && (!best || best.hits / total < minRatio)) {
      out.push({ from, drop: true, text: `${from} → bölüm kaldırıldı`, hits: 0, total,
        why: `${label} altındaki ${total} sayfa yeni taramalarda yok. Bölüm bilerek kaldırıldıysa bu kuralı ekleyin. Sayfalar "Kayboldu" yerine "Bölüm kaldırıldı" grubuna girer. 301 yine gerekir.` });
    }
  };
  for (const s of groups) consider(`/${s}/*`, keys.filter((k) => firstSeg(k) === s), `/${s}/`);
  consider('/*', keys.filter((k) => !inGroup.has(firstSeg(k))), '');
  return out.sort((a, b) => (b.hits - a.hits) || (b.total - a.total)).slice(0, max);
}

// ---------- Probing ----------
// The new crawl follows only the links of the new site. Old URLs live on as 301s with no links to them,
// so every old path that the new crawl did not see is requested on its expected URL one by one.
// Moved pages need two requests: the target page, and the old path on the heir (does it 301 to the target?).
// On the heir only same-host hops are followed: the 301 is judged by its Location (the far site may not be live yet).
// request(url) → { status, location, contentType } for one hop (no redirect following), or throws.
export async function probeLost(cmp, request, { concurrency = 5, maxHops = 5 } = {}) {
  const ctx = CTX.get(cmp);
  const tasks = new Map(); // key → { url, sameHost }
  const add = (url, sameHost) => { const k = `${sameHost ? 'h' : 't'}|${url}`; if (!tasks.has(k)) tasks.set(k, { url, sameHost }); return k; };
  const lostTodo_ = cmp.rows.lost.filter((r) => r.probe).map((r) => [r, add(r.checkUrl, false)]);
  const moveTodo = cmp.rows.moving.map((r) => [r, r.probeTarget ? add(r.checkUrl, false) : null, r.probeHeir ? add(r.heirUrl, true) : null]);

  const list = [...tasks.entries()];
  let i = 0;
  const results = new Map();
  const worker = async () => {
    while (i < list.length) {
      const [k, { url: start, sameHost }] = list[i++];
      const chain = [];
      let url = start, res = null, error = null, left = false;
      const host = new URL(start).hostname;
      try {
        for (let hop = 0; hop <= maxHops; hop++) {
          res = await request(url);
          if (res.status >= 300 && res.status < 400 && res.location) {
            chain.push(res.status);
            url = new URL(res.location, url).href;
            if (sameHost && new URL(url).hostname !== host) { left = true; break; }
            continue;
          }
          break;
        }
      } catch (e) { error = e.cause?.code || e.message || 'hata'; }
      results.set(k, { chain, url, res, error, left });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));

  const lost = [];
  const move = (kind, row) => { ctx.kindByKey.set(row.path, kind); if (kind === 'lost') lost.push(row); else cmp.rows[kind].push(row); };
  const errorRow = (r, newUrl, error) => {
    const blocked = error === 'blocked-private';
    return { ...r, newUrl, reason: blocked ? 'Adres iç ağda. Yayın modunda istenmez.' : `Yeni sitede istenemedi (${error})`, todo: blocked ? 'Eşleştirmeyi yerel kurulumda çalıştırın.' : 'Yeni siteye erişimi kontrol edin. Sonra tekrar eşleştirin.' };
  };
  const probed = new Set(lostTodo_.map(([r]) => r));
  for (const r of cmp.rows.lost) {
    if (!probed.has(r)) { lost.push(r); continue; }
    const { chain, url, res, error } = results.get(lostTodo_.find(([x]) => x === r)[1]);
    delete r.probe;
    const newUrl = r.checkUrl;
    if (error) { move('unknown', errorRow(r, newUrl, error)); continue; }
    const st = res.status;
    if (chain.length) {
      const row = { ...r, newUrl, target: url, status: chain[0], finalStatus: st, hops: chain.length, targetBroken: !(st >= 200 && st < 300) };
      move('redirected', { ...row, reason: 'Yönleniyor (araç adresi istedi)', todo: redirectTodo(row) });
    } else if (st === 401 || st === 403) {
      move('unknown', { ...r, newUrl, reason: `Erişim engeli (${st}). Staging şifreli olabilir.`, todo: 'Staging şifresini geçici olarak kaldırın veya eşleştirmeyi canlıda yapın.' });
    } else if (st >= 200 && st < 300) {
      move('unlinked', { ...r, newUrl, reason: `Açılıyor (${st}) ama yeni sitede bu sayfaya link yok`, todo: 'Sayfaya menüden veya içerikten link verin. Sayfa gereksizse 301 ile yönlendirin.' });
    } else if (r.dropped) {
      move('removed', { ...r, newUrl, newStatus: st, reason: `Adres ${st} veriyor`, todo: REMOVED_TODO });
    } else {
      move('lost', { ...r, newUrl, newStatus: st, reason: `Yeni sitede ${st} veriyor`, todo: lostTodo(r) });
    }
  }
  cmp.rows.lost = lost;

  // Moved pages: build the target and the heir answers from the requests, then decide.
  const tFromProbe = (x) => {
    if (x.error) return x.error === 'blocked-private'
      ? { state: 'unknown', reason: 'adres iç ağda', todo: 'Eşleştirmeyi yerel kurulumda çalıştırın.' }
      : { state: 'unknown', reason: `istenemedi (${x.error})`, todo: 'Hedef siteye erişimi kontrol edin. Sonra tekrar eşleştirin.' };
    const st = x.res.status;
    if (st === 401 || st === 403) return { state: 'unknown', reason: `erişim engeli (${st})`, todo: 'Hedef sitenin staging şifresini geçici olarak kaldırın.' };
    if (st >= 200 && st < 300) return { state: 'ok', url: x.url, unlinked: !x.chain.length };
    return { state: 'missing', status: st };
  };
  const hFromProbe = (x) => {
    if (x.error) return { kind: 'unknown', reason: x.error === 'blocked-private' ? 'adres iç ağda' : `istenemedi: ${x.error}`, todo: 'Geçecek siteye erişimi kontrol edin. Sonra tekrar eşleştirin.' };
    if (x.chain.length) return { kind: 'redirect', status: x.chain[0], hops: x.chain.length, location: x.url, finalStatus: x.left ? null : x.res.status };
    const st = x.res.status;
    if (st === 401 || st === 403) return { kind: 'unknown', reason: `erişim engeli ${st}`, todo: 'Geçecek sitenin staging şifresini geçici olarak kaldırın veya eşleştirmeyi canlıda yapın.' };
    return st >= 200 && st < 300 ? { kind: 'page', status: st } : { kind: 'error', status: st };
  };
  for (const [r, tk, hk] of moveTodo) {
    const t = tk ? tFromProbe(results.get(tk)) : r.pendingTarget;
    const h = hk ? hFromProbe(results.get(hk)) : r.pendingHeir;
    const [kind, row] = resolveMove(r, t, h, ctx.acceptOf(ctx.findTarget(r.site === cmp.targets[0].host ? '' : bareHost(r.site))));
    move(kind, row);
  }
  cmp.rows.moving = [];
  cmp.probed = results.size;
  summarize(cmp);
  return cmp;
}

// ---------- Sections (v0.7.0, matching screen) ----------
// Old pages grouped by first path segment. Every section shows where it goes now and the other choices.
// Every choice shows how many pages of the section it finds in the crawls (no requests).
export function sectionTable(cmp, { minPages = 3, maxSegs = 3 } = {}) {
  const { targets, kindByKey, oldKeys } = CTX.get(cmp);
  const count = new Map();
  for (const k of oldKeys) { const s = firstSeg(k); if (s) count.set(s, (count.get(s) || 0) + 1); }
  const groups = [...count].filter(([, n]) => n >= minPages).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const inGroup = new Set(groups);
  const list = groups.map((seg) => ({ from: `/${seg}/*`, seg, keys: oldKeys.filter((k) => firstSeg(k) === seg) }));
  const rest = oldKeys.filter((k) => !inGroup.has(firstSeg(k)));
  if (rest.length) list.unshift({ from: '/*', seg: '', keys: rest });
  const has = (t, key) => { const p = t.byKey.get(key); return !!p && (isOk(p) || p.redirectChain?.length > 0); };
  const segsOf = (t) => {
    const c = new Map();
    for (const k of t.byKey.keys()) { const s = firstSeg(k); if (s) c.set(s, (c.get(s) || 0) + 1); }
    return [...c].filter(([, n]) => n >= minPages).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  };
  const tSegs = targets.map(segsOf);
  return list.map(({ from, seg, keys }) => {
    const rule = cmp.rules.find((r) => r.from === from);
    const options = [];
    targets.forEach((t, i) => {
      const moves = seg ? [from, '/*', ...tSegs[i].filter((q) => q !== seg).slice(0, maxSegs).map((q) => `/${q}/*`)]
        : ['/*', ...tSegs[i].slice(0, maxSegs).map((q) => `/${q}/*`)];
      for (const to of moves) {
        const r = parseRule({ from, host: i === 0 ? '' : bareHost(t.host), to });
        options.push({ host: r.host, to: r.to, hits: keys.filter((k) => has(t, applyRule(r, k))).length });
      }
    });
    return {
      from, pages: keys.length, found: keys.filter((k) => FOUND.has(kindByKey.get(k))).length,
      no301: keys.filter((k) => kindByKey.get(k) === 'no301').length, notarget: keys.filter((k) => kindByKey.get(k) === 'notarget').length,
      rule: !!rule, current: rule ? (rule.drop ? { drop: true } : { host: rule.host || '', to: rule.to }) : { host: '', to: from },
      options, suggestion: cmp.suggestions.find((s) => s.from === from) || null,
      needsDecision: !rule && !!cmp.suggestions.find((s) => s.from === from && s.drop),
    };
  });
}

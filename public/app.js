// Front end for SEO Audit. No build step.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
const PAGE = 100;

const BUCKETS = [
  ['ok', '200', 'var(--cell-ok)'],
  ['redirect', 'Redirect', 'var(--amber)'],
  ['client', '4xx', 'var(--red)'],
  ['server', '5xx', '#FF6B78'],
  ['failed', 'Bağlantı hatası', 'transparent'],
  ['blocked', 'robots engeli', 'transparent'],
];

function bucketOf(p) {
  if (p.blockedByRobots) return 'blocked';
  const s = p.status;
  if (!s) return 'failed';
  if (s >= 500) return 'server';
  if (s >= 400) return 'client';
  if (s >= 300) return 'redirect';
  if (s === 200) return 'ok';
  return 'other';
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `İstek başarısız (${res.status})`);
  return data;
}

function show(view) {
  for (const v of ['startView', 'liveView', 'resultView', 'projectView']) $('#' + v).hidden = v !== view;
}

// ---------- History ----------
let currentId = null;
async function loadHistory() {
  const [{ running, history }, plist] = await Promise.all([api('/api/crawls'), loadProjects()]);
  const inProject = new Set(plist.flatMap((p) => p.crawlIds));
  const ul = $('#history');
  const items = [
    ...running.map((j) => ({ id: j.id, host: new URL(j.url).hostname, label: j.label, sub: 'Taranıyor…', run: true })),
    ...history.map((h) => ({
      id: h.id, host: h.host, label: h.label, sub: fmtDate(h.startedAt), score: h.score,
      bad: h.summary.client + h.summary.server + h.summary.failed, total: h.summary.total,
    })),
  ];
  const own = items.filter((i) => !inProject.has(i.id));
  if (!own.length) { ul.innerHTML = `<li class="muted">${items.length ? 'Bütün taramalar bir projede.' : 'Henüz tarama yok.'}</li>`; return; }
  ul.innerHTML = own.map((i) => `<li><button type="button" data-id="${esc(i.id)}" data-run="${i.run ? 1 : ''}" aria-current="${i.id === currentId}">
    <span class="h-host">${esc(i.host)}</span>
    <span class="h-sub">${i.run ? '<span class="tag run">canlı</span>' : ''}${i.label ? `<span class="tag ${esc(i.label)}">${esc(i.label)}</span>` : ''}
      ${i.score != null ? `<span class="h-score ${i.score < 50 ? 'lo' : i.score < 80 ? 'mid' : ''}">${i.score}</span> ` : ''}${esc(i.sub)}${i.total != null ? ` · ${i.total} URL${i.bad ? ` · <span class="h-bad">${i.bad} hata</span>` : ''}` : ''}</span>
  </button></li>`).join('');
}
$('#history').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) location.hash = (b.dataset.run ? '#/live/' : '#/crawl/') + b.dataset.id;
});
$('#newBtn').addEventListener('click', () => { location.hash = '#/'; });

// ---------- Start ----------
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  let url = String(f.get('url') || '').trim();
  $('#formErr').textContent = '';
  if (!url) { $('#formErr').textContent = 'Site adresini yazın.'; $('#url').focus(); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const btn = $('#startBtn');
  btn.disabled = true;
  try {
    const job = await api('/api/crawls', {
      method: 'POST',
      body: JSON.stringify({
        url, label: '',
        options: {
          maxUrls: f.get('maxUrls'), concurrency: f.get('concurrency'), delayMs: f.get('delayMs'), timeoutMs: f.get('timeoutMs'),
          auth: f.get('auth') || null, ignoreRobots: f.get('ignoreRobots') === 'on', useSitemap: f.get('noSitemap') !== 'on',
          checks: { site: f.get('checkSite') === 'on', external: f.get('checkExternal') === 'on', images: f.get('checkImages') === 'on' },
        },
      }),
    });
    location.hash = '#/live/' + job.id;
  } catch (err) {
    $('#formErr').textContent = err.message;
  } finally { btn.disabled = false; }
});

// ---------- Live ----------
let es = null;
function tallyHtml(counts, done) {
  return `<div><b>${done}</b><span>taranan URL</span></div>` + BUCKETS.map(([k, name, col]) => counts[k]
    ? `<div><b>${counts[k]}</b><span><i class="key c ${k}" style="background:${col}"></i>${name}</span></div>` : '').join('');
}
function addCells(el, list) {
  const frag = document.createDocumentFragment();
  for (const b of list) { const i = document.createElement('i'); i.className = 'c ' + b; frag.appendChild(i); }
  el.appendChild(frag);
}
function openLive(id) {
  currentId = id;
  es?.close();
  show('liveView');
  $('#liveStrip').innerHTML = '';
  $('#liveTally').innerHTML = '';
  $('#liveNote').textContent = '';
  $('#liveHost').textContent = id.split('_')[0];
  $('#cancelBtn').disabled = false;
  es = new EventSource(`/api/crawls/${encodeURIComponent(id)}/events`);
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    $('#liveHost').textContent = new URL(d.url).hostname;
    $('#liveCurrent').textContent = d.progress.current || '';
    $('#liveTally').innerHTML = tallyHtml(d.counts, d.progress.done);
    $('#liveStrip').innerHTML = '';
    addCells($('#liveStrip'), d.cells);
    if (d.status !== 'running') { es.close(); setTimeout(() => { location.hash = '#/crawl/' + id; }, 300); }
  });
  es.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    $('#liveCurrent').textContent = d.progress.current;
    $('#liveTally').innerHTML = tallyHtml(d.counts, d.progress.done);
    if (d.progress.phase === 'checks') {
      $('#liveNote').textContent = d.progress.step === 'site'
        ? 'Tarama bitti. Ek kontroller: site sürümleri, SSL, HSTS, llms.txt.'
        : `Tarama bitti. Ek kontroller: ${d.progress.checksDone} / ${d.progress.checksTotal} dış link ve görsel.`;
    } else $('#liveNote').textContent = d.progress.queued ? `Kuyrukta ${d.progress.queued} URL bekliyor.` : '';
    addCells($('#liveStrip'), d.cells);
  });
  es.addEventListener('done', async () => {
    es.close();
    const plist = await loadProjects();
    const owner = plist.find((p) => p.crawlIds.includes(id));
    loadHistory();
    location.hash = owner ? `#/project/${owner.id}/tarama` : '#/crawl/' + id;
  });
  es.addEventListener('failed', (e) => {
    es.close();
    $('#liveNote').textContent = 'Tarama durdu: ' + JSON.parse(e.data).error;
    $('#cancelBtn').disabled = true;
    loadHistory();
  });
  es.onerror = () => {
    // Job is gone from memory: it already finished.
    if (es.readyState === EventSource.CLOSED) { location.hash = '#/crawl/' + id; }
  };
  loadHistory();
}
$('#cancelBtn').addEventListener('click', async () => {
  $('#cancelBtn').disabled = true;
  $('#liveNote').textContent = 'Durduruluyor. Taranan sayfalar kaydedilecek.';
  try { await api(`/api/crawls/${encodeURIComponent(currentId)}/cancel`, { method: 'POST' }); } catch (e) { $('#liveNote').textContent = e.message; }
});

// ---------- Result ----------
const state = { data: null, filter: 'all', q: '', page: 0, open: new Set(), tab: 'issues', sev: 'all', team: 'all', rule: null, openRules: new Set(), issuesByUrl: new Map() };
const SEV = { critical: 'Kritik', warning: 'Uyarı', notice: 'Bilgi' };
const SEV_RANK = { critical: 0, warning: 1, notice: 2 };
const FILTERS = [
  ['all', 'Tümü', () => true],
  ['ok', '200', (p) => bucketOf(p) === 'ok'],
  ['redirect', 'Redirect', (p) => bucketOf(p) === 'redirect'],
  ['client', '4xx', (p) => bucketOf(p) === 'client'],
  ['server', '5xx', (p) => bucketOf(p) === 'server'],
  ['failed', 'Bağlantı hatası', (p) => bucketOf(p) === 'failed'],
  ['blocked', 'robots engeli', (p) => bucketOf(p) === 'blocked'],
  ['orphan', 'Yetim sayfa', (p) => p.orphan],
  ['noindex', 'noindex', (p) => /noindex/.test((p.metaRobots || '') + (p.xRobotsTag || ''))],
];

async function openResult(id) {
  currentId = id;
  es?.close();
  show('resultView');
  $('#resHost').textContent = id.split('_')[0];
  $('#resMeta').textContent = 'Yükleniyor…';
  $('#table tbody').innerHTML = '';
  $('#resStrip').innerHTML = '';
  loadHistory();
  let data;
  try { data = await api(`/api/crawls/${encodeURIComponent(id)}`); }
  catch (e) {
    // Maybe still running.
    try { const { running } = await api('/api/crawls'); if (running.some((j) => j.id === id)) { location.hash = '#/live/' + id; return; } } catch {}
    $('#resMeta').textContent = e.message; return;
  }
  Object.assign(state, { data, filter: 'all', q: '', page: 0, open: new Set(), sev: 'all', team: 'all', rule: null, openRules: new Set() });
  state.issuesByUrl = new Map();
  for (const r of data.audit?.rules || []) for (const it of r.items) {
    (state.issuesByUrl.get(it.url) || state.issuesByUrl.set(it.url, []).get(it.url)).push({ r, detail: it.detail });
  }
  for (const list of state.issuesByUrl.values()) list.sort((a, b) => SEV_RANK[a.r.severity] - SEV_RANK[b.r.severity]);
  $('#q').value = '';
  const m = data.meta;
  const secs = Math.round((new Date(m.finishedAt) - new Date(m.startedAt)) / 1000);
  $('#resHost').textContent = m.host;
  $('#resMeta').textContent = `${fmtDate(m.startedAt)} · ${data.pages.length} URL · ${secs} sn · sitemap: ${m.sitemap.urlCount} URL · robots.txt: ${m.robots.status || 'yok'}`;
  const warns = [];
  if (m.cancelled) warns.push('Tarama elle durduruldu. Sonuçlar eksik.');
  if (m.limitReached) warns.push(`URL limitine ulaşıldı. ${m.notCrawled} URL taranmadı. Limiti artırıp tekrar tarayın.`);
  if (m.robots.status !== 200) warns.push('robots.txt bulunamadı.');
  if (!m.sitemap.urlCount) warns.push('Sitemap bulunamadı veya boş.');
  $('#resWarn').hidden = !warns.length;
  $('#resWarn').textContent = warns.join(' ');
  $('#excelBtn').href = `/api/crawls/${encodeURIComponent(id)}/excel`;
  const owner = projectList.find((p) => p.crawlIds.includes(id));
  $('#resProject').hidden = !owner;
  if (owner) { $('#resProject').href = `#/project/${owner.id}/tarama`; $('#resProject').textContent = `← ${owner.name}`; }

  const strip = $('#resStrip');
  strip.innerHTML = data.pages.map((p, i) => `<i class="c ${bucketOf(p)}" data-i="${i}" title="${esc(p.status ?? '—')} ${esc(p.url)}"></i>`).join('');
  renderFilters();
  renderTable();
  renderIssues();
  setTab(data.audit ? state.tab : 'pages');
}

// ---------- Tabs ----------
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
  $('#issuesPane').hidden = tab !== 'issues';
  $('#pagesPane').hidden = tab !== 'pages';
}
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });

// ---------- Issues ----------
function renderIssues() {
  const a = state.data.audit;
  if (!a) { $('#issues').innerHTML = '<div class="empty">Bu tarama için denetim yok.</div>'; return; }
  renderSiteChecks();
  const cls = a.score < 50 ? 'lo' : a.score < 80 ? 'mid' : '';
  $('#score').innerHTML = `<b class="${cls}">${a.score}</b><span>Sağlık skoru. ${a.totalUrls} URL'nin ${a.healthyUrls} tanesinde kritik sorun yok.${a.siteCritical ? ' Site genelinde kritik sorun var.' : ''}</span>`;
  const active = a.rules.filter((r) => r.count);
  $('#sevFilter').innerHTML = [['all', 'Tümü', active.length], ...Object.keys(SEV).map((k) => [k, SEV[k], active.filter((r) => r.severity === k).length])]
    .map(([k, n, c]) => `<button type="button" class="chip" data-sev="${k}" aria-pressed="${state.sev === k}">${k !== 'all' ? `<i class="dot ${k}"></i>` : ''}${n} <b>${c}</b></button>`).join('');
  const teams = [...new Set(active.map((r) => r.team))].sort();
  $('#teamFilter').innerHTML = ['all', ...teams].map((t) => `<button type="button" class="chip small" data-team="${esc(t)}" aria-pressed="${state.team === t}">${t === 'all' ? 'Bütün ekipler' : esc(t)}</button>`).join('');
  const cat = Object.fromEntries(a.categories);
  const list = active.filter((r) => (state.sev === 'all' || r.severity === state.sev) && (state.team === 'all' || r.team === state.team));
  if (!list.length) { $('#issues').innerHTML = `<div class="empty">${active.length ? 'Bu filtrede sorun yok.' : 'Hiç sorun bulunmadı.'}</div>`; return; }
  $('#issues').innerHTML = list.map((r) => {
    const open = state.openRules.has(r.id);
    const items = open ? r.items.slice(0, 200).map((i) => `<li><a href="#" data-goto="${esc(i.url)}">${esc(i.url)}</a>${i.detail ? `<span class="d">${esc(i.detail)}</span>` : ''}</li>`).join('') : '';
    return `<div class="issue">
      <button type="button" data-rule="${r.id}" aria-expanded="${open}">
        <i class="dot ${r.severity}" title="${SEV[r.severity]}"></i>
        <span><span class="it">${esc(r.title)}</span><br><span class="ic">${esc(cat[r.category] || '')}${r.scope === 'site' ? ' · site geneli' : ''}</span></span>
        <span class="team">${esc(r.team)}</span>
        <span class="cnt">${r.count}</span>
      </button>
      ${open ? `<div class="issue-body">
        <p>${esc(r.description)}</p>
        <p class="fix"><b>Çözüm:</b> ${esc(r.fix)}</p>
        <ul class="issue-items">${items}</ul>
        ${r.count > 200 ? `<p class="muted">İlk 200 URL gösteriliyor. Tamamı Excel'de.</p>` : ''}
        ${r.scope !== 'site' ? `<button type="button" class="linkish" data-ruletable="${r.id}">Bu ${r.count} sayfayı tabloda göster</button>` : ''}
      </div>` : ''}
    </div>`;
  }).join('');
}
// ---------- Site checks (Sprint 2) ----------
function renderSiteChecks() {
  const { audit: a, checks: ck, meta, pages } = state.data;
  const rule = (id) => a.rules.find((r) => r.id === id);
  const worst = (ids) => ids.map(rule).filter((r) => r?.count).sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity])[0];
  const tile = (k, v, ids, off = false, sub = '') => {
    const w = off ? null : worst(ids);
    const cls = off ? 'off' : w ? w.severity : 'ok';
    return `<button type="button" class="${cls}" ${w ? `data-open="${w.id}"` : 'disabled'} title="${w ? esc(w.title) : ''}"><span class="k">${k}</span><span class="v">${esc(v)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</button>`;
  };
  const home = pages.find((p) => p.url === meta.startUrl);
  const homePage = home?.redirectChain?.length ? pages.find((p) => p.url === home.finalUrl) : home;
  const comp = rule('compression-missing')?.count;
  const tiles = [];
  const s = ck?.site;
  if (s) {
    const bad = s.variants.filter((v) => (rule('host-variant-duplicate')?.items || []).concat(rule('host-variant-redirect')?.items || []).some((i) => i.url === v.url)).length;
    const live = s.variants.filter((v) => !v.error || /CERT|SELF_SIGNED|VERIFY|ALTNAME/i.test(v.error)).length;
    tiles.push(tile('Site sürümleri', live ? `${live - bad} / ${live} doğru` : 'Tek sürüm', ['host-variant-duplicate', 'host-variant-redirect'], false, 'http/https, www'));
    const t = s.tls;
    const noHttps = !t && !rule('site-not-https')?.count;
    tiles.push(tile('SSL sertifikası', !t ? 'HTTPS yok' : t.connectFailed ? 'Bağlanılamadı' : t.error ? 'Geçersiz' : `${t.daysLeft} gün kaldı`, ['ssl-invalid', 'ssl-expiring', 'site-not-https'], noHttps || !!t?.connectFailed, t?.validTo ? `bitiş ${t.validTo.slice(0, 10)}` : ''));
    const age = +(/max-age\s*=\s*"?(\d+)/i.exec(s.hsts || '')?.[1] ?? 0);
    tiles.push(tile('HSTS', s.hsts === null ? 'HTTPS yok' : !s.hsts ? 'Yok' : age >= 86400 ? `Var · ${Math.round(age / 86400)} gün` : `Var · ${age} sn`, ['hsts-missing', 'hsts-short'], s.hsts === null));
    tiles.push(tile('llms.txt', s.llms.ok ? 'Var' : 'Yok', ['llms-txt-missing']));
  }
  if (homePage?.contentEncoding !== undefined) tiles.push(tile('Sıkıştırma', comp ? 'Yok' : homePage.contentEncoding || 'Gerek yok', ['compression-missing'], false, comp ? `${comp} sayfa` : ''));
  if (ck) {
    const lim = (n) => (n ? ` · ${n} limit dışı` : '');
    tiles.push(tile('Dış linkler', !ck.ran.external ? 'Kapalı' : ck.brokenLinks ? `${ck.brokenLinks} kırık` : 'Kırık yok', ['broken-external-link'], !ck.ran.external,
      ck.ran.external ? `${ck.links} kontrol${lim(ck.limited.external)}` : ''));
    const iv = [ck.brokenImages && `${ck.brokenImages} kırık`, ck.largeImages && `${ck.largeImages} büyük`].filter(Boolean).join(' · ') || 'Sorun yok';
    tiles.push(tile('Görseller', !ck.ran.images ? 'Kapalı' : iv, ['img-broken', 'img-too-large'], !ck.ran.images,
      ck.ran.images ? `${ck.images} kontrol${lim(ck.limited.images)}` : ''));
  }
  $('#siteChecks').innerHTML = tiles.join('');
  $('#siteChecks').hidden = !tiles.length;
}
$('#siteChecks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open]');
  if (!b) return;
  Object.assign(state, { sev: 'all', team: 'all' });
  state.openRules.add(b.dataset.open);
  renderIssues();
  document.querySelector(`[data-rule="${b.dataset.open}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
$('#sevFilter').addEventListener('click', (e) => { const b = e.target.closest('[data-sev]'); if (b) { state.sev = b.dataset.sev; renderIssues(); } });
$('#teamFilter').addEventListener('click', (e) => { const b = e.target.closest('[data-team]'); if (b) { state.team = b.dataset.team; renderIssues(); } });
$('#issues').addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) { e.preventDefault(); gotoPage(g.dataset.goto); return; }
  const t = e.target.closest('[data-ruletable]');
  if (t) { Object.assign(state, { rule: t.dataset.ruletable, filter: 'all', q: '', page: 0 }); $('#q').value = ''; renderFilters(); renderTable(); setTab('pages'); return; }
  const b = e.target.closest('button[data-rule]');
  if (b) { const id = b.dataset.rule; state.openRules.has(id) ? state.openRules.delete(id) : state.openRules.add(id); renderIssues(); }
});
function gotoPage(url) {
  Object.assign(state, { filter: 'all', rule: null, q: url.toLowerCase(), page: 0 });
  state.open.add(url);
  $('#q').value = url;
  renderFilters(); renderTable(); setTab('pages');
}

function renderFilters() {
  const pages = state.data.pages;
  const ruleObj = state.rule && state.data.audit?.rules.find((r) => r.id === state.rule);
  const ruleChip = ruleObj ? `<span class="rule-chip"><i class="dot ${ruleObj.severity}"></i>${esc(ruleObj.title)} <button type="button" data-clearrule aria-label="Kural filtresini kaldır">×</button></span>` : '';
  $('#filters').innerHTML = FILTERS.map(([k, name, fn]) => {
    const n = pages.filter(fn).length;
    if (!n && k !== 'all' && k !== 'ok') return '';
    return `<button type="button" role="tab" data-f="${k}" aria-selected="${state.filter === k}">${name} <b>${n}</b></button>`;
  }).join('') + ruleChip;
}
$('#filters').addEventListener('click', (e) => {
  if (e.target.closest('[data-clearrule]')) { state.rule = null; state.page = 0; renderFilters(); renderTable(); return; }
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  Object.assign(state, { filter: b.dataset.f, page: 0 });
  renderFilters(); renderTable();
});
$('#q').addEventListener('input', (e) => { Object.assign(state, { q: e.target.value.trim().toLowerCase(), page: 0 }); renderTable(); });
$('#resStrip').addEventListener('click', (e) => {
  const c = e.target.closest('.c[data-i]');
  if (!c) return;
  const p = state.data.pages[+c.dataset.i];
  Object.assign(state, { filter: 'all', q: p.url.toLowerCase(), page: 0 });
  state.open.add(p.url);
  $('#q').value = p.url;
  renderFilters(); renderTable();
});

function filtered() {
  const fn = FILTERS.find(([k]) => k === state.filter)[2];
  const q = state.q;
  const ruleUrls = state.rule ? new Set((state.data.audit.rules.find((r) => r.id === state.rule)?.items || []).map((i) => i.url)) : null;
  return state.data.pages.filter((p) => fn(p) && (!ruleUrls || ruleUrls.has(p.url)) && (!q || p.url.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q)));
}

function detailHtml(p) {
  const rows = [];
  const iss = state.issuesByUrl.get(p.url) || [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push(`<dt>${k}</dt><dd>${v}</dd>`); };
  if (iss.length) add('Sorunlar', iss.map(({ r, detail }) => `<span class="pi ${r.severity}">${SEV[r.severity]}</span> ${esc(r.title)}${detail ? ` <span class="small">${esc(detail).replace(/\n/g, '<br>')}</span>` : ''}`).join('<br>'));
  if (p.redirectChain?.length) add('Redirect zinciri', p.redirectChain.map((c) => `${c.status} ${esc(c.url)}`).join('<br>') + `<br>${esc(p.finalStatus)} ${esc(p.finalUrl)}`);
  add('Hata', p.error === 'blocked-private' ? 'İç ağ adresi. Yayındaki sunucu bu adresi taramaz.' : esc(p.error));
  add('Title', p.title !== undefined ? `${esc(p.title) || '<span class="flag">boş</span>'} <span class="small">(${(p.title || '').length} karakter${p.titleCount > 1 ? `, ${p.titleCount} adet` : ''})</span>` : '');
  add('Meta description', p.metaDescription !== undefined ? `${esc(p.metaDescription) || '<span class="flag">boş</span>'} <span class="small">(${(p.metaDescription || '').length} karakter)</span>` : '');
  add('H1', p.h1?.length ? p.h1.map(esc).join('<br>') : (p.h1 ? '<span class="flag">yok</span>' : ''));
  add('H2 sayısı', p.h2Count);
  if (p.headings?.length) {
    let prev = 0;
    add('Başlık ağacı', '<ul class="tree">' + p.headings.slice(0, 60).map((h) => {
      const skip = prev && h.l > prev + 1; prev = h.l;
      return `<li style="padding-left:${(h.l - 1) * 16}px"><span class="lv${skip ? ' skip' : ''}">H${h.l}</span>${h.t ? esc(h.t) : '<span class="flag">(boş)</span>'}${skip ? ' <span class="flag">seviye atlandı</span>' : ''}</li>`;
    }).join('') + (p.headings.length > 60 ? `<li class="small">+${p.headings.length - 60} başlık</li>` : '') + '</ul>');
  }
  add('Canonical', p.canonical ? esc(p.canonical) + (p.canonical !== p.url ? ' <span class="small">(farklı URL)</span>' : '') : (p.title !== undefined ? '<span class="flag">yok</span>' : ''));
  add('Meta robots', esc(p.metaRobots));
  add('X-Robots-Tag', esc(p.xRobotsTag));
  add('html lang', esc(p.htmlLang));
  add('Hreflang', p.hreflang?.length ? p.hreflang.map((h) => `${esc(h.lang)}: ${esc(h.url)}`).join('<br>') : '');
  add('Kelime sayısı', p.wordCount);
  add('Görseller', p.imageCount != null ? `${p.imageCount} görsel, ${p.imgNoAlt} alt yok, ${p.imgEmptyAlt} alt boş` : '');
  add('Linkler', p.linkCount ? `${p.linkCount} link (${p.externalLinkCount} dış)` : '');
  add('Sitemap', p.inSitemap ? 'Var' : 'Yok');
  add('Bulunduğu sayfa', p.foundOn ? esc(p.foundOn) : '');
  add('Bulunma yolu', esc(p.discoveredBy));
  add('Content-Type', esc(p.contentType));
  add('Boyut', p.sizeBytes ? `${(p.sizeBytes / 1024).toFixed(1)} KB` : '');
  add('Sıkıştırma', p.contentEncoding !== undefined && p.title !== undefined ? esc(p.contentEncoding) || '<span class="flag">yok</span>' : '');
  return `<dl>${rows.join('')}</dl>`;
}

function renderTable() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  state.page = Math.min(state.page, pages - 1);
  const slice = list.slice(state.page * PAGE, (state.page + 1) * PAGE);
  $('#countInfo').textContent = `${list.length} sonuç`;
  const tb = $('#table tbody');
  if (!slice.length) { tb.innerHTML = '<tr><td colspan="8" class="empty">Bu filtrede sonuç yok.</td></tr>'; $('#pager').innerHTML = ''; return; }
  tb.innerHTML = slice.map((p) => {
    const b = bucketOf(p);
    const isOpen = state.open.has(p.url);
    const h1n = p.h1 ? p.h1.length : '';
    const titleCell = p.title === undefined ? '<span class="small">—</span>'
      : p.title ? `${esc(p.title)} <span class="small">${p.title.length}</span>` : '<span class="flag">boş</span>';
    const target = p.redirectChain?.length ? `<div class="small">→ ${esc(p.finalUrl)}</div>` : '';
    return `<tr class="row-main${isOpen ? ' open' : ''}" data-url="${esc(p.url)}" tabindex="0" aria-expanded="${isOpen}">
      <td class="u">${esc(p.url)}${target}</td>
      <td class="n st ${b}">${p.blockedByRobots ? 'engel' : esc(p.status || 'hata')}</td>
      <td class="n">${(() => { const l = state.issuesByUrl.get(p.url) || []; if (!l.length) return ''; const top = l[0].r.severity; return `<span class="pi ${top}" title="${l.map((x) => x.r.title).join(', ')}">${l.length}</span>`; })()}</td>
      <td class="t">${titleCell}</td>
      <td class="n${h1n === 0 || h1n > 1 ? ' flag' : ''}">${h1n}</td>
      <td class="n">${p.inlinks ?? ''}</td>
      <td class="n">${p.depth ?? '—'}</td>
      <td class="n">${p.responseMs ?? ''}</td>
    </tr>${isOpen ? `<tr class="detail"><td colspan="8">${detailHtml(p)}</td></tr>` : ''}`;
  }).join('');
  $('#pager').innerHTML = pages > 1 ? `<button type="button" data-p="-1" ${state.page === 0 ? 'disabled' : ''}>Önceki</button>
    <span class="muted">${state.page + 1} / ${pages}</span>
    <button type="button" data-p="1" ${state.page >= pages - 1 ? 'disabled' : ''}>Sonraki</button>` : '';
}
function toggleRow(tr) {
  const url = tr.dataset.url;
  state.open.has(url) ? state.open.delete(url) : state.open.add(url);
  renderTable();
}
$('#table').addEventListener('click', (e) => { const tr = e.target.closest('tr.row-main'); if (tr) toggleRow(tr); });
$('#table').addEventListener('keydown', (e) => { const tr = e.target.closest('tr.row-main'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRow(tr); } });
$('#pager').addEventListener('click', (e) => { const b = e.target.closest('button[data-p]'); if (b) { state.page += +b.dataset.p; renderTable(); window.scrollTo({ top: $('#filters').offsetTop - 20 }); } });

$('#deleteBtn').addEventListener('click', async () => {
  if (!confirm('Bu tarama silinsin mi? Faz 3 karşılaştırması için JSON verisi de silinir.')) return;
  await api(`/api/crawls/${encodeURIComponent(currentId)}`, { method: 'DELETE' });
  location.hash = '#/';
});

// ---------- Landing ----------
// The strip under the URL field fills once, like a real crawl. Fixed pattern, no random.
function heroStrip() {
  const el = $('#heroStrip');
  if (el.childElementCount) return;
  const n = 96;
  el.innerHTML = Array.from({ length: n }, (_, i) => {
    const k = i % 23 === 7 ? 'client' : i % 11 === 4 ? 'redirect' : i % 37 === 30 ? 'blocked' : '';
    return `<i class="${k}" style="animation-delay:${(i * 14)}ms"></i>`;
  }).join('');
}
async function loadRules() {
  if ($('#catList').childElementCount) return;
  try {
    const r = await api('/api/rules');
    $('#ruleTotal').textContent = r.total;
    $('#catList').innerHTML = r.categories.filter((c) => c.count).map((c) => `<li>${esc(c.name)}<b>${c.count}</b></li>`).join('');
  } catch { $('#catList').closest('.cats').hidden = true; }
}

// ---------- Server mode ----------
// On the free plan the server sleeps and loses its files. Tell the user once, on every screen.
async function loadInfo() {
  try {
    const info = await api('/api/info');
    if (info.ephemeral) {
      $('#envNote').textContent = 'Bu sunucu ücretsiz planda çalışır. 15 dakika boşta kalınca uyur ve taramalar silinir. Tarama bitince Excel\'i hemen indirin.';
      $('#envNote').hidden = false;
    }
    window.__maxTargets = info.maxTargets;
    $('#crawlMax').max = info.maxUrls;
    if (+$('#crawlMax').value > info.maxUrls) $('#crawlMax').value = info.maxUrls;
    if (info.ephemeral) $('#prjDiskNote').textContent = 'Bu sunucu ücretsiz planda çalışır. Uyuyunca projeler ve taramalar silinir. Projeyi indirin. Sonra "Proje yükle" ile geri yükleyin ve siteleri tekrar tarayın.';
    const max = $('#form [name=maxUrls]');
    max.max = info.maxUrls;
    if (+max.value > info.maxUrls) max.value = info.maxUrls;
  } catch {}
}
loadInfo();

// ---------- Migration project (v0.7.0) ----------
// Steps: Proje → Tarama → Eşleştirme → 301 haritası → Yapılacaklar. One "next task" card on every step.
// v0.8.0: the 301 map comes before Yapılacaklar, because the work list depends on the map.
// v0.10.0: Canlıya çıkış (launch list from the staging crawls) is active.
const STEPS = [
  ['proje', 'Proje'], ['tarama', 'Tarama'], ['eslestirme', 'Eşleştirme'], ['harita', '301 haritası'], ['yapilacaklar', 'Yapılacaklar'],
  ['canliya', 'Canlıya çıkış'], ['dogrulama', 'Canlı doğrulama', true],
];
const PANES = { proje: 'stepProje', tarama: 'stepTarama', eslestirme: 'stepEslestirme', harita: 'stepHarita', yapilacaklar: 'stepYapilacaklar', canliya: 'stepCanliya' };
const MATCH_STEPS = ['eslestirme', 'harita', 'yapilacaklar', 'canliya'];
const ROLE = { old: 'Eski site', heir: 'Eski alan adına geçecek site', extra: 'Ek site' };
const HELP = {
  old: 'Bugün canlıda olan site. Araç bütün sayfalarını listeler.',
  heir: 'Canlıdan sonra eski alan adını bu site kullanır. Bütün 301\'ler bu sitede kurulur. Staging adresini yazın.',
  extra: 'Eski sitenin bir bölümü bu siteye taşınır. Örnek: Türkçe sayfalar ayrı alan adına gider.',
  live: 'Bu site canlıda hangi alan adını kullanacak? 301\'ler bu alan adına gider. Bilmiyorsanız boş bırakın.',
  result: 'Araç her eski adresi yeni sitede tek tek ister. Bu sayı o kontrolden sonra gelir. Listedeki "taramada" sayısı sadece taramaya bakar. Yönlendirmeler taramada her zaman görünmez. Bu yüzden iki sayı farklı olabilir.',
  root: 'Ana sayfa, kökteki sayfalar ve az sayfalı bölümler. Satırı açın ve sayfaları görün.',
};
const prj = { id: null, project: null, status: null, match: null, matchKey: '', matchErr: null, matchNeed: null, loading: false, step: 'proje', poll: null, saveTimer: null, openSecs: new Set(),
  mapTab: null, mapChoice: {}, mapManual: {}, mapShow: 100, mapSaving: false };
let projectList = [];
const help = (text) => `<details class="q"><summary aria-label="Açıklama">?</summary><p>${esc(text)}</p></details>`;
const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const hostOfUrl = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const siteByKey = (k) => prj.project?.sites.find((s) => s.key === k);
const siteName = (s, short = false) => (!s ? '?' : s.role === 'extra' ? (s.name || 'Ek site') : short && s.role === 'heir' ? 'Geçecek site' : ROLE[s.role]);
const siteHost = (s) => prj.status?.[s.key]?.host || hostOfUrl(s.url);
const isReady = (k) => ['done', 'stale'].includes(prj.status?.[k]?.state);

// ---------- Sidebar: projects first, then crawls that belong to no project ----------
async function loadProjects() {
  try { projectList = await api('/api/projects'); } catch { projectList = []; }
  const ul = $('#projects');
  ul.innerHTML = projectList.length ? projectList.map((p) => `<li><button type="button" data-pid="${esc(p.id)}" aria-current="${p.id === prj.id}">
    <span class="h-host">${esc(p.name)}</span><span class="h-sub">${p.sites} site · ${p.rules} kural · ${esc(fmtDate(p.updatedAt))}</span></button></li>`).join('')
    : '<li class="muted">Henüz proje yok.</li>';
  return projectList;
}
$('#projects').addEventListener('click', (e) => { const b = e.target.closest('[data-pid]'); if (b) location.hash = `#/project/${b.dataset.pid}`; });

// ---------- Landing: two modes ----------
function setMode(mode) {
  for (const b of document.querySelectorAll('.modes [data-mode]')) b.setAttribute('aria-checked', b.dataset.mode === mode);
  $('#auditStart').hidden = mode !== 'audit';
  $('#projectStart').hidden = mode !== 'project';
  (mode === 'audit' ? $('#url') : $('#prjNewName')).focus();
}
document.querySelector('.modes').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
$('#prjForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#prjNewName').value.trim();
  $('#prjFormErr').textContent = '';
  if (!name) { $('#prjFormErr').textContent = 'Proje adını yazın. Örnek: Şirket sitesi yenileme'; $('#prjNewName').focus(); return; }
  try {
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, structure: 'same', rules: [], sites: [{ role: 'old', url: '' }, { role: 'heir', url: '' }] }) });
    $('#prjNewName').value = '';
    location.hash = `#/project/${p.id}/proje`;
  } catch (err) { $('#prjFormErr').textContent = err.message; }
});
async function uploadProject(file, errEl) {
  errEl.textContent = '';
  try {
    const def = JSON.parse(await file.text());
    const p = await api('/api/projects', { method: 'POST', body: JSON.stringify(def) });
    location.hash = `#/project/${p.id}`;
  } catch (err) { errEl.textContent = err instanceof SyntaxError ? 'Dosya okunamadı. "Projeyi indir" ile alınan JSON dosyasını seçin.' : err.message; }
}
$('#prjUpload').addEventListener('change', (e) => { if (e.target.files[0]) uploadProject(e.target.files[0], $('#prjFormErr')); e.target.value = ''; });
$('#prjUpload2').addEventListener('change', (e) => { if (e.target.files[0]) uploadProject(e.target.files[0], $('#prjSaved')); e.target.value = ''; });

// ---------- Open ----------
async function openProject(id, step) {
  currentId = null; es?.close();
  show('projectView');
  if (prj.id !== id) Object.assign(prj, { id, project: null, status: null, match: null, matchKey: '', matchErr: null, matchNeed: null, openSecs: new Set(), mapTab: null, mapChoice: {}, mapManual: {}, mapShow: 100 });
  prj.step = PANES[step] ? step : prj.step && prj.id === id ? prj.step : null;
  loadHistory();
  try { Object.assign(prj, await api(`/api/projects/${encodeURIComponent(id)}`)); }
  catch (e) {
    $('#prjName').textContent = 'Proje bulunamadı';
    $('#prjSummary').textContent = 'Sunucu yeniden başladıysa projeler silinmiş olabilir. "Proje yükle" ile proje dosyasını tekrar yükleyin.';
    $('#prjSteps').innerHTML = ''; $('#prjNext').innerHTML = '';
    for (const pane of Object.values(PANES)) $('#' + pane).hidden = true;
    return;
  }
  if (!prj.step) prj.step = firstStep();
  renderProject();
  watchCrawls();
  if (MATCH_STEPS.includes(prj.step)) loadMatch();
}
// A new project opens on "Proje". A project with crawls opens where the work is.
function firstStep() {
  const p = prj.project;
  if (!p.sites.find((s) => s.role === 'old').url || !p.sites.find((s) => s.role === 'heir').url) return 'proje';
  return isReady('old') && isReady('heir') ? 'eslestirme' : 'tarama';
}
function goStep(step) { location.hash = `#/project/${prj.id}/${step}`; }

function renderProject() {
  const p = prj.project;
  $('#prjName').textContent = p.name;
  const last = Object.values(prj.status).map((x) => x.startedAt).filter(Boolean).sort().pop();
  const dayDiff = last ? Math.floor((Date.now() - new Date(last)) / 864e5) : null;
  $('#prjSummary').textContent = `${p.sites.length} site · ${p.rules.length} kural · ${last ? `son tarama ${dayDiff === 0 ? 'bugün' : dayDiff === 1 ? 'dün' : fmtDate(last)}` : 'tarama yok'}`;
  const state = stepStates();
  $('#prjSteps').innerHTML = STEPS.map(([k, name, later], i) => later
    ? `${STEPS[i - 1][2] ? '' : '<li class="later-h" aria-hidden="true">Sonraki sürüm</li>'}<li><span class="step later" title="Sonraki sürüm"><i>${i + 1}</i>${name}<span class="sr"> (sonraki sürüm)</span></span></li>`
    : `<li><button type="button" class="step ${state[k] || ''}" data-step="${k}" aria-current="${prj.step === k ? 'step' : 'false'}"><i>${state[k] === 'done' ? '✓' : i + 1}</i>${name}</button></li>`).join('');
  for (const [k, pane] of Object.entries(PANES)) $('#' + pane).hidden = k !== prj.step;
  renderNext();
  if (prj.step === 'proje') renderSites();
  if (prj.step === 'tarama') renderCrawls();
  if (prj.step === 'eslestirme') renderSections();
  if (prj.step === 'harita') renderMap();
  if (prj.step === 'yapilacaklar') renderTodo();
  if (prj.step === 'canliya') renderLaunch();
  $('#prjSteps').querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}
$('#prjSteps').addEventListener('click', (e) => { const b = e.target.closest('[data-step]'); if (b) goStep(b.dataset.step); });

// done = step finished, todo = needs work. Used for the step bar marks.
function stepStates() {
  const p = prj.project, out = {};
  const sitesOk = p.sites.filter((s) => s.role !== 'extra').every((s) => s.url) && (p.structure !== 'domains' || p.sites.some((s) => s.role === 'extra' && s.url));
  out.proje = sitesOk ? 'done' : 'todo';
  out.tarama = p.sites.every((s) => !s.url || isReady(s.key)) && isReady('old') && isReady('heir') ? 'done' : sitesOk ? 'todo' : '';
  if (prj.match) {
    // v0.8.0: a "not found" section no longer blocks: the 301 map suggests a new page for every page.
    out.eslestirme = 'done';
    const mp = prj.match.map?.summary;
    if (mp) out.harita = mp.pending || mp.none ? 'todo' : 'done';
    out.yapilacaklar = workCount() ? 'todo' : 'done';
    if (prj.match.launch) out.canliya = prj.match.launch.total ? 'todo' : 'done';
  }
  return out;
}

// ---------- Next task: one sentence, one button ----------
function nextTask() {
  const p = prj.project, st = prj.status;
  const old = p.sites.find((s) => s.role === 'old'), heir = p.sites.find((s) => s.role === 'heir');
  const extras = p.sites.filter((s) => s.role === 'extra');
  if (!old.url) return { text: 'Eski sitenin adresini yazın. Araç önce bu siteyi tarar.', btn: 'Siteleri yazın', act: { step: 'proje', focus: 'old' } };
  if (!heir.url) return { text: 'Eski alan adına geçecek sitenin adresini yazın. Staging adresi olabilir.', btn: 'Adresi yazın', act: { step: 'proje', focus: 'heir' } };
  if (p.structure === 'domains' && !extras.some((s) => s.url)) return { text: 'Diller ayrı alan adlarına taşınıyor. Ek siteyi ve adresini yazın.', btn: 'Ek siteyi yazın', act: { step: 'proje', addSite: !extras.length, focus: extras[0]?.key } };
  const running = p.sites.find((s) => st[s.key]?.state === 'running');
  if (running) return { text: `${siteName(running)} taranıyor. ${st[running.key].done} URL tarandı.`, btn: 'Taramayı izle', act: { live: st[running.key].jobId } };
  for (const s of [old, heir, ...extras].filter((x) => x.url)) {
    const x = st[s.key];
    if (x.state === 'none') return { text: `${siteName(s)} taranmadı.${s.role === 'extra' ? '' : ' Eşleştirme için gerekli.'}${x.error ? ` Son deneme hata verdi: ${x.error}` : ''}`, btn: `${siteName(s, true)} tara`, act: { crawl: s.key } };
    if (x.state === 'deleted') return { text: `${siteName(s)} taraması silinmiş. Proje tanımı duruyor. Tekrar tarayın.`, btn: 'Tekrar tara', act: { crawl: s.key } };
    if (x.state === 'stale') return { text: `${siteName(s)} adresi değişti. Tarama eski adrese ait. Tekrar tarayın.`, btn: 'Tekrar tara', act: { crawl: s.key } };
    if (x.pages && !x.ok) return { text: `${siteName(s)} taramasında açılan sayfa yok.${x.blocked ? ' robots.txt sayfaları engelledi.' : ''} Ayarları değiştirip tekrar tarayın.`, btn: 'Tarama ayarlarını aç', act: { step: 'tarama', settings: true } };
  }
  if (prj.loading) return { text: 'Eşleştiriliyor. Araç eski adresleri yeni sitelerde istiyor.', btn: null };
  if (prj.matchErr) return { text: prj.matchErr, btn: 'Tekrar dene', act: { reload: true } };
  if (!prj.match) return { text: 'Siteler tarandı. Eski bölümleri yeni sitelerle eşleştirin.', btn: 'Eşleştirmeyi aç', act: { step: 'eslestirme' } };
  // v0.8.1: a probably wrong section decision comes first. The 301 map depends on it.
  const bad = prj.match.sections.find((x) => x.alert);
  if (bad && prj.step !== 'harita') return { text: `${sectionName(bad)} bölümünün kararı yanlış olabilir. ${alertShort(bad)} Bölümü açın ve önerilen seçimi kullanın.`, btn: 'Bölümü gösterin', act: { step: 'eslestirme', focusSection: bad.from } };
  // v0.10.0: on Canlıya çıkış the card follows the launch list: critical, decisions, checks, then the launch switches.
  if (prj.step === 'canliya' && prj.match.launch) return launchTask(prj.match.launch);
  // v0.9.0: a thin new site (content not entered yet) makes its tasks unreal. Recrawl first, or accept the site.
  const thin = prj.match.todo?.places.find((x) => x.ready?.state === 'thin');
  if (thin) {
    const ts = siteByKey(thin.site);
    return { text: `${siteName(ts)} hazır değil gibi görünüyor. Bu sitenin işleri şimdilik ölçülemez. İçerik girişi bitince tekrar tarayın.`,
      btn: `${siteName(ts, true)} tekrar tara`, act: { crawl: thin.site } };
  }
  const dec = prj.match.sections.filter((x) => x.needsDecision);
  if (dec.length && prj.step === 'eslestirme') {
    const what = dec.every((x) => !x.found) ? 'sayfalar' : 'sayfaların çoğu';
    return { text: `${dec.map((x) => sectionName(x)).join(', ')} ${dec.length > 1 ? 'bölümlerinde' : 'bölümünde'} ${what} yeni sitelerde bulunamadı. Adresler değişmiş olabilir. 301 haritası her sayfa için yeni sayfa önerir. Bölüm başka siteye gidiyorsa önce siteyi seçin.`,
      btn: 'Haritayı açın', act: { step: 'harita' } };
  }
  // 301 map (v0.8.0): suggestions wait for approval, pages without a suggestion wait for a choice.
  const mp = prj.match.map?.summary;
  // v0.9.0: on Yapılacaklar the card follows the work list. Pages with a missing target are site work there, not decisions.
  if (prj.step === 'yapilacaklar' && prj.match.todo) {
    const t = prj.match.todo;
    if (!t.total) return { text: 'Bütün sayfalar yerinde. Yapılacak iş yok.', btn: 'Excel indir', act: { excel: true } };
    const open = t.items.filter((i) => i.task === 'map' && !i.held).length;
    if (open) return { text: `${t.total} iş var. ${open} sayfa 301 haritasında karar bekliyor. Karar verince iş doğru yere gider.`, btn: 'Haritayı açın', act: { step: 'harita' } };
    const top = [...t.places].sort((a, b) => b.n - a.n)[0];
    return { text: `${t.total} iş var. En çok iş: ${top.title} (${top.n}). Excel her işi yeri ve ekibi ile verir.`, btn: 'Excel indir', act: { excel: true } };
  }
  if (mp && (mp.pending || mp.none)) {
    const noneText = mp.none ? ` ${mp.none} sayfa için öneri yok: adresi siz seçin.` : '';
    if (prj.step !== 'harita') return { text: `Eşleştirme tamam. ${mp.pending + mp.none} sayfa için yeni adres gerekli. Araç ${mp.pending} sayfa için öneri buldu.`, btn: 'Haritayı açın', act: { step: 'harita' } };
    if (mp.high) return { text: `${mp.pending} sayfa için öneri onay bekliyor. ${mp.high} öneri yüksek güvenli.${noneText}`, btn: `Yüksek güvenlileri onayla (${mp.high})`, act: { approveHigh: true } };
    if (mp.pending) return { text: `${mp.pending} sayfa için öneri onay bekliyor. Önerileri tek tek kontrol edin.${noneText}`, btn: 'İlk satırı açın', act: { mapTab: 'pending' } };
    return { text: `${mp.none} sayfa için öneri yok. En yakın sayfayı seçin veya 410 verin.`, btn: 'Listeyi açın', act: { mapTab: 'none' } };
  }
  if (prj.step === 'harita') {
    if (mp?.warn) return { text: `${mp.warn} onaylı satırda hedef sayfa son taramada yok. Satırları kontrol edin.`, btn: 'Satırları gösterin', act: { mapTab: 'approved' } };
    return { text: `Harita hazır. ${mp ? mp.rule + mp.approved + mp.gone : 0} satır 301 listesinde. Listeyi indirin ve geliştiriciye verin.`, btn: 'CSV indir', act: { csv: true } };
  }
  const n = workCount();
  if (!n && prj.step === 'yapilacaklar') return { text: 'Bütün sayfalar yerinde. Yapılacak iş yok. Sıradaki adım: canlıya çıkış listesi.', btn: 'Canlıya çıkışı açın', act: { step: 'canliya' } };
  if (!n) return { text: 'Bütün sayfalar yerinde. Yapılacak iş yok.', btn: 'Excel indir', act: { excel: true } };
  if (prj.step !== 'yapilacaklar') return { text: `Eşleştirme tamam. ${n} iş var.`, btn: 'Yapılacakları açın', act: { step: 'yapilacaklar' } };
  const top = [...(prj.match.todo?.places || [])].sort((a, b) => b.n - a.n)[0];
  return { text: `${n} iş var.${top?.n ? ` En çok iş: ${top.title} (${top.n}).` : ''} Excel her işi yeri ve ekibi ile verir.`, btn: 'Excel indir', act: { excel: true } };
}
// Pages that need work: missing pages, missing or wrong 301s, content loss, decisions.
function workCount() {
  if (prj.match?.todo) return prj.match.todo.total; // v0.9.0: the work list by place
  const s = prj.match?.summary;
  if (!s) return 0;
  return s.lost + (s.no301 || 0) + (s.notarget || 0) + (s.redirectFix || 0) + (s.moveFix || 0) + s.contentLost - (prj.match.rows.moved || []).filter((r) => r.lostCount).length + (s.removed || 0) + s.unknown + s.unlinked;
}
function renderNext() {
  const t = nextTask();
  prj.nextAct = t.act;
  $('#prjNext').innerHTML = `<p>${esc(t.text)}</p>${t.btn ? `<button type="button" class="primary" id="nextBtn">${esc(t.btn)}</button>` : ''}`;
}
$('#prjNext').addEventListener('click', async (e) => {
  if (!e.target.closest('#nextBtn')) return;
  const a = prj.nextAct || {};
  if (a.live) { location.hash = `#/live/${a.live}`; return; }
  if (a.crawl) { goStep('tarama'); await startSiteCrawl(a.crawl); return; }
  if (a.excel) { location.href = `/api/projects/${prj.id}/excel`; return; }
  if (a.csv) { location.href = `/api/projects/${prj.id}/map?format=csv`; return; }
  if (a.approveHigh) { approveHigh(); return; }
  if (a.mapTab) {
    prj.mapTab = a.mapTab;
    if (prj.step !== 'harita') { goStep('harita'); return; }
    renderMap();
    setTimeout(() => document.querySelector('#mapRows .mrow select, #mapRows .mrow button')?.focus(), 30);
    return;
  }
  if (a.reload) { prj.matchKey = ''; loadMatch(); return; }
  if (a.addSite) addSite();
  if (a.open) { lnState.open = a.open; renderLaunch(); setTimeout(() => document.querySelector(`[data-ln="${CSS.escape(a.open)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30); return; }
  if (a.settings) setTimeout(() => { document.querySelector('#stepTarama details').open = true; $('#crawlAuth').focus(); });
  if (a.step && a.step !== prj.step) goStep(a.step);
  setTimeout(() => {
    if (a.focus) document.querySelector(`[data-site="${a.focus}"] [name=${a.focusField || 'url'}]`)?.focus();
    if (a.focusSection) {
      prj.openSecs.add(a.focusSection);
      renderSections();
      const row = document.querySelector(`[data-sec="${CSS.escape(a.focusSection)}"]`);
      row?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      row?.querySelector('select')?.focus({ preventScroll: true });
    }
  }, 50);
});

// ---------- Step 1: Proje ----------
function renderSites() {
  const p = prj.project;
  for (const r of document.querySelectorAll('#prjStructure input')) r.checked = r.value === (p.structure === 'domains' ? 'domains' : 'same'); // v0.10.0: old 'paths' = 'same'
  $('#prjSites').innerHTML = p.sites.map((s) => `<div class="site" data-site="${esc(s.key)}">
    <div class="site-role">${esc(ROLE[s.role])}${help(HELP[s.role])}</div>
    ${s.role === 'extra' ? `<label>Ad<input name="name" value="${esc(s.name)}" placeholder="Türkçe" maxlength="40" autocomplete="off"></label>` : ''}
    <label class="${s.role === 'extra' ? '' : 'span2'}">${s.role === 'old' ? 'Canlı adres' : 'Adres (staging olabilir)'}<input name="url" value="${esc(s.url)}" placeholder="${s.role === 'old' ? 'https://www.ornek.com' : 'https://staging.ornek.com'}" spellcheck="false" autocomplete="off"></label>
    ${s.role === 'extra' ? `<label><span class="lbl">Canlı alan adı ${help(HELP.live)}</span><input name="live" value="${esc(s.live)}" placeholder="tr.ornek.com" spellcheck="false" autocomplete="off"></label>
      <button type="button" class="ghost small" data-remove="${esc(s.key)}">Kaldır</button>` : ''}
  </div>`).join('');
  $('#prjAddSite').hidden = p.sites.filter((s) => s.role === 'extra').length >= (cmpMax() - 1);
  $('#prjExport').href = `/api/projects/${prj.id}/export`;
}
const cmpMax = () => window.__maxTargets || 4;
function readSites() {
  for (const row of document.querySelectorAll('#prjSites .site')) {
    const s = siteByKey(row.dataset.site);
    if (!s) continue;
    for (const f of ['name', 'url', 'live']) { const i = row.querySelector(`[name=${f}]`); if (i) s[f] = i.value.trim(); }
  }
  const r = document.querySelector('#prjStructure input:checked');
  if (r) prj.project.structure = r.value;
}
async function saveProject(msg = 'Kaydedildi.') {
  clearTimeout(prj.saveTimer);
  $('#prjSaved').textContent = 'Kaydediliyor…';
  try {
    Object.assign(prj, await api(`/api/projects/${prj.id}`, { method: 'PUT', body: JSON.stringify(prj.project) }));
    $('#prjSaved').textContent = msg;
    prj.matchKey = '';
    loadHistory();
    renderProject();
    return true;
  } catch (e) { $('#prjSaved').textContent = e.message; $('#prjSaved').classList.add('flag'); setTimeout(() => $('#prjSaved').classList.remove('flag'), 4000); return false; }
}
function addSite() {
  readSites();
  const used = new Set(prj.project.sites.map((s) => s.key));
  let i = 1; while (used.has(`s${i}`)) i++;
  prj.project.sites.push({ key: `s${i}`, role: 'extra', name: '', url: '', live: '', crawlId: null });
  renderSites();
  document.querySelector(`[data-site="s${i}"] [name=name]`)?.focus();
}
$('#prjAddSite').addEventListener('click', addSite);
$('#prjSites').addEventListener('change', () => { readSites(); saveProject(); });
$('#prjSites').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  readSites();
  const key = b.dataset.remove;
  const used = prj.project.rules.filter((r) => r.site === key).length;
  if (used && !confirm(`Bu siteye giden ${used} kural da silinir. Devam edilsin mi?`)) return;
  prj.project.sites = prj.project.sites.filter((s) => s.key !== key);
  prj.project.rules = prj.project.rules.filter((r) => r.site !== key);
  saveProject('Site kaldırıldı.');
});
$('#prjStructure').addEventListener('change', () => {
  readSites();
  if (prj.project.structure === 'domains' && !prj.project.sites.some((s) => s.role === 'extra')) { addSite(); readSites(); }
  saveProject();
});
$('#prjDelete').addEventListener('click', async () => {
  if (!confirm('Proje silinsin mi? Taramalar silinmez.')) return;
  await api(`/api/projects/${prj.id}`, { method: 'DELETE' });
  prj.id = null;
  location.hash = '#/';
});

// ---------- Step 2: Tarama ----------
const STATE = {
  none: ['Taranmadı', 'idle'], running: ['Taranıyor', 'run'], done: ['Tamam', 'ok'], deleted: ['Silinmiş', 'idle'], stale: ['Adres değişti', 'warn'],
};
let crawlHistory = [];
async function renderCrawls() {
  try { crawlHistory = (await api('/api/crawls')).history; } catch {}
  const p = prj.project;
  $('#prjCrawls').innerHTML = p.sites.map((s) => {
    const x = prj.status[s.key] || { state: 'none' };
    const [label, cls] = STATE[x.state];
    const host = siteHost(s);
    const tag = x.state === 'done' ? `${label} · ${x.pages} sayfa` : x.state === 'running' ? `${label} · ${x.done} URL` : label;
    const warnTag = x.state === 'done' && x.pages && !x.ok ? '<span class="tag-s warn">Açılan sayfa yok</span>' : x.state === 'done' && x.limitReached ? '<span class="tag-s warn">URL limiti</span>' : '';
    const same = crawlHistory.filter((h) => host && bare(h.host) === bare(host) && h.id !== x.crawlId);
    const btn = !s.url ? `<button type="button" class="ghost small" data-goto-proje>Adresi yazın</button>`
      : x.state === 'running' ? `<a class="ghost small" href="#/live/${esc(x.jobId)}">İzle</a>`
      : `<button type="button" class="ghost small${x.state === 'done' ? '' : ' strong'}" data-crawl="${esc(s.key)}">${x.state === 'done' ? 'Tekrar tara' : 'Tara'}</button>`;
    return `<div class="crawl-row" data-site="${esc(s.key)}">
      <div class="crawl-main"><b>${esc(host || 'Adres yok')}</b><span class="small">${esc(siteName(s))}</span></div>
      <div class="crawl-state"><span class="tag-s ${cls}">${esc(tag)}</span>${warnTag}
        ${x.startedAt ? `<span class="small">${esc(fmtDate(x.startedAt))}</span>` : ''}${x.error ? `<span class="small flag">Son deneme: ${esc(x.error)}</span>` : ''}
        ${x.crawlId && x.state === 'done' ? `<a class="small" href="#/crawl/${esc(x.crawlId)}">Sorunları aç</a>` : ''}</div>
      <div class="crawl-act">${btn}${same.length && x.state !== 'running' ? `<label class="sr" for="link-${esc(s.key)}">Var olan taramayı bağla</label>
        <select id="link-${esc(s.key)}" data-link="${esc(s.key)}"><option value="">Var olan tarama…</option>${same.map((h) => `<option value="${esc(h.id)}">${esc(fmtDate(h.startedAt))} · ${h.summary.total} URL</option>`).join('')}</select>` : ''}</div>
    </div>`;
  }).join('');
}
async function startSiteCrawl(key) {
  $('#crawlErr').textContent = '';
  try {
    await api(`/api/projects/${prj.id}/crawl`, { method: 'POST', body: JSON.stringify({ site: key, options: {
      auth: $('#crawlAuth').value.trim() || null, ignoreRobots: $('#crawlRobots').checked, maxUrls: $('#crawlMax').value,
    } }) });
    Object.assign(prj, await api(`/api/projects/${prj.id}`));
    prj.match = null; prj.matchKey = '';
    renderProject();
    watchCrawls();
  } catch (e) { $('#crawlErr').textContent = e.message; }
}
$('#prjCrawls').addEventListener('click', (e) => {
  const b = e.target.closest('[data-crawl]');
  if (b) { b.disabled = true; startSiteCrawl(b.dataset.crawl); }
  if (e.target.closest('[data-goto-proje]')) goStep('proje');
});
$('#prjCrawls').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-link]');
  if (!sel?.value) return;
  siteByKey(sel.dataset.link).crawlId = sel.value;
  await saveProject('Tarama bağlandı.');
});
// While a crawl runs, the project screen asks the server every 2 seconds.
function watchCrawls() {
  clearTimeout(prj.poll);
  const running = Object.values(prj.status || {}).some((x) => x.state === 'running');
  if (!running) return;
  prj.poll = setTimeout(async () => {
    if ($('#projectView').hidden) return;
    try {
      const d = await api(`/api/projects/${prj.id}`);
      const finished = Object.keys(d.status).some((k) => prj.status[k]?.state === 'running' && d.status[k].state !== 'running');
      Object.assign(prj, d);
      if (finished) { prj.match = null; prj.matchKey = ''; loadHistory(); }
      renderProject();
    } catch {}
    watchCrawls();
  }, 2000);
}

// ---------- Step 3: Eşleştirme ----------
const crawlKey = () => JSON.stringify([prj.project.updatedAt, Object.values(prj.status).map((x) => x.crawlId)]);
async function loadMatch() {
  const key = crawlKey();
  if (prj.matchKey === key || prj.loading) { renderProject(); return; }
  if (!isReady('old') || !isReady('heir')) { prj.match = null; prj.matchErr = null; renderProject(); return; }
  prj.loading = true; prj.matchErr = null;
  renderProject();
  try { prj.match = await api(`/api/projects/${prj.id}/match`); prj.matchKey = key; }
  catch (e) { prj.match = null; prj.matchErr = e.message; }
  finally { prj.loading = false; }
  renderProject();
}
const sectionName = (x) => (x.from === '/*' ? 'Kök ve küçük bölümler' : x.from.slice(0, -1));
// Short state of one old page in the section list. Green: the page is in place. Amber: work is needed.
const PAGE_OK = new Set(['same', 'changed', 'redirected', 'moved']);
const PAGE_KIND = {
  same: 'Aynı yolda', changed: 'Aynı yolda, içerik değişti', redirected: 'Yönleniyor', unlinked: 'Açılıyor, link yok',
  moved: 'Taşındı, 301 kurulu', no301: 'Taşındı, 301 eksik', notarget: 'Hedef yok', lost: 'Bulunamadı',
  removed: 'Bölüm kaldırıldı', unknown: 'Kontrol edilemedi',
};
function sectionPages(x) {
  const rows = x.pageList.map((g) => {
    const url = /^https?:\/\//.test(g.url) ? g.url : '';
    const addr = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : '';
    const note = g.found ? addr : [url ? `Aranan: ${addr}` : '', g.reason ? esc(g.reason) : ''].filter(Boolean).join(' · ');
    return `<li class="pg${g.found ? '' : ' miss'}"><code>${esc(g.path)}</code>
      <span class="tag-s ${PAGE_OK.has(g.kind) ? 'ok' : 'warn'}">${esc(PAGE_KIND[g.kind] || g.kind)}</span>
      <span class="pg-to small">${note}</span></li>`;
  }).join('');
  const missing = x.pages - x.found;
  const head = !missing ? 'Bütün sayfalar bulundu.' : missing === x.pages ? 'Hiçbir sayfa bulunamadı.' : `${missing} sayfa bulunamadı. Bunlar listenin başında.`;
  return `<div class="sec-pages" id="pages-${esc(x.from)}"><p class="small">${head}${x.more ? ` İlk ${x.pageList.length} sayfa görünüyor. Bütün liste Excel'de.` : ''}</p><ul>${rows}</ul></div>`;
}
function optionLabel(sec, o) {
  if (o.drop) return 'Bölüm kaldırıldı';
  const s = siteByKey(o.site);
  const seg = sec.from === '/*' ? '' : sec.from.slice(0, -1);
  const how = o.to === sec.from ? 'aynı yol' : o.to === '/*' ? `${seg} kalkar` : seg ? `${seg} → ${o.to.slice(0, -1)}` : `${o.to.slice(0, -1)} eklenir`;
  return `${siteName(s, true)} · ${how}`;
}
const optVal = (o) => (o.drop ? 'drop' : `${o.site}|${o.to}`);
// v0.8.1: html lang codes for the section alert.
const LANG = { tr: 'Türkçe', en: 'İngilizce', fr: 'Fransızca', de: 'Almanca', es: 'İspanyolca', it: 'İtalyanca', ar: 'Arapça', ru: 'Rusça', nl: 'Felemenkçe', pt: 'Portekizce' };
const langName = (l) => LANG[l] || `"${l}" dili`;
function alertShort(x) {
  const a = x.alert;
  if (a.kind === 'lang') return `Sayfalar ${langName(a.lang)}, seçilen site ${langName(a.curLang)}.`;
  if (a.kind === 'lang-drop') return `Bölüm kaldırıldı seçili, ama ${langName(a.lang)} site bu sayfaları buluyor.`;
  return 'Seçim taramada hiçbir sayfa bulmuyor.';
}
function alertText(x) {
  const a = x.alert;
  if (!a) return '';
  const better = `${optionLabel(x, a.better)} (taramada ${a.better.hits} / ${x.pages})`;
  if (a.kind === 'lang') return `Bu bölümün sayfaları ${langName(a.lang)}. Seçilen site ${langName(a.curLang)}. ${langName(a.lang)} site var: ${better}. 301 haritası ${langName(a.lang)} sayfalar için ${langName(a.lang)} sayfa önerir.`;
  if (a.kind === 'lang-drop') return `Bölüm kaldırıldı seçili. Ama ${langName(a.lang)} site bu bölümün sayfalarını buluyor: ${better}.`;
  return `Bu seçim taramada hiçbir sayfa bulmuyor. Daha iyi seçim: ${better}.`;
}
function renderSections() {
  const busy = prj.loading;
  $('#matchBusy').hidden = !busy;
  const m = prj.match;
  $('#matchErr').textContent = !busy && prj.matchErr ? prj.matchErr : '';
  renderLsImport();
  if (!m) {
    $('#prjSections').innerHTML = !busy && !prj.matchErr && (!isReady('old') || !isReady('heir'))
      ? '<div class="empty">Eşleştirme için eski site ve eski alan adına geçecek site taranmalı. Sıradaki iş kartındaki düğmeyi kullanın.</div>' : '';
    $('#matchWarn').innerHTML = '';
    renderRuleEditor();
    return;
  }
  $('#matchWarn').innerHTML = m.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('');
  $('#prjSections').innerHTML = `<div class="sec-head"><span>Eski bölüm</span><span></span><span>Nereye gidiyor?</span><span class="lbl">Sonuç ${help(HELP.result)}</span></div>` + m.sections.map((x) => {
    const cur = x.needsDecision ? 'decide' : optVal(x.current);
    const opts = [...x.options];
    if (!x.current.drop && !opts.some((o) => optVal(o) === cur) && cur !== 'decide') opts.unshift({ ...x.current, hits: null });
    const optsHtml = (x.needsDecision ? '<option value="decide" selected>Karar verin…</option>' : '')
      + opts.map((o) => `<option value="${esc(optVal(o))}"${optVal(o) === cur ? ' selected' : ''}>${esc(optionLabel(x, o))}${o.hits != null ? ` · taramada ${o.hits} / ${x.pages}` : ''}</option>`).join('')
      + `<option value="drop"${cur === 'drop' ? ' selected' : ''}>Bölüm kaldırıldı</option>`;
    const ratio = x.found / x.pages;
    const extra = [x.no301 && `${x.no301} sayfada 301 eksik`, x.notarget && `${x.notarget} hedef yok`].filter(Boolean).join(' · ');
    // Not found is not removed: the row says "Bulunamadı" and asks for a choice. It never suggests "Bölüm kaldırıldı".
    const res = x.needsDecision ? [x.found ? `${x.found} / ${x.pages} bulundu` : 'Bulunamadı', 'warn', 'Adresler değişmiş olabilir.']
      : x.current.drop ? ['301 veya 410 gerekli', 'idle', ''] : [`${x.found} / ${x.pages} bulundu`, ratio >= 0.999 && !extra ? 'ok' : 'warn', extra];
    const hint = x.needsDecision && x.suggestion?.site ? `<span class="tag-s warn">Öneri: ${esc(optionLabel(x, x.suggestion))}</span>` : '';
    const why = x.needsDecision && x.suggestion?.why ? `<p class="small sec-why">${esc(x.suggestion.why)}</p>` : '';
    const alert = x.alert ? `<p class="small sec-why warn-t">${esc(alertText(x))}</p><button type="button" class="ghost small" data-use="${esc(optVal(x.alert.better))}" data-use-from="${esc(x.from)}">Bu seçimi kullan</button>` : '';
    const open = prj.openSecs.has(x.from);
    return `<div class="sec${x.needsDecision || x.alert ? ' decide' : ''}" data-sec="${esc(x.from)}">
      <div class="sec-from"><code>${esc(x.from === '/*' ? '/' : x.from.slice(0, -1))}</code>
        <span class="small">${x.from === '/*' ? `Kök ve küçük bölümler ${help(HELP.root)} · ` : ''}${x.pages} sayfa</span>
        <button type="button" class="sec-open" data-open="${esc(x.from)}" aria-expanded="${open}" aria-controls="pages-${esc(x.from)}">${open ? 'Sayfaları gizle' : 'Sayfaları göster'}</button></div>
      <span class="cmp-arrow" aria-hidden="true">→</span>
      <div class="sec-to"><label class="sr" for="sec-${esc(x.from)}">${esc(sectionName(x))} nereye gidiyor?</label>
        <select id="sec-${esc(x.from)}" data-from="${esc(x.from)}">${optsHtml}</select>
        ${x.auto ? `<span class="tag-s idle" title="${esc(x.suggestion?.why || 'Araç bu taşımayı önerdi. Değiştirmek için listeden seçin.')}">Öneri</span>` : ''}${hint}${why}${alert}</div>
      <div class="sec-res"><span class="tag-s ${res[1]}">${esc(res[0])}</span>${res[2] ? `<span class="small">${esc(res[2])}</span>` : ''}</div>
      ${open ? sectionPages(x) : ''}
    </div>`;
  }).join('') + `<p class="small sec-note">"Taramada" sayısı: seçimin taramalarda bulduğu sayfa. "Bulundu" sayısı: araç her adresi tek tek istedikten sonra bulunan sayfa. "Öneri" etiketi: araç bu taşımayı kendisi seçti. Değiştirmek için listeden seçin.</p>`;
  renderRuleEditor();
}
async function setSection(from, value) {
  const rules = prj.project.rules.filter((r) => r.from !== from);
  if (value === 'drop') rules.push({ from, drop: true });
  else { const [site, to] = value.split('|'); rules.push({ from, site, to }); }
  prj.project.rules = rules;
  if (await saveProject('Karar kaydedildi.')) loadMatch();
}
$('#prjSections').addEventListener('click', (e) => {
  const u = e.target.closest('[data-use]');
  if (u) { setSection(u.dataset.useFrom, u.dataset.use); return; }
  const b = e.target.closest('[data-open]');
  if (!b) return;
  const from = b.dataset.open;
  if (prj.openSecs.has(from)) prj.openSecs.delete(from); else prj.openSecs.add(from);
  renderSections();
  document.querySelector(`[data-open="${CSS.escape(from)}"]`)?.focus();
});
$('#prjSections').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-from]');
  if (!sel || sel.value === 'decide') return;
  setSection(sel.dataset.from, sel.value);
});

// v0.6.1 kept path rules in the browser per old host. Offer them to the project once.
function renderLsImport() {
  const old = prj.project.sites.find((s) => s.role === 'old');
  const host = siteHost(old);
  let list = [];
  try { list = JSON.parse(localStorage.getItem(`seo-audit:kurallar:${bare(host)}`) || '[]'); } catch {}
  if (!host || prj.project.rules.length || !Array.isArray(list) || !list.length) { $('#lsImport').innerHTML = ''; return; }
  $('#lsImport').innerHTML = `<div class="suggest"><div class="suggest-h"><b>Önceki sürümden ${list.length} kural var</b><span class="small">Bu tarayıcı ${esc(host)} için kural sakladı.</span>
    <button type="button" class="ghost small" id="lsImportBtn">Projeye aktar</button></div></div>`;
  $('#lsImportBtn').onclick = async () => {
    const keyOf = (h) => (!h ? 'heir' : prj.project.sites.find((s) => s.role !== 'old' && bare(siteHost(s)) === bare(h))?.key);
    const out = [], skipped = [];
    for (const r of list) {
      if (r.drop) out.push({ from: r.from, drop: true });
      else if (keyOf(r.host)) out.push({ from: r.from, site: keyOf(r.host), to: r.to || '/*' });
      else skipped.push(r.from);
    }
    prj.project.rules = out;
    if (await saveProject(skipped.length ? `${out.length} kural aktarıldı. ${skipped.join(', ')}: hedef site projede yok.` : `${out.length} kural aktarıldı.`)) {
      try { localStorage.removeItem(`seo-audit:kurallar:${bare(host)}`); } catch {}
      loadMatch();
    }
  };
}

// Free rule editor (v0.6.1), now inside the project. Rules point to a site of the project, not to a host.
function ruleSiteOptions(cur) {
  return prj.project.sites.filter((s) => s.role !== 'old').map((s) => `<option value="${esc(s.key)}"${s.key === cur ? ' selected' : ''}>${esc(siteName(s, true))}</option>`).join('')
    + `<option value="__drop"${cur === '__drop' ? ' selected' : ''}>Bölüm kaldırıldı</option>`;
}
function renderRuleEditor() {
  const stats = new Map((prj.match?.rules || []).map((r) => [r.from, r]));
  $('#cmpRules').innerHTML = prj.project.rules.map((r, i) => {
    const st = stats.get(r.from);
    return `<div class="rule${r.drop ? ' drop' : ''}">
      <label><span class="sr">Kural ${i + 1}: eski yol</span><input name="from" value="${esc(r.from)}" placeholder="/tr/*" spellcheck="false" autocomplete="off"></label>
      <span class="cmp-arrow" aria-hidden="true">→</span>
      <label><span class="sr">Kural ${i + 1}: hedef site</span><select name="site">${ruleSiteOptions(r.drop ? '__drop' : r.site)}</select></label>
      <label><span class="sr">Kural ${i + 1}: yeni yol</span><input name="to" value="${esc(r.drop ? '' : r.to || '/*')}" placeholder="/*" spellcheck="false" autocomplete="off"${r.drop ? ' disabled' : ''}></label>
      <button type="button" class="ghost small" data-del-rule="${i}" aria-label="Kural ${i + 1} sil">Sil</button>
      ${st ? `<span class="small rule-st">${st.pages} sayfa · ${st.found} bulundu</span>` : ''}
    </div>`;
  }).join('') || '<p class="small">Serbest kural yok. Bölüm kararları yukarıdaki tabloda.</p>';
}
function readRules() {
  return [...$('#cmpRules').querySelectorAll('.rule')].map((row) => {
    const from = row.querySelector('[name=from]').value.trim();
    const site = row.querySelector('[name=site]').value;
    const to = row.querySelector('[name=to]').value.trim();
    return site === '__drop' ? { from, drop: true } : { from, site, to: to || '/*' };
  });
}
$('#cmpRules').addEventListener('change', (e) => { if (e.target.name === 'site') { prj.project.rules = readRules(); renderRuleEditor(); } });
$('#cmpRules').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-rule]');
  if (!b) return;
  prj.project.rules = readRules();
  prj.project.rules.splice(+b.dataset.delRule, 1);
  renderRuleEditor();
});
$('#cmpAddRule').addEventListener('click', () => {
  prj.project.rules = [...readRules(), { from: '', site: 'heir', to: '/*' }];
  renderRuleEditor();
  $('#cmpRules').querySelector('.rule:last-child [name=from]').focus();
});
$('#ruleSave').addEventListener('click', async () => {
  prj.project.rules = readRules().filter((r) => r.from);
  const ok = await saveProject('Kurallar kaydedildi.');
  if (ok) loadMatch(); else $('#matchErr').textContent = $('#prjSaved').textContent;
});

// ---------- Step 4: 301 haritası (v0.8.0) ----------
// Every old page that needs a new address: suggestion (pending), no suggestion (none), approved or 410, rule.
// Only decisions are saved (POST /map). Suggestions come again with every match.
const MAP_TABS = [['pending', 'Onay bekliyor'], ['none', 'Öneri yok'], ['approved', 'Onaylandı'], ['rule', 'Kuraldan']];
const CONF = { high: ['Yüksek', 'ok'], mid: ['Orta', 'warn'], low: ['Düşük', 'warn low'] };
const mapTabOf = (r) => (r.status === 'gone' ? 'approved' : r.status);
const mapRowByPath = (p) => prj.match?.map?.rows.find((r) => r.path === p);
// Address of a target, short: site name + path (the full live URL is in the title).
function mapTarget(t) {
  if (!t) return '';
  if (!t.site) return esc(t.url);
  const s = siteByKey(t.site);
  return `<span class="small">${esc(siteName(s, true))}</span> <code>${esc(t.path)}</code>`;
}
// Value of the select: a candidate (site|path), __other (written address), __410, or '' (nothing chosen).
const candVal = (c) => `${c.site}|${c.path}`;
function mapChoice(r) {
  return prj.mapChoice[r.path] ?? (r.candidates?.length ? candVal(r.candidates[0]) : '');
}
// A written address: a path (/a/b) goes to the site of the best suggestion (else the heir). A full address
// goes to the project site with that host (crawl host or live host), else it stays a plain URL.
function manualDecision(v, r) {
  v = String(v || '').trim();
  if (!v) return { error: 'Adres yazın. Örnek: /hizmetler/web veya https://www.ornek.com/hizmetler/web' };
  if (v.startsWith('/')) return { site: r.candidates?.[0]?.site || 'heir', path: v, src: 'elle' };
  let u;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { return { error: 'Adres okunamadı. Tam adres veya / ile başlayan yol yazın.' }; }
  const h = bare(u.hostname);
  const old = prj.project.sites.find((s) => s.role === 'old');
  const site = prj.project.sites.find((s) => s.role !== 'old' && (bare(siteHost(s)) === h || (s.live && bare(s.live) === h)))
    || (bare(siteHost(old)) === h ? siteByKey('heir') : null);
  return site ? { site: site.key, path: u.pathname + u.search, src: 'elle' } : { url: u.href, src: 'elle' };
}
async function saveMap(set, msg) {
  prj.mapSaving = true;
  renderMap();
  try {
    await api(`/api/projects/${prj.id}/map`, { method: 'POST', body: JSON.stringify({ set }) });
    for (const k of Object.keys(set)) { delete prj.mapChoice[k]; delete prj.mapManual[k]; }
    prj.mapMsg = msg || '';
    prj.matchKey = '';
    await loadMatch();
  } catch (e) { $('#mapErr').textContent = e.message; }
  finally { prj.mapSaving = false; renderMap(); }
}
function approveHigh() {
  const rows = (prj.match?.map?.rows || []).filter((r) => r.status === 'pending' && r.conf === 'high');
  if (!rows.length) return;
  const set = {};
  for (const r of rows) set[r.path] = { site: r.target.site, path: r.target.path, src: 'oneri' };
  if (prj.step !== 'harita') goStep('harita');
  saveMap(set, `${rows.length} öneri onaylandı.`);
}
function renderMap() {
  const m = prj.match?.map;
  $('#mapBusy').hidden = !(prj.loading && !m);
  $('#mapErr').textContent = !prj.loading && prj.matchErr ? prj.matchErr : '';
  $('#mapBox').hidden = !m;
  if (!m) { $('#mapTiles').innerHTML = ''; $('#mapWarn').innerHTML = ''; return; }
  const s = m.summary;
  const noLive = (m.noLive || []).map((k) => siteName(siteByKey(k), true));
  $('#mapWarn').innerHTML = [
    noLive.length ? `${noLive.join(', ')} için canlı alan adı yok. Listede bu sitenin tarama adresi yazar. Canlı alan adını Proje adımında yazın.` : '',
    s.stale ? `${s.stale} karar artık gerekli değil: eski sayfa taramada yok veya yeni sitede bulundu. Bu kararlar listeye girmez.` : '',
  ].filter(Boolean).map((w) => `<p class="warn">${esc(w)}</p>`).join('') + (prj.mapMsg ? `<p class="small map-msg" role="status">${esc(prj.mapMsg)}</p>` : '');
  const tiles = [[s.total, '301 gerekli', ''], [s.rule, 'Bölüm kuralından (hazır)', ''], [s.approved + s.gone, 'Onaylandı', 'ok'], [s.pending, 'Onay bekliyor', 'warn'], [s.none, 'Öneri yok', 'warn']];
  $('#mapTiles').innerHTML = tiles.map(([n, label, cls]) => `<div class="map-tile ${n && cls ? cls : ''}"><b>${n}</b><span>${esc(label)}</span></div>`).join('');
  const counts = { pending: s.pending, none: s.none, approved: s.approved + s.gone, rule: s.rule };
  if (!prj.mapTab || (!counts[prj.mapTab] && prj.mapTab !== 'approved')) prj.mapTab = MAP_TABS.find(([k]) => counts[k])?.[0] || 'approved';
  $('#mapTabs').innerHTML = MAP_TABS.map(([k, label]) => `<button type="button" role="tab" data-mtab="${k}" aria-selected="${prj.mapTab === k}">${esc(label)} · ${counts[k]}</button>`).join('');
  const list = m.rows.filter((r) => mapTabOf(r) === prj.mapTab);
  const shown = list.slice(0, prj.mapShow);
  $('#mapRows').innerHTML = (shown.map(mapRowHtml).join('') || '<p class="map-empty">Bu listede satır yok.</p>')
    + (list.length > shown.length ? `<div class="map-more"><button type="button" class="ghost small" data-mmore>Daha fazla göster (${list.length - shown.length})</button></div>` : '');
  $('#mapCsv').href = `/api/projects/${prj.id}/map?format=csv`;
  $('#mapExcel').href = `/api/projects/${prj.id}/excel`;
  for (const b of document.querySelectorAll('#mapRows button')) b.disabled = prj.mapSaving;
}
function mapRowHtml(r) {
  const p = esc(r.path);
  const head = `<div class="mrow-old"><code>${p}</code>${r.oldTitle ? `<span class="small">Eski title: ${esc(r.oldTitle)}</span>` : ''}</div><span class="cmp-arrow" aria-hidden="true">→</span>`;
  if (r.status === 'rule') {
    return `<div class="mrow" data-mpath="${p}">${head}<div class="mrow-to"><span title="${esc(r.target.url)}">${mapTarget(r.target)}</span>
      <span class="small">${esc(r.why)} · ${r.installed ? '301 kurulu' : '301 henüz kurulmadı'}</span></div>
      <div class="mrow-act"><span class="tag-s idle">Kural</span></div></div>`;
  }
  if (r.status === 'approved' || r.status === 'gone') {
    const to = r.status === 'gone' ? '<span>410 · sayfa kalıcı olarak kaldırıldı</span>' : `<span title="${esc(r.target.url)}">${mapTarget(r.target)}</span>`;
    return `<div class="mrow" data-mpath="${p}">${head}<div class="mrow-to">${to}
      <span class="small">${r.status === 'gone' ? 'Siz 410 seçtiniz. Sunucu bu adres için 410 verir.' : r.decision?.src === 'elle' ? 'Adresi siz yazdınız.' : 'Öneriyi onayladınız.'}</span>${r.warn ? `<span class="small warn-t">${esc(r.warn)}</span>` : ''}</div>
      <div class="mrow-act"><span class="tag-s ${r.warn ? 'warn' : 'ok'}">${r.status === 'gone' ? '410' : 'Onaylandı'}</span><button type="button" class="linkbtn" data-mundo="${p}">Geri al</button></div></div>`;
  }
  const ch = mapChoice(r);
  const cands = r.candidates || [];
  const opts = (r.status === 'none' || !cands.length ? `<option value=""${ch === '' ? ' selected' : ''}>Yeni adres seçin…</option>` : '')
    + cands.map((c) => `<option value="${esc(candVal(c))}"${ch === candVal(c) ? ' selected' : ''}>${esc(siteName(siteByKey(c.site), true))} · ${esc(c.path)} · puan ${c.score}</option>`).join('')
    + `<option value="__other"${ch === '__other' ? ' selected' : ''}>Başka adres yazın…</option><option value="__410"${ch === '__410' ? ' selected' : ''}>410 ver (sayfa kalıcı olarak kaldırıldı)</option>`;
  const pick = cands.find((c) => candVal(c) === ch);
  const why = pick ? pick.why : ch === '__410' ? 'Sayfa yeni sitede olmayacak ve yakın bir karşılığı yok. Sunucu 410 verir.' : ch === '__other' ? 'Yol (/ornek) veya tam adres yazın. Yol yazarsanız araç önerilen siteyi kullanır.' : r.why;
  const conf = r.status === 'pending' && pick ? CONF[pick.conf] : null;
  const manual = ch === '__other' ? `<label class="mrow-manual"><span class="sr">${p} için yeni adres</span><input name="manual" value="${esc(prj.mapManual[r.path] || '')}" placeholder="/yeni-yol veya https://…" spellcheck="false" autocomplete="off"></label>` : '';
  return `<div class="mrow" data-mpath="${p}">${head}<div class="mrow-to">
      <label><span class="sr">${p} için yeni adres</span><select data-mchoice="${p}">${opts}</select></label>${manual}
      <span class="small">${esc(why || '')}</span><span class="small warn-t" data-merr></span></div>
    <div class="mrow-act">${conf ? `<span class="tag-s ${conf[1]}">${conf[0]}</span>` : r.status === 'none' ? '<span class="tag-s warn">Öneri yok</span>' : ''}
      <button type="button" class="ghost small strong" data-mok="${p}"${ch === '' ? ' disabled' : ''}>Onayla</button></div></div>`;
}
$('#mapTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mtab]');
  if (!b) return;
  prj.mapTab = b.dataset.mtab; prj.mapShow = 100; prj.mapMsg = '';
  renderMap();
});
$('#mapRows').addEventListener('change', (e) => {
  const sel = e.target.closest('[data-mchoice]');
  if (sel) { prj.mapChoice[sel.dataset.mchoice] = sel.value; renderMap(); if (sel.value === '__other') document.querySelector(`[data-mpath="${CSS.escape(sel.dataset.mchoice)}"] [name=manual]`)?.focus(); }
});
$('#mapRows').addEventListener('input', (e) => {
  if (e.target.name === 'manual') prj.mapManual[e.target.closest('[data-mpath]').dataset.mpath] = e.target.value;
});
$('#mapRows').addEventListener('click', (e) => {
  if (e.target.closest('[data-mmore]')) { prj.mapShow += 100; renderMap(); return; }
  const undo = e.target.closest('[data-mundo]');
  if (undo) { saveMap({ [undo.dataset.mundo]: null }, 'Karar geri alındı.'); return; }
  const ok = e.target.closest('[data-mok]');
  if (!ok) return;
  const r = mapRowByPath(ok.dataset.mok);
  if (!r) return;
  const ch = mapChoice(r);
  let d;
  if (ch === '__410') d = { gone: true, src: 'elle' };
  else if (ch === '__other') {
    d = manualDecision(prj.mapManual[r.path], r);
    if (d.error) { ok.closest('.mrow').querySelector('[data-merr]').textContent = d.error; return; }
  } else {
    const c = r.candidates.find((x) => candVal(x) === ch);
    if (!c) return;
    d = { site: c.site, path: c.path, src: 'oneri' };
  }
  saveMap({ [r.path]: d }, '');
});

// ---------- Step 5: Yapılacaklar (v0.9.0): work list by place ----------
// One card per place: the old domain's server, each new site, content, decisions. Every term has a "?" text.
// All help texts live here, so the same term has the same text on every screen.
const TERMS = {
  server: 'Canlıdan sonra eski alan adını kullanan sunucu. Eski adreslerin bütün 301 ve 410 yanıtları burada kurulur. Ayrı alan adına taşınan sayfaların 301\'i de buradadır.',
  heir: HELP.heir,
  extra: HELP.extra,
  content: 'Eski sayfada olan title, meta açıklama veya H1 yeni sayfada boş. Ya da yeni sayfaya noindex eklendi. Sayfa sıralama kaybedebilir.',
  decide: 'Bu işler sizin kararınızı bekler. Karar verince iş doğru yere gider: 301 listesine veya bir sitenin listesine.',
  notReady: 'Bu sitede, ona giden eski sayfalardan çok daha az sayfa var. İçerik girişi bitmemiş olabilir. Bu yüzden sitenin işleri şimdilik sayılmaz. Site gerçekten bu kadar küçükse uyarıyı kapatın.',
  '301': 'Kalıcı yönlendirme. Eski adres yeni adrese gider. Google sıralamayı yeni adrese taşır. Liste "301 listesini indir" ile CSV olarak iner.',
  fix: 'Yönlendirme var ama doğru değil. Zincir: eski adres birden çok adımda gider, tek adım yapın. 302: geçici yönlendirmedir, 301 kullanın.',
  '410': 'Sayfa kalıcı olarak kaldırıldı. Google sayfayı dizinden 404\'ten daha hızlı çıkarır. Karşılığı olmayan sayfa için kullanın.',
  create: 'Eski sayfanın hedef sayfası yeni sitede yok. Sayfayı oluşturun veya 301 haritasında başka sayfa seçin.',
  link: 'Sayfa açılıyor ama menüde veya içerikte linki yok. Kullanıcı ve Google sayfayı zor bulur.',
  map: 'Eski sayfa için yeni adres gerekli. Araç öneri buldu ve onay bekliyor, veya öneri bulamadı. Kararı 301 haritasında verin.',
  section: 'Bölümün kararı sayfaların diline veya bulunan sayfa sayısına uymuyor. Eşleştirme ekranında önerilen seçimi kullanın.',
  unknown: 'Araç adresi kontrol edemedi. Neden: staging şifresi, robots.txt engeli veya bağlantı hatası. Satırda çözüm yazılı.',
  held: 'Site hazır olmadığı için bu işler sayılmaz. Site hazır olunca tekrar tarayın.',
  liveUrl: 'Canlıya çıkıştan sonraki adres. 301 her zaman bu adrese gider. Canlı adresi staging adresine asla yönlendirmeyin.',
  checkUrl: 'Aracın kontrol ettiği adres (genelde staging). Sayfayı açıp görmek içindir. 301 hedefi değildir.',
  noLive: 'Bu sitenin canlı alan adı projede yok. Proje adımında "canlı alan adı" alanını doldurun.',
};
const todoState = { open: null };
const placeSite = (p) => (p.kind === 'site' ? siteByKey(p.site) : null);
function renderReady() {
  const t = prj.match?.todo;
  const thin = (t?.places || []).filter((p) => p.ready?.state === 'thin');
  $('#todoReady').innerHTML = thin.map((p) => `<div class="ready-warn" role="status">
    <div class="rw-h"><b>${esc(siteName(placeSite(p)) || p.title)} (${esc(p.title)}) hazır değil gibi görünüyor.</b> ${help(TERMS.notReady)}</div>
    <p class="small">Bu siteye ${p.ready.oldPages} eski sayfa gidiyor. Taramada ${p.ready.newPages} sayfa var. İçerik girişi bitince siteyi tekrar tarayın.</p>
    <div class="pact"><button type="button" class="ghost small strong" data-recrawl="${esc(p.site)}">Tekrar tara</button>
    <button type="button" class="ghost small" data-ready="${esc(p.site)}" data-ok="1">Site hazır, uyarıyı kapat</button></div></div>`).join('');
}
function renderPlaces() {
  const t = prj.match?.todo;
  if (!t) { $('#todoPlaces').innerHTML = ''; return; }
  const mp = prj.match.map?.summary;
  const csvRows = mp ? mp.rule + mp.approved + mp.gone : 0;
  $('#todoPlaces').innerHTML = t.places.map((p) => {
    const s = placeSite(p);
    const thin = p.ready?.state === 'thin';
    const role = p.kind === 'site' ? (p.role === 'heir' ? `${ROLE.heir} ${help(TERMS.heir)}` : `${esc(siteName(s) || p.name || 'Ek site')} ${help(TERMS.extra)}`) : '';
    const tip = { server: TERMS.server, content: TERMS.content, decide: TERMS.decide }[p.kind];
    const state = thin ? '<span class="tag-s idle">Hazır değil · ölçülmedi</span>'
      : p.n ? `<span class="tag-s warn">${p.n} iş</span>` : '<span class="tag-s ok">Sorun yok</span>';
    const lines = thin
      ? `<li class="dim"><span>Bekleyen iş ${help(TERMS.held)}</span><b>${p.held}</b></li>`
      : p.tasks.map((x) => `<li><span>${esc(x.label)} ${TERMS[x.kind] ? help(TERMS[x.kind]) : ''}</span><b>${x.n}</b></li>`).join('');
    const listN = thin ? p.held : p.n;
    const btns = [
      listN ? `<button type="button" class="ghost small" data-open="${esc(p.key)}" aria-expanded="${todoState.open === p.key}">${todoState.open === p.key ? 'Listeyi kapat' : 'Listeyi aç'}</button>` : '',
      p.kind === 'server' && csvRows ? '<a class="ghost small" href="/api/projects/' + esc(prj.id) + '/map?format=csv">301 listesini indir (CSV)</a>' : '',
      p.kind === 'decide' && p.tasks.some((x) => x.kind === 'map') ? '<button type="button" class="ghost small" data-goto="harita">Haritaya git</button>' : '',
      p.kind === 'decide' && p.tasks.some((x) => x.kind === 'section') ? '<button type="button" class="ghost small" data-goto="eslestirme">Eşleştirmeye git</button>' : '',
      p.ready?.state === 'accepted' ? `<button type="button" class="ghost small" data-ready="${esc(p.site)}" data-ok="0">Hazırlık uyarısını geri aç</button>` : '',
    ].filter(Boolean).join('');
    return `<section class="place${thin ? ' thin' : ''}" data-place="${esc(p.key)}">
      <header><span class="ptitle"><b>${esc(p.title)}</b>${tip ? help(tip) : ''}</span>${role ? `<span class="small role">${role}</span>` : ''}
        <span class="tag-s idle team">${esc(p.team)}</span>${state}</header>
      ${p.ready?.state === 'accepted' ? '<p class="small note">Bu tarama hazır sayıldı.</p>' : ''}
      ${lines ? `<ul class="ptasks">${lines}</ul>` : ''}
      ${btns ? `<div class="pact">${btns}</div>` : ''}
      ${todoState.open === p.key ? placeList(p, t) : ''}</section>`;
  }).join('');
}
function placeList(p, t) {
  const thin = p.ready?.state === 'thin';
  const list = t.items.filter((i) => (thin ? i.held && i.site === p.site : i.placeKey === p.key && !i.held));
  const max = t.listLimit || 200;
  const shown = list.slice(0, max);
  const head = list.length > max ? `<p class="small">${list.length} iş var. İlk ${max} satır görünüyor. Bütün liste Excel'de.</p>` : '';
  // v0.9.1: the live address and the checked (staging) address are separate columns. A 301 goes to the live address only.
  const live = (i) => (i.liveUrl ? `<span class="u-live">${esc(i.liveUrl)}</span>` : i.checkUrl ? `<span class="small">Canlı alan adı yok ${help(TERMS.noLive)}</span>` : '<span class="small">—</span>');
  return `<div class="plist">${head}<div class="table-wrap"><table><thead><tr><th>İş</th><th>Eski adres</th><th>Canlı adres ${help(TERMS.liveUrl)}</th><th>Kontrol edilen adres ${help(TERMS.checkUrl)}</th><th>Not</th></tr></thead><tbody>${
    shown.map((i) => `<tr><td>${esc(i.label)}</td><td class="u">${cmpLink(i.oldUrl, i.path)}</td><td class="u">${live(i)}</td><td class="u">${i.checkUrl ? cmpLink(i.checkUrl) : '<span class="small">—</span>'}</td><td>${esc(i.note)}</td></tr>`).join('')
  }</tbody></table></div></div>`;
}
$('#todoPlaces').addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) { todoState.open = todoState.open === o.dataset.open ? null : o.dataset.open; renderPlaces(); return; }
  const g = e.target.closest('[data-goto]');
  if (g) { goStep(g.dataset.goto); return; }
  const r = e.target.closest('[data-ready]');
  if (r) setReady(r.dataset.ready, r.dataset.ok === '1', r);
});
$('#todoReady').addEventListener('click', (e) => {
  const c = e.target.closest('[data-recrawl]');
  if (c) { c.disabled = true; goStep('tarama'); startSiteCrawl(c.dataset.recrawl); return; }
  const r = e.target.closest('[data-ready]');
  if (r) setReady(r.dataset.ready, r.dataset.ok === '1', r);
});
async function setReady(site, ok, btn) {
  btn.disabled = true;
  try {
    await api(`/api/projects/${prj.id}/ready`, { method: 'POST', body: JSON.stringify({ site, ok }) });
    Object.assign(prj, await api(`/api/projects/${prj.id}`));
    prj.matchKey = '';
    await loadMatch();
  } catch (err) { $('#todoErr').textContent = err.message; btn.disabled = false; }
}

// ---------- Step 6: Canlıya çıkış (v0.10.0): launch list from the staging crawls ----------
// Groups by time, not by place. Every row shows its site and team. The state always comes from the crawls:
// there is no manual "done" mark. Fix, then crawl again.
const LN_TERMS = {
  critical: 'Bu işler canlıya çıkıştan önce düzelmeli. Yoksa canlı sitede sayfalar kırılır veya Google yanlış adresi görür.',
  decide: 'Bu satırlar sizin kararınızı bekler. Karar yoksa eski adres canlıda 404 verir.',
  switch: 'Bu ayarlar staging\'de doğrudur. Canlıya çıkış anında değiştirin. Canlı doğrulama adımı canlıda tekrar kontrol eder.',
  check: 'Eski sitede olan etiketler yeni sitede de olmalı. Yoksa ölçüm veya Search Console doğrulaması kaybolur.',
  'map-staging': '301 hedefi her zaman canlı alan adıdır. Staging adresine giden 301 canlıda çalışmaz.',
  'staging-open': 'Staging şifresiz ve noindex yok. robots.txt de engellemiyor. Google staging sayfalarını dizine ekleyebilir ve kopya içerik görür.',
  'staging-addr': 'Staging alan adı sayfalarda açık yazılmış. Göreli adres (/hakkimizda) her alan adında çalışır. Açık yazılmış staging adresi canlıdan sonra kırılır.',
  'map-pending': 'Araç öneri buldu ve onay bekliyor, veya öneri bulamadı. Kararı 301 haritasında verin.',
  noindex: 'Sayfa Google\'a "dizine ekleme" der. Staging için doğrudur. Canlıda kalırsa site Google\'dan düşer.',
  disallow: 'robots.txt Googlebot\'u bütün siteden engeller. Staging için doğrudur. Canlıda kalırsa Google siteyi tarayamaz.',
  tracking: 'Google Analytics, Google Ads veya Tag Manager kimliği. Eski sitedeki kimlik yeni sitede yoksa ölçüm durur.',
  gsc: 'google-site-verification meta etiketi. Search Console mülkünü doğrular. Etiket kalkarsa doğrulama düşer. DNS ile doğrulanan mülkte etiket gerekmez.',
  recrawl: 'Bu tarama v0.10.0\'dan önce yapıldı. Yeni kontrollerin verisi yok. Siteyi tekrar tarayın.',
};
const LN_DETAIL = { canonical: 'canonical', hreflang: 'hreflang', sitemap: 'sitemap URL', link: 'link', asset: 'görsel, script, CSS', robots: 'robots.txt Sitemap' };
const lnState = { open: null };
const lnKey = (it) => `${it.kind}:${it.site || ''}`;
const lnSiteName = (k) => (k === 'old' ? 'Eski site' : siteByKey(k) ? siteName(siteByKey(k)) : '');
function launchTask(L) {
  const all = L.groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.key })));
  const btnOf = (it) => (it.action?.type === 'project' ? { btn: 'Projeyi açın', act: { step: 'proje', focus: it.action.site, focusField: 'live' } }
    : it.action?.type === 'map' ? { btn: 'Haritayı açın', act: { step: 'harita' } }
    : it.action?.type === 'recrawl' ? { btn: 'Tekrar tara', act: { crawl: it.action.site } }
    : { btn: 'Listeyi açın', act: { open: lnKey(it) } });
  const crit = all.filter((i) => i.group === 'critical');
  if (crit.length) return { text: `${crit.length} kritik iş var. Önce: ${crit[0].title}${crit[0].site ? ` (${lnSiteName(crit[0].site)})` : ''}.`, ...btnOf(crit[0]) };
  const dec = all.find((i) => i.group === 'decide');
  if (dec) return { text: `Kritik iş yok. ${dec.n} satır 301 haritasında karar bekliyor.`, ...btnOf(dec) };
  const chk = all.filter((i) => i.group === 'check' && !i.info);
  if (chk.length) return { text: `Kritik iş yok. ${chk.length} kontrol var: ${chk[0].title}.`, ...btnOf(chk[0]) };
  const sw = all.filter((i) => i.group === 'switch');
  if (sw.length) return { text: `Kritik iş yok. Çıkış anında ${sw.length} ayarı değiştirin. Excel listeyi ekip ile verir.`, btn: 'Excel indir', act: { excel: true } };
  return { text: 'Liste temiz. Staging canlıya çıkışa hazır görünüyor.', btn: 'Excel indir', act: { excel: true } };
}
function renderLaunch() {
  $('#lnBusy').hidden = !prj.loading;
  $('#lnErr').textContent = !prj.loading && prj.matchErr ? prj.matchErr : '';
  const L = prj.match?.launch;
  $('#lnExcel').href = `/api/projects/${prj.id}/excel`;
  if (!L) { $('#lnSum').innerHTML = ''; $('#lnGroups').innerHTML = ''; $('#lnLive').innerHTML = ''; return; }
  const SUM = [['critical', 'Kritik', 'crit'], ['decide', 'Karar bekleyen', 'warn'], ['switch', 'Çıkışta değiştirin', 'warn'], ['check', 'Kontrol edin', '']];
  $('#lnSum').innerHTML = SUM.map(([k, label, cls]) => `<div class="ln-tile ${L.counts[k] ? cls : 'zero'}"><span>${label}</span><b>${L.counts[k]}</b></div>`).join('');
  const live = L.sites.filter((x) => !x.staging);
  $('#lnLive').innerHTML = live.map((x) => `<p class="small note">${esc(lnSiteName(x.key))} (${esc(x.host)}) canlı alan adında tarandı. Staging kontrolleri bu site için çalışmaz. Canlı kontrolü sonraki adımdadır.</p>`).join('');
  $('#lnGroups').innerHTML = L.groups.map((g) => {
    const n = L.counts[g.key];
    const state = n ? `<span class="tag-s ${g.key === 'critical' ? 'run' : 'warn'}">${n} iş</span>` : '<span class="tag-s ok">Sorun yok</span>';
    return `<section class="place ln-group ln-${g.key}">
      <header><span class="ptitle"><b>${esc(g.title)}</b>${help(LN_TERMS[g.key])}</span>${g.sub ? `<span class="small role">${esc(g.sub)}</span>` : ''}${state}</header>
      ${g.items.map(launchRow).join('')}</section>`;
  }).join('');
}
function launchRow(it) {
  const k = lnKey(it);
  const tagCls = it.info ? 'idle' : it.group === 'critical' ? 'run' : 'warn';
  const count = it.info ? 'Bilgi' : it.unit === 'eksik' ? 'Eksik' : it.unit === 'bütün site' ? 'Bütün site' : it.n ? `${it.n}${it.unit ? ` ${it.unit}` : ''}` : '';
  const detail = it.kind === 'staging-addr' && it.detail ? Object.entries(it.detail).map(([x, n]) => `${LN_DETAIL[x] || x} ${n}`).join(' · ')
    : it.kind === 'noindex' && it.detail ? [it.detail.meta && `meta robots ${it.detail.meta}`, it.detail.header && `X-Robots-Tag ${it.detail.header}`].filter(Boolean).join(' · ') + ' sayfa' : '';
  const site = it.site ? lnSiteName(it.site) : '';
  const btns = [
    it.list.length && !['tracking', 'gsc'].includes(it.kind) ? `<button type="button" class="ghost small" data-lnopen="${esc(k)}" aria-expanded="${lnState.open === k}">${lnState.open === k ? 'Listeyi kapat' : 'Listeyi aç'}</button>` : '',
    it.action?.type === 'map' ? '<button type="button" class="ghost small" data-goto="harita">Haritayı açın</button>' : '',
    it.action?.type === 'project' ? `<button type="button" class="ghost small" data-lnproject="${esc(it.action.site)}">Projeyi açın</button>` : '',
    it.action?.type === 'recrawl' ? `<button type="button" class="ghost small strong" data-recrawl="${esc(it.action.site)}">Tekrar tara</button>` : '',
  ].filter(Boolean).join('');
  return `<div class="ln-row${it.info ? ' info' : ''}" data-ln="${esc(k)}">
    <div class="ln-main"><b>${esc(it.title)}</b> ${LN_TERMS[it.kind] ? help(LN_TERMS[it.kind]) : ''}
      <div class="ln-tags">${site ? `<span class="tag-s idle">${esc(site)}</span>` : ''}${it.team ? `<span class="tag-s idle team">${esc(it.team)}</span>` : ''}</div>
      ${detail ? `<div class="small ln-detail">${esc(detail)}</div>` : ''}
      <p class="small ln-note">${esc(it.note)}</p></div>
    <div class="ln-side">${count ? `<span class="tag-s ${tagCls}">${esc(count)}</span>` : ''}</div>
    ${btns ? `<div class="pact">${btns}</div>` : ''}
    ${lnState.open === k ? launchList(it) : ''}</div>`;
}
function launchList(it) {
  const max = prj.match.launch.listLimit || 200;
  const shown = it.list.slice(0, max);
  const head = it.list.length > max ? `<p class="small">${it.list.length} satır var. İlk ${max} satır görünüyor. Bütün liste Excel'de.</p>` : '';
  const addr = (u) => (/^https?:\/\/\S+$/.test(u || '') ? cmpLink(u) : esc(u || '—'));
  return `<div class="plist">${head}<div class="table-wrap"><table><thead><tr><th>Tür</th><th>Adres</th><th>Değer</th></tr></thead><tbody>${
    shown.map((x) => `<tr><td>${esc(x.what)}</td><td class="u">${addr(x.page)}</td><td class="u">${addr(x.value)}</td></tr>`).join('')
  }</tbody></table></div></div>`;
}
$('#lnGroups').addEventListener('click', (e) => {
  const o = e.target.closest('[data-lnopen]');
  if (o) { lnState.open = lnState.open === o.dataset.lnopen ? null : o.dataset.lnopen; renderLaunch(); return; }
  const g = e.target.closest('[data-goto]');
  if (g) { goStep(g.dataset.goto); return; }
  const p = e.target.closest('[data-lnproject]');
  if (p) { const k = p.dataset.lnproject; goStep('proje'); setTimeout(() => document.querySelector(`[data-site="${CSS.escape(k)}"] [name=live]`)?.focus(), 80); return; }
  const c = e.target.closest('[data-recrawl]');
  if (c) { c.disabled = true; goStep('tarama'); startSiteCrawl(c.dataset.recrawl); }
});

// ---------- All pages view (groups of the comparison) ----------
const CMP_KINDS = [
  { k: 'same', label: 'Aynı kaldı', cls: 'ok' },
  { k: 'changed', label: 'İçerik değişti', cls: 'warning' },
  { k: 'moved', label: 'Hedef hazır, 301 kurulu', cls: 'ok2' },
  { k: 'no301', label: 'Hedef hazır, 301 eksik', cls: 'critical' },
  { k: 'notarget', label: 'Hedef yok', cls: 'critical' },
  { k: 'redirected', label: 'Yönleniyor', cls: 'redirect' },
  { k: 'lost', label: 'Kayboldu', cls: 'critical' },
  { k: 'removed', label: 'Bölüm kaldırıldı', cls: 'removed' },
  { k: 'unlinked', label: 'Açılıyor, link yok', cls: 'notice' },
  { k: 'unknown', label: 'Kontrol edilemedi', cls: 'notice' },
  { k: 'added', label: 'Yeni sayfa', cls: 'new' },
];
const OPTIONAL_KINDS = ['removed', 'unknown', 'unlinked', 'moved', 'no301', 'notarget'];
const cmpState = { tab: 'lost', q: '' };
function renderTodo() {
  $('#todoBusy').hidden = !prj.loading;
  $('#todoErr').textContent = !prj.loading && prj.matchErr ? prj.matchErr : '';
  const d = prj.match;
  $('#cmpResult').hidden = !d;
  renderReady();
  renderPlaces();
  if (!d) return;
  const s = d.summary;
  if (!cmpState.data || cmpState.data !== d) {
    cmpState.data = d;
    cmpState.tab = ['no301', 'notarget', 'lost'].find((k) => s[k]) || (s.contentLost ? (s.changed ? 'changed' : 'moved') : s.redirectFix ? 'redirected' : s.moveFix ? 'moved' : s.unknown ? 'unknown' : 'added');
    cmpState.q = ''; $('#cmpQ').value = '';
  }
  $('#cmpExcel').href = `/api/projects/${prj.id}/excel`;
  $('#cmpKept').textContent = `%${s.kept}`;
  $('#cmpKeptText').textContent = `Eski sitenin ${s.oldPages} sayfasından ${s.same + s.changed + s.moved} tanesi yerinde: aynı yolda açılıyor veya hedefe 301 ile gidiyor.`;
  $('#cmpWarn').innerHTML = d.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('');
  const parts = CMP_KINDS.filter((x) => x.k !== 'added').map((x) => ({ ...x, n: s[x.k] || 0 })).filter((x) => x.n);
  $('#cmpBar').innerHTML = parts.map((x) => `<i class="${x.cls}" style="flex-grow:${x.n}" title="${x.label}: ${x.n}"></i>`).join('');
  $('#cmpBar').setAttribute('aria-label', parts.map((x) => `${x.label}: ${x.n}`).join(', '));
  const sub = {
    changed: s.contentLost ? `${s.contentLost} sayfada kayıp` : 'kayıp yok',
    redirected: s.redirectFix ? `${s.redirectFix} düzeltme gerekli` : 'hedefler doğru',
    moved: s.moveFix ? `${s.moveFix} düzeltme gerekli` : '',
    lost: s.lost ? '301 gerekli' : '', removed: '301 veya 410 gerekli', no301: '301 kurun', notarget: 'sayfa gerekli',
  };
  $('#cmpTiles').innerHTML = CMP_KINDS.filter((x) => !OPTIONAL_KINDS.includes(x.k) || s[x.k]).map((x) => `<button type="button" class="${x.cls}" data-tab="${x.k}" aria-pressed="${cmpState.tab === x.k}">
    <b>${s[x.k]}</b><span>${x.label}</span>${sub[x.k] ? `<em>${sub[x.k]}</em>` : ''}</button>`).join('');
  renderCompareTable();
}
const cmpLink = (u, txt) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(txt ?? u)}</a>` : esc(txt));
// Explanation under every row: the checked URL, the rule and what to do.
function explain(r, { reason = true, cls = 'flag' } = {}) {
  const ctx = [r.checkUrl && `Kontrol edilen: ${cmpLink(r.checkUrl)}`, r.rule && `Kural: <code>${esc(r.rule)}</code>`].filter(Boolean).join(' · ');
  return `${reason && r.reason ? `<span class="${cls}">${esc(r.reason)}</span>` : ''}${ctx ? `<div class="why">${ctx}</div>` : ''}${r.todo ? `<div class="todo">${esc(r.todo)}</div>` : ''}`;
}
const redirectCell = (r) => (r.target ? `<span class="${r.todo && !r.lostCount ? 'st warnish' : 'st okish'}">${r.status}</span> → ${cmpLink(r.target)}${r.hops > 1 ? ` <span class="small">${r.hops} adım</span>` : ''}`
  : r.heirStatus ? `<span class="flag">Yönlenmiyor (${r.heirStatus})</span>` : '<span class="small">—</span>');
function renderCompareTable() {
  const { rows, summary: s, targets } = cmpState.data;
  const t = cmpState.tab, q = cmpState.q.toLowerCase();
  if (t === 'same') {
    $('#cmpTable').innerHTML = `<tbody><tr><td class="empty">${s.same} sayfa aynı yolda açılıyor. Title, meta description ve H1 aynı. Liste gerekmez.</td></tr></tbody>`;
    $('#cmpCount').textContent = ''; return;
  }
  let list = rows[t].filter((r) => !q || r.path.toLowerCase().includes(q) || (r.oldTitle || r.newTitle || '').toLowerCase().includes(q));
  const total = list.length;
  list = list.slice(0, 500);
  $('#cmpCount').textContent = `${total} sonuç${total > 500 ? ' · ilk 500 gösteriliyor, tamamı Excel\'de' : ''}`;
  const imp = (r) => `${r.indexable ? '' : '<span class="small">indexlenmez</span> '}<span class="small">${r.inlinks} iç link</span>`;
  const many = targets.length > 1;
  const moveH = ['Eski yol', 'Hedef', 'Eski adres → yönlendirme', 'Sonuç ve yapılacak'];
  const moveRow = (r) => [cmpLink(r.oldUrl, r.path), cmpLink(r.newUrl || r.checkUrl, r.newUrl || r.checkUrl), redirectCell(r), explain(r, { cls: t === 'moved' ? 'small' : 'flag' })];
  const H = {
    lost: ['Yol', 'Sonuç ve yapılacak', 'Eski title', 'Önem'],
    redirected: ['Yol', 'Hedef ve yapılacak', 'Status', 'Adım'],
    changed: ['Yol', 'Değişim'],
    removed: ['Yol', 'Sonuç ve yapılacak', 'Önem'],
    unknown: ['Yol', 'Neden ve yapılacak'],
    unlinked: ['Yol', 'Durum ve yapılacak'],
    moved: moveH, no301: moveH, notarget: moveH,
    added: [...(many ? ['Site'] : []), 'Yol', 'Title'],
  }[t];
  const row = {
    lost: (r) => [cmpLink(r.oldUrl, r.path), explain(r), esc(r.oldTitle), imp(r)],
    redirected: (r) => [cmpLink(r.oldUrl, r.path), `${cmpLink(r.target)}${explain(r, { reason: false })}`, `<span class="${r.targetBroken ? 'flag' : r.todo ? 'st warnish' : 'st okish'}">${r.status} → ${r.finalStatus || 'hata'}</span>`, r.hops],
    changed: (r) => [cmpLink(r.newUrl, r.path), r.changes.map((c) => `<div class="chg ${c.kind}"><div><b>${esc(c.label)}</b> · ${c.kind === 'lost' ? '<span class="flag">kayıp</span>' : '<span class="small">değişti</span>'}</div><span class="small">Eski: ${esc(c.old) || '—'}</span><span class="small">Yeni: ${esc(c.new) || '—'}</span></div>`).join('') + explain(r, { reason: false })],
    removed: (r) => [cmpLink(r.oldUrl, r.path), explain(r, { cls: 'small' }), imp(r)],
    unknown: (r) => [esc(r.path), explain(r, { cls: '' })],
    unlinked: (r) => [cmpLink(r.newUrl, r.path), explain(r, { cls: '' })],
    moved: moveRow, no301: moveRow, notarget: moveRow,
    added: (r) => [...(many ? [esc(r.site)] : []), cmpLink(r.newUrl, r.path), esc(r.newTitle)],
  }[t];
  $('#cmpTable').innerHTML = `<thead><tr>${H.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    list.length ? list.map((r) => `<tr>${row(r).map((c, i) => `<td class="${i === (t === 'added' && many ? 1 : 0) || (moveH === H && i === 1) ? 'u' : ''}">${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${H.length}" class="empty">Bu listede sayfa yok.</td></tr>`
  }</tbody>`;
}
$('#cmpTiles').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  cmpState.tab = b.dataset.tab;
  for (const x of $('#cmpTiles').querySelectorAll('[data-tab]')) x.setAttribute('aria-pressed', x === b);
  renderCompareTable();
});
$('#cmpQ').addEventListener('input', (e) => { cmpState.q = e.target.value; renderCompareTable(); });

// ---------- Router ----------
function route() {
  const [, kind, id] = location.hash.split('/');
  if (kind === 'live' && id) return openLive(decodeURIComponent(id));
  if (kind === 'crawl' && id) return openResult(decodeURIComponent(id));
  if (kind === 'project' && id) { const step = location.hash.split('/')[3]; return openProject(decodeURIComponent(id), step); }
  currentId = null; es?.close(); clearTimeout(prj.poll); prj.id = null;
  show('startView');
  heroStrip();
  loadRules();
  loadHistory();
  // v0.6 links (#/compare) open the project mode: comparison lives in projects now.
  setMode(kind === 'compare' || kind === 'new-project' ? 'project' : 'audit');
}
window.addEventListener('hashchange', route);
route();

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
  for (const v of ['startView', 'liveView', 'resultView', 'compareView']) $('#' + v).hidden = v !== view;
}

// ---------- History ----------
let currentId = null;
async function loadHistory() {
  const { running, history } = await api('/api/crawls');
  const ul = $('#history');
  const items = [
    ...running.map((j) => ({ id: j.id, host: new URL(j.url).hostname, label: j.label, sub: 'Taranıyor…', run: true })),
    ...history.map((h) => ({
      id: h.id, host: h.host, label: h.label, sub: fmtDate(h.startedAt), score: h.score,
      bad: h.summary.client + h.summary.server + h.summary.failed, total: h.summary.total,
    })),
  ];
  if (!items.length) { ul.innerHTML = '<li class="muted">Henüz tarama yok.</li>'; return; }
  ul.innerHTML = items.map((i) => `<li><button type="button" data-id="${esc(i.id)}" data-run="${i.run ? 1 : ''}" aria-current="${i.id === currentId}">
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
$('#cmpBtn').addEventListener('click', () => { location.hash = '#/compare'; });

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
        url, label: f.get('label'),
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
  es.addEventListener('done', () => { es.close(); loadHistory(); location.hash = '#/crawl/' + id; });
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
    const max = $('#form [name=maxUrls]');
    max.max = info.maxUrls;
    if (+max.value > info.maxUrls) max.value = info.maxUrls;
  } catch {}
}
loadInfo();

// ---------- Compare: old site vs new sites (Sprint 3, part 1) ----------
// The bar shows what happened to every page of the old site. Tiles open the lists.
// Path rules and extra targets live in the form. Rules are kept in the browser per old host.
const CMP_KINDS = [
  { k: 'same', label: 'Aynı kaldı', cls: 'ok' },
  { k: 'changed', label: 'İçerik değişti', cls: 'warning' },
  { k: 'redirected', label: 'Yönleniyor', cls: 'redirect' },
  { k: 'lost', label: 'Kayboldu', cls: 'critical' },
  { k: 'removed', label: 'Bölüm kaldırıldı', cls: 'removed' },
  { k: 'unlinked', label: 'Açılıyor, link yok', cls: 'notice' },
  { k: 'unknown', label: 'Kontrol edilemedi', cls: 'notice' },
  { k: 'added', label: 'Yeni sayfa', cls: 'new' },
];
const OPTIONAL_KINDS = ['removed', 'unknown', 'unlinked'];
const DROP = '__drop';
const cmpState = { data: null, tab: 'lost', q: '', history: [], rules: [], rulesHost: null, extra: [] };
const crawlLabel = (h) => `${h.host}${h.label ? ' · ' + h.label : ''} · ${fmtDate(h.startedAt)} · ${h.summary.total} URL`;
const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const rulesKey = (host) => `seo-audit:kurallar:${bare(host)}`;
const crawlById = (id) => cmpState.history.find((h) => h.id === id);

function loadPathRules(host) {
  try { const r = JSON.parse(localStorage.getItem(rulesKey(host)) || '[]'); return Array.isArray(r) ? r : []; } catch { return []; }
}
function savePathRules(host, rules) {
  try { localStorage.setItem(rulesKey(host), JSON.stringify(rules)); } catch {}
}

// ---------- Targets ----------
const crawlOptions = () => cmpState.history.map((h) => `<option value="${esc(h.id)}">${esc(crawlLabel(h))}</option>`).join('');
function renderExtra() {
  $('#cmpExtra').innerHTML = cmpState.extra.map((id, i) => `<div class="cmp-extra">
    <label>Yeni site ${i + 2}<select data-extra="${i}">${crawlOptions()}</select></label>
    <button type="button" class="ghost small" data-del-extra="${i}" aria-label="Yeni site ${i + 2} kaldır">Kaldır</button></div>`).join('');
  cmpState.extra.forEach((id, i) => { $(`[data-extra="${i}"]`).value = id; });
  $('#cmpAddTarget').hidden = cmpState.extra.length >= (cmpState.maxTargets || 4) - 1;
}
const targetIds = () => [$('#cmpNew').value, ...cmpState.extra].filter(Boolean);
const targetHosts = () => [...new Set(targetIds().map((id) => crawlById(id)?.host).filter(Boolean))];

// ---------- Rule editor ----------
function readRules() {
  return [...$('#cmpRules').querySelectorAll('.rule')].map((row) => {
    const from = row.querySelector('[name=from]').value.trim();
    const host = row.querySelector('[name=host]').value;
    const to = row.querySelector('[name=to]').value.trim();
    return host === DROP ? { from, drop: true } : { from, host, to: to || '/*' };
  });
}
function renderRules(stats = null) {
  const hosts = targetHosts();
  const main = hosts[0] || '';
  const opts = (r) => {
    const h = r.drop ? DROP : (bare(r.host) === bare(main) ? '' : r.host || '');
    const list = [['', `Ana hedef${main ? ' · ' + main : ''}`], ...hosts.slice(1).map((x) => [x, x])];
    if (h && h !== DROP && !hosts.some((x) => bare(x) === bare(h))) list.push([h, `${h} (seçili değil)`]);
    list.push([DROP, 'Bölüm kaldırıldı']);
    return list.map(([v, t]) => `<option value="${esc(v)}"${v === h ? ' selected' : ''}>${esc(t)}</option>`).join('');
  };
  $('#cmpRules').innerHTML = cmpState.rules.map((r, i) => {
    const st = stats?.[i];
    return `<div class="rule${r.drop ? ' drop' : ''}">
      <label><span class="sr">Kural ${i + 1}: eski yol</span><input name="from" value="${esc(r.from)}" placeholder="/tr/*" spellcheck="false" autocomplete="off"></label>
      <span class="cmp-arrow" aria-hidden="true">→</span>
      <label><span class="sr">Kural ${i + 1}: hedef site</span><select name="host">${opts(r)}</select></label>
      <label><span class="sr">Kural ${i + 1}: yeni yol</span><input name="to" value="${esc(r.drop ? '' : r.to || '/*')}" placeholder="/*" spellcheck="false" autocomplete="off"${r.drop ? ' disabled' : ''}></label>
      <button type="button" class="ghost small" data-del-rule="${i}" aria-label="Kural ${i + 1} sil">Sil</button>
      ${st ? `<span class="small rule-st">${st.pages} sayfa · ${st.found} bulundu</span>` : ''}
    </div>`;
  }).join('') || '<p class="small">Kural yok. Sonuçta önerilen kurallar görünür.</p>';
}
$('#cmpRules').addEventListener('change', (e) => {
  if (e.target.name !== 'host') return;
  cmpState.rules = readRules();
  renderRules();
});
$('#cmpRules').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-rule]');
  if (!b) return;
  cmpState.rules = readRules();
  cmpState.rules.splice(+b.dataset.delRule, 1);
  renderRules();
});
$('#cmpAddRule').addEventListener('click', () => {
  cmpState.rules = [...readRules(), { from: '', host: '', to: '/*' }];
  renderRules();
  $('#cmpRules').querySelector('.rule:last-child [name=from]').focus();
});
$('#cmpAddTarget').addEventListener('click', () => {
  const used = new Set([$('#cmpOld').value, ...targetIds()]);
  cmpState.extra.push((cmpState.history.find((h) => !used.has(h.id)) || cmpState.history[0]).id);
  cmpState.rules = readRules();
  renderExtra(); renderRules();
});
$('#cmpExtra').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-extra]');
  if (!b) return;
  cmpState.extra.splice(+b.dataset.delExtra, 1);
  cmpState.rules = readRules();
  renderExtra(); renderRules();
});
$('#cmpExtra').addEventListener('change', (e) => {
  const s = e.target.closest('[data-extra]');
  if (!s) return;
  cmpState.extra[+s.dataset.extra] = s.value;
  cmpState.rules = readRules(); renderRules();
});
$('#cmpNew').addEventListener('change', () => { cmpState.rules = readRules(); renderRules(); });
$('#cmpOld').addEventListener('change', () => {
  // Rules belong to the old site: show the saved rules of the new old site.
  cmpState.rulesHost = crawlById($('#cmpOld').value)?.host;
  cmpState.rules = loadPathRules(cmpState.rulesHost);
  renderRules();
});

// ---------- Open and run ----------
async function openCompare(a, bList = []) {
  currentId = null; es?.close();
  show('compareView');
  loadHistory();
  $('#cmpErr').textContent = '';
  let history = [];
  try { ({ history } = await api('/api/crawls')); } catch (e) { $('#cmpErr').textContent = e.message; }
  try { cmpState.maxTargets = (await api('/api/info')).maxTargets || 4; } catch {}
  cmpState.history = history;
  $('#cmpOld').innerHTML = crawlOptions(); $('#cmpNew').innerHTML = crawlOptions();
  if (history.length < 2) {
    $('#cmpResult').hidden = true;
    $('#cmpErr').textContent = 'Karşılaştırma için en az iki tarama gerekir. Eski siteyi "Eski site", yeni siteyi "Yeni site" etiketi ile tarayın.';
    return;
  }
  const known = (id) => history.some((h) => h.id === id);
  const pick = (label, skip) => history.find((h) => h.label === label && h.id !== skip)?.id;
  const oldId = (known(a) && a) || pick('eski') || history[1].id;
  const ids = bList.filter(known);
  const newId = ids[0] || pick('yeni', oldId) || history.find((h) => h.id !== oldId).id;
  $('#cmpOld').value = oldId; $('#cmpNew').value = newId;
  cmpState.extra = ids.slice(1);
  renderExtra();
  cmpState.rulesHost = crawlById(oldId)?.host;
  cmpState.rules = loadPathRules(cmpState.rulesHost);
  renderRules();
  $('#cmpNoRule').textContent = '';
  if (!a || !ids.length) { $('#cmpResult').hidden = true; return; }
  await runCompare(oldId, ids);
}

async function runCompare(a, ids) {
  $('#cmpResult').hidden = true;
  $('#cmpBusy').hidden = false;
  const rules = cmpState.rules.filter((r) => r.from);
  const qs = `old=${encodeURIComponent(a)}&new=${ids.map(encodeURIComponent).join(',')}&rules=${encodeURIComponent(JSON.stringify(rules))}`;
  try {
    const d = cmpState.data = await api(`/api/compare?${qs}`);
    const s = d.summary;
    cmpState.tab = s.lost ? 'lost' : s.contentLost ? 'changed' : s.redirectFix ? 'redirected' : s.unknown ? 'unknown' : s.redirected ? 'redirected' : 'added';
    cmpState.q = ''; $('#cmpQ').value = '';
    $('#cmpExcel').href = `/api/compare/excel?${qs}`;
    // The server returns the rules in the order it applies them, with counts.
    cmpState.rules = d.rules.map(({ from, host, to, drop }) => (drop ? { from, drop } : { from, host, to }));
    savePathRules(cmpState.rulesHost, cmpState.rules);
    renderRules(d.rules);
    $('#cmpNoRule').textContent = `Kural yok (aynı yol, ana hedef): ${d.noRule.pages} sayfa · ${d.noRule.found} bulundu`;
    renderCompare();
    $('#cmpResult').hidden = false;
  } catch (e) { $('#cmpErr').textContent = e.message; }
  finally { $('#cmpBusy').hidden = true; }
}

function renderCompare() {
  const { summary: s, warnings, suggestions } = cmpState.data;
  $('#cmpKept').textContent = `%${s.kept}`;
  $('#cmpKeptText').textContent = `Eski sitenin ${s.oldPages} sayfasından ${s.same + s.changed} tanesi beklenen adreste açılıyor.`;
  $('#cmpWarn').innerHTML = warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('');
  $('#cmpSuggest').innerHTML = suggestions.length ? `<div class="suggest">
    <div class="suggest-h"><b>Önerilen kurallar</b><span class="small">Araç eski yolları yeni taramalarda aradı. Öneriyi ekleyin, karşılaştırma tekrar çalışır.</span>
    ${suggestions.length > 1 ? '<button type="button" class="ghost small" data-sug="all">Hepsini ekle</button>' : ''}</div>
    <ul>${suggestions.map((x, i) => `<li><code>${esc(x.text)}</code><span>${esc(x.why)}</span><button type="button" class="ghost small" data-sug="${i}">Ekle</button></li>`).join('')}</ul></div>` : '';
  // Bar: only old pages, so the parts add up to 100%.
  const parts = CMP_KINDS.filter((x) => x.k !== 'added').map((x) => ({ ...x, n: s[x.k] || 0 })).filter((x) => x.n);
  $('#cmpBar').innerHTML = parts.map((x) => `<i class="${x.cls}" style="flex-grow:${x.n}" title="${x.label}: ${x.n}"></i>`).join('');
  $('#cmpBar').setAttribute('aria-label', parts.map((x) => `${x.label}: ${x.n}`).join(', '));
  const sub = {
    changed: s.contentLost ? `${s.contentLost} sayfada kayıp` : 'kayıp yok',
    redirected: s.redirectFix ? `${s.redirectFix} düzeltme gerekli` : 'hedefler doğru',
    lost: s.lost ? '301 gerekli' : '', removed: '301 veya 410 gerekli',
  };
  $('#cmpTiles').innerHTML = CMP_KINDS.filter((x) => !OPTIONAL_KINDS.includes(x.k) || s[x.k]).map((x) => `<button type="button" class="${x.cls}" data-tab="${x.k}" aria-pressed="${cmpState.tab === x.k}">
    <b>${s[x.k]}</b><span>${x.label}</span>${sub[x.k] ? `<em>${sub[x.k]}</em>` : ''}</button>`).join('');
  renderCompareTable();
}

$('#cmpSuggest').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sug]');
  if (!b) return;
  const all = cmpState.data.suggestions;
  const add = b.dataset.sug === 'all' ? all : [all[+b.dataset.sug]];
  cmpState.rules = [...readRules().filter((r) => r.from), ...add.map(({ from, host, to, drop }) => (drop ? { from, drop } : { from, host, to }))];
  renderRules();
  $('#cmpForm').requestSubmit();
});

const cmpLink = (u, txt) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(txt ?? u)}</a>` : esc(txt));
// Explanation under every row: the checked URL, the rule and what to do.
function explain(r, { reason = true, cls = 'flag' } = {}) {
  const ctx = [r.checkUrl && `Kontrol edilen: ${cmpLink(r.checkUrl)}`, r.rule && `Kural: <code>${esc(r.rule)}</code>`].filter(Boolean).join(' · ');
  return `${reason && r.reason ? `<span class="${cls}">${esc(r.reason)}</span>` : ''}${ctx ? `<div class="why">${ctx}</div>` : ''}${r.todo ? `<div class="todo">${esc(r.todo)}</div>` : ''}`;
}

function renderCompareTable() {
  const { rows, summary: s, targets } = cmpState.data;
  const t = cmpState.tab, q = cmpState.q.toLowerCase();
  if (t === 'same') {
    $('#cmpTable').innerHTML = `<tbody><tr><td class="empty">${s.same} sayfa beklenen adreste açılıyor. Title, meta description ve H1 aynı. Liste gerekmez.</td></tr></tbody>`;
    $('#cmpCount').textContent = ''; return;
  }
  let list = rows[t].filter((r) => !q || r.path.toLowerCase().includes(q) || (r.oldTitle || r.newTitle || '').toLowerCase().includes(q));
  const total = list.length;
  list = list.slice(0, 500);
  $('#cmpCount').textContent = `${total} sonuç${total > 500 ? ' · ilk 500 gösteriliyor, tamamı Excel\'de' : ''}`;
  const imp = (r) => `${r.indexable ? '' : '<span class="small">indexlenmez</span> '}<span class="small">${r.inlinks} iç link</span>`;
  const many = targets.length > 1;
  const H = {
    lost: ['Yol', 'Sonuç ve yapılacak', 'Eski title', 'Önem'],
    redirected: ['Yol', 'Hedef ve yapılacak', 'Status', 'Adım'],
    changed: ['Yol', 'Değişim'],
    removed: ['Yol', 'Sonuç ve yapılacak', 'Önem'],
    unknown: ['Yol', 'Neden ve yapılacak'],
    unlinked: ['Yol', 'Durum ve yapılacak'],
    added: [...(many ? ['Site'] : []), 'Yol', 'Title'],
  }[t];
  const row = {
    lost: (r) => [cmpLink(r.oldUrl, r.path), explain(r), esc(r.oldTitle), imp(r)],
    redirected: (r) => [cmpLink(r.oldUrl, r.path), `${cmpLink(r.target)}${explain(r, { reason: false })}`, `<span class="${r.targetBroken ? 'flag' : r.todo ? 'st warnish' : 'st okish'}">${r.status} → ${r.finalStatus || 'hata'}</span>`, r.hops],
    changed: (r) => [cmpLink(r.newUrl, r.path), r.changes.map((c) => `<div class="chg ${c.kind}"><div><b>${esc(c.label)}</b> · ${c.kind === 'lost' ? '<span class="flag">kayıp</span>' : '<span class="small">değişti</span>'}</div><span class="small">Eski: ${esc(c.old) || '—'}</span><span class="small">Yeni: ${esc(c.new) || '—'}</span></div>`).join('') + explain(r, { reason: false })],
    removed: (r) => [cmpLink(r.oldUrl, r.path), explain(r, { cls: 'small' }), imp(r)],
    unknown: (r) => [esc(r.path), explain(r, { cls: '' })],
    unlinked: (r) => [cmpLink(r.newUrl, r.path), explain(r, { cls: '' })],
    added: (r) => [...(many ? [esc(r.site)] : []), cmpLink(r.newUrl, r.path), esc(r.newTitle)],
  }[t];
  $('#cmpTable').innerHTML = `<thead><tr>${H.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    list.length ? list.map((r) => `<tr>${row(r).map((c, i) => `<td class="${i === (t === 'added' && many ? 1 : 0) ? 'u' : ''}">${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${H.length}" class="empty">Bu listede sayfa yok.</td></tr>`
  }</tbody>`;
}

$('#cmpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#cmpErr').textContent = '';
  const a = $('#cmpOld').value, ids = [...new Set(targetIds())];
  if (ids.includes(a)) { $('#cmpErr').textContent = 'Eski ve yeni tarama farklı olmalı.'; return; }
  cmpState.rules = readRules().filter((r) => r.from);
  cmpState.rulesHost = crawlById(a)?.host;
  savePathRules(cmpState.rulesHost, cmpState.rules);
  const h = `#/compare/${encodeURIComponent(a)}/${ids.map(encodeURIComponent).join(',')}`;
  if (location.hash === h) runCompare(a, ids); else location.hash = h;
});
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
  if (kind === 'compare') { const [, , a, b] = location.hash.split('/'); return openCompare(a && decodeURIComponent(a), (b || '').split(',').filter(Boolean).map(decodeURIComponent)); }
  currentId = null; es?.close();
  show('startView');
  heroStrip();
  loadRules();
  loadHistory();
  $('#url').focus();
}
window.addEventListener('hashchange', route);
route();

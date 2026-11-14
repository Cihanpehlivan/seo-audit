// v0.13.0: JavaScript render. Part A runs everywhere (no browser needed). Part B needs Chromium; without it the checks are skipped.
// The test sites run on 127.0.0.1. The "internal" server is a second host name (localhost): every request to it is a leak.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crawl } from '../src/crawler.js';
import { runAudit, loadConfig } from '../src/rules/index.js';
import { renderStatus, mergeRender, makeHostPolicy, cleanAllowHosts } from '../src/render.js';
import { parsePage } from '../src/parser.js';
import { isNoindex } from '../src/rules/helpers.js';

let passed = 0, failed = 0, skipped = 0;
async function check(name, fn) {
  const t0 = Date.now(); try { await fn(); passed++; console.log('  ✓', name, process.env.SURE ? Date.now() - t0 + ' ms' : ''); }
  catch (e) { failed++; console.log('  ✗', name, '—', e.message.split('\n')[0]); }
}
console.log('Render testi');
const listen = (handler, host = '127.0.0.1') => new Promise((ok, fail) => { const s = http.createServer(handler); s.on('error', fail); s.listen(0, host, () => ok(s)); });
const freePort = () => new Promise((ok) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const doc = (title, body = '', head = '') => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;

// ---------- A: without a browser ----------
await check('birleşim: render alanları, ham özet, noindex birleşimi, JS linki, ham linkler kalır', () => {
  const rawHtml = doc('Ham başlık', '<a href="/ham-link">ham</a><script src="https://www.googletagmanager.com/gtm.js?id=GTM-HAM111"></script>', '<meta name="robots" content="noindex">');
  const renHtml = doc('Render başlık', '<a href="/js-link">js</a><script src="https://www.googletagmanager.com/gtm.js?id=GTM-JS2222"></script><img src="https://staging.ornek.test/a.png">');
  const raw = parsePage(rawHtml, 'http://ornek.com/a', 'ornek.com');
  const m = mergeRender(raw, renHtml, 'http://ornek.com/a', 'ornek.com');
  assert.equal(m.title, 'Render başlık');
  assert.equal(m.raw.title, 'Ham başlık');
  assert.ok(isNoindex(m), 'ham noindex kalmalı');
  assert.equal(m.metaRobotsJs, '');
  assert.deepEqual(m.links.map((l) => [l.url, !!l.js]), [['http://ornek.com/js-link', true], ['http://ornek.com/ham-link', false]]);
  assert.deepEqual(m.tracking.sort(), ['GTM-HAM111', 'GTM-JS2222']);
  assert.ok(m.absHosts.asset.includes('staging.ornek.test') && m.absHosts.asset.includes('www.googletagmanager.com'));
  assert.equal(m.raw.internalLinks, 1);
});
await check('host politikası ve izin listesi', () => {
  const pol = makeHostPolicy('www.ornek.com', ['cdn.dis.example'], ['googletagmanager.com', 'ornek.com']);
  assert.equal(pol('https://ornek.com/a.js'), null, 'site her zaman izinli (engel listesinde olsa da)');
  assert.equal(pol('https://static.ornek.com/a.js'), 'blocklist', 'engel listesi alt alan adında kazanır');
  assert.equal(makeHostPolicy('www.ornek.com')('https://static.ornek.com/a.js'), null, 'alt alan adı izinli');
  assert.equal(pol('https://cdn.dis.example/a.js'), null);
  assert.equal(pol('https://x.cdn.dis.example/a.js'), null);
  assert.equal(pol('https://www.googletagmanager.com/gtm.js'), 'blocklist');
  assert.equal(pol('https://baska.example/a.js'), 'third-party');
  assert.deepEqual(cleanAllowHosts('https://cdn.ornek.com/x, *.static.example ; kotu adres, cdn.ornek.com'), ['cdn.ornek.com', 'static.example']);
});

let listHits = [];
const listSite = await listen((q, r) => { listHits.push(q.url); r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(doc('Liste ' + q.url, '<script>document.title="JS"</script>')); });
const LB = `http://127.0.0.1:${listSite.address().port}`;
await check('liste modu render yapmaz', async () => {
  const r = await crawl(LB + '/', { seeds: [LB + '/a', LB + '/b'], render: true });
  assert.equal(r.meta.render, undefined);
  assert.ok(r.pages.every((p) => !p.render && !p.rendered && p.title.startsWith('Liste')));
});
await check('tarayıcı açılmazsa tarama ham devam eder, kural nedeni yazar', async () => {
  const code = `import { crawl } from './src/crawler.js'; import { runAudit } from './src/rules/index.js';
    const r = await crawl(process.argv[1], { maxUrls: 2, useSitemap: false, render: true });
    const a = runAudit(r); const f = a.rules.find((x) => x.id === 'render-failed').items;
    console.log(JSON.stringify({ render: r.meta.render, title: r.pages[0].title, rendered: r.pages[0].rendered, item: f[0] }));`;
  const out = await new Promise((ok, no) => execFile(process.execPath, ['--input-type=module', '-e', code, LB + '/'], { env: { ...process.env, CHROMIUM_PATH: '/yok/chromium' } }, (e, so, se) => (e ? no(new Error(se || e.message)) : ok(so))));
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.render.enabled, false);
  assert.ok(j.render.error, 'hata nedeni yok');
  assert.equal(j.title, 'Liste /', 'ham alan kullanılmalı');
  assert.equal(j.rendered, undefined);
  assert.match(j.item.detail, /^Tarayıcı açılmadı/);
});
listSite.close();

// Server: public mode closes render. A render request when the browser is missing gets 400 and a reason.
async function runServer(env) {
  const port = await freePort();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-render-'));
  const p = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, APP_USER: '', APP_PASS: '', HOST: '127.0.0.1', PORT: String(port), CRAWL_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.resume(); p.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const api = async (u, opt = {}) => { const r = await fetch(base + u, { ...opt, headers: { 'content-type': 'application/json' }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };
  return { p, api };
}
await check('yayın modunda render kapalı (info ve 400)', async () => {
  const s = await runServer({ PUBLIC_MODE: '1', EPHEMERAL_STORAGE: '1' });
  try {
    const info = await s.api('/api/info');
    assert.deepEqual([info.data.render.available, info.data.render.code], [false, 'public']);
    const r = await s.api('/api/crawls', { method: 'POST', body: { url: 'https://ornek.example/', options: { render: true } } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Yayın modunda/);
  } finally { s.p.kill(); }
});
await check('tarayıcı yoksa render isteği 400 ve neden', async () => {
  const s = await runServer({ PUBLIC_MODE: '', CHROMIUM_PATH: '/yok/chromium' });
  try {
    const info = await s.api('/api/info');
    assert.equal(info.data.render.available, false);
    assert.ok(['browser', 'package'].includes(info.data.render.code));
    const r = await s.api('/api/crawls', { method: 'POST', body: { url: 'http://127.0.0.1:9/', options: { render: true } } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Chromium|playwright-core/);
  } finally { s.p.kill(); }
});

// Project: render setting per site. After launch the old site stays locked (render does not open a way around the lock).
await check('proje: site render ayarı saklanır, çıkıştan sonra eski siteye istek yok', async () => {
  let oldHits = 0;
  const oldSrv = await listen((q, r) => { oldHits++; r.writeHead(200, { 'content-type': 'text/html' }); r.end(doc('Eski')); });
  const newSrv = await listen((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(doc('Yeni')); });
  const s = await runServer({ PUBLIC_MODE: '' });
  try {
    const sites = [{ role: 'old', url: `http://127.0.0.1:${oldSrv.address().port}/` }, { role: 'heir', url: `http://localhost:${newSrv.address().port}/`, render: true, renderAllow: 'cdn.ornek.example, kotu adres' }];
    const c = await s.api('/api/projects', { method: 'POST', body: { name: 'Render testi', sites } });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const pid = c.data.project?.id || c.data.id;
    const prj = (await s.api(`/api/projects/${pid}`)).data;
    const heir = (prj.project || prj).sites.find((x) => x.role === 'heir');
    assert.deepEqual([heir.render, heir.renderAllow], [true, ['cdn.ornek.example']]);
    assert.equal((prj.project || prj).sites.find((x) => x.role === 'old').render, undefined);
    // Raw crawls (render false for the old site) so the launch can be marked without a browser.
    await s.api(`/api/projects/${pid}`, { method: 'PUT', body: { ...(prj.project || prj), sites: (prj.project || prj).sites.map((x) => ({ ...x, render: false })) } });
    for (const key of ['old', 'heir']) {
      const j = await s.api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: key } });
      assert.equal(j.status, 201, JSON.stringify(j.data));
    }
    for (let i = 0; i < 100; i++) {
      const st = (await s.api(`/api/projects/${pid}`)).data;
      if ((st.project || st).sites.every((x) => x.crawlId)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const l = await s.api(`/api/projects/${pid}/launch`, { method: 'POST', body: { at: '2026-11-14' } });
    assert.equal(l.status, 200, JSON.stringify(l.data));
    const cur = (await s.api(`/api/projects/${pid}`)).data;
    await s.api(`/api/projects/${pid}`, { method: 'PUT', body: { ...(cur.project || cur), sites: (cur.project || cur).sites.map((x) => ({ ...x, render: true })) } });
    const before = oldHits;
    const r = await s.api(`/api/projects/${pid}/crawl`, { method: 'POST', body: { site: 'old', options: { render: true } } });
    assert.equal(r.status, 409);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(oldHits, before, 'çıkıştan sonra eski siteye istek gitti');
  } finally { s.p.kill(); oldSrv.close(); newSrv.close(); }
});

// ---------- B: with Chromium ----------
const rs = await renderStatus();
if (!rs.available) {
  skipped = 10;
  console.log(`  ↷ Tarayıcı testleri atlandı (${skipped} kontrol): ${rs.reason}`);
} else {
  // "Internal" server: a second host name. Every request here is a leak.
  const secretHits = []; const secretAuth = {};
  const secret = await listen((q, r) => { secretHits.push(q.url); secretAuth[q.url] = q.headers.authorization || ''; r.writeHead(200, { 'content-type': q.url.endsWith('.js') ? 'text/javascript' : 'text/html', 'access-control-allow-origin': '*' }); r.end(q.url.endsWith('.js') ? 'document.title="SIZINTI"' : 'gizli'); });
  const S = `http://localhost:${secret.address().port}`;
  const siteHits = []; const authSeen = {};
  const AUTH = 'Basic ' + Buffer.from('kullanici:sifre').toString('base64');
  const BIG = 'var x = "' + 'a'.repeat(100 * 1024) + '";';
  const site = await listen((q, r) => {
    siteHits.push(q.url); authSeen[q.url] = q.headers.authorization || '';
    const u = q.url;
    const send = (status, body, type = 'text/html') => { r.writeHead(status, { 'content-type': type }); r.end(body); };
    if (u === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /yasak\n', 'text/plain');
    if (u === '/yonlen.js') { r.writeHead(302, { location: S + '/v-yonlendirme.js' }); return r.end(); }
    if (u === '/app.js') return send(200, 'window.APP = 1;', 'text/javascript');
    if (u === '/buyuk.js') return send(200, BIG, 'text/javascript');
    if (u === '/api/veri') { setTimeout(() => send(200, JSON.stringify({ title: 'Geç gelen başlık: çğıöşü', h1: 'Geç gelen H1' }), 'application/json'), 300); return; }
    if (u === '/sw.js') return send(200, `self.addEventListener('install', () => fetch('${S}/v-service-worker'))`, 'text/javascript');
    if (u === '/sizinti') return send(200, `<!doctype html><html><head><meta charset="utf-8"><title>Sızıntı denemesi</title>
<link rel="preconnect" href="${S}/v-preconnect"><link rel="prefetch" href="${S}/v-prefetch"><link rel="stylesheet" href="${S}/v-css.css">
<script src="${S}/v-script.js"></script><script src="/yonlen.js"></script></head><body><h1>Sızıntı</h1><img src="${S}/v-img.png"><iframe src="${S}/v-iframe"></iframe>
<script>fetch('${S}/v-fetch').catch(()=>{}); navigator.sendBeacon('${S}/v-beacon', 'x');
try { new WebSocket('ws://localhost:${secret.address().port}/v-websocket'); } catch (e) {}
try { new EventSource('${S}/v-eventsource'); } catch (e) {}
navigator.serviceWorker && navigator.serviceWorker.register('/sw.js').catch(()=>{});
const x = new XMLHttpRequest(); x.open('GET', '${S}/v-xhr'); x.send();
fetch('/api/veri', { method: 'POST', body: 'x' }).catch(()=>{});</script></body></html>`);
    if (u === '/sifreli') return send(200, doc('Şifreli', '<p>x</p>', `<script src="/app.js"></script><script src="${S}/dis.js"></script>`));
    if (u === '/dis-servis') return send(200, doc('Dış servis', '', '<script src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST123"></script><script src="https://cdn.ornek.invalid/lib.js"></script><link rel="stylesheet" href="https://fonts.googleapis.com/css?family=X">'));
    if (u === '/gec') return send(200, '<html><head><title>Yükleniyor</title><script src="/app.js"></script></head><body><div id="app"></div><script>setTimeout(() => fetch("/api/veri").then((r) => r.json()).then((d) => { document.title = d.title; document.getElementById("app").innerHTML = "<h1>" + d.h1 + "</h1>"; }), 300);</script></body></html>');
    if (u === '/buyuk') return send(200, doc('Büyük', '', '<script src="/buyuk.js"></script>'));
    if (u === '/yasak') return send(200, doc('Yasak', '<script>document.title="JS"</script>'));
    if (u === '/') return send(200, doc('Ana', ['/sizinti', '/dis-servis', '/gec', '/buyuk', '/yasak'].map((x) => `<a href="${x}">${x}</a>`).join(' ')));
    send(404, doc('Yok'));
  });
  const B = `http://127.0.0.1:${site.address().port}`;
  const pg = (r, u) => r.pages.find((p) => p.url === B + u);
  const opt = { useSitemap: false, timeoutMs: 3000, render: { limits: { quietMs: 500, maxWaitMs: 2000, timeoutMs: 6000 } } };

  const r1 = await crawl(B + '/', opt);
  if (process.env.SURE) for (const p of r1.pages) console.log('   ', p.url.replace(B, ''), p.render?.ms, p.render?.waitCapped ? 'cap' : '');
  await check('SSRF: dış host engellenir, iç sunucuya 0 istek (13 yol: script, CSS, img, iframe, fetch, XHR, beacon, WebSocket, EventSource, prefetch, preconnect, service worker, 302)', () => {
    assert.ok(pg(r1, '/sizinti').rendered, 'sayfa render edilmedi');
    assert.deepEqual(secretHits, []);
    assert.ok(pg(r1, '/sizinti').render.blocked >= 8, `engellenen ${pg(r1, '/sizinti').render.blocked}`);
    assert.equal(pg(r1, '/sizinti').title, 'Sızıntı denemesi');
  });
  await check('aynı sitedeki POST isteği kontrol noktasından geçer, sayfanın kendisi tekrar istenmez', () => {
    assert.ok(siteHits.includes('/api/veri'));
    assert.equal(siteHits.filter((u) => u === '/sizinti').length, 1);
  });
  secretHits.length = 0;
  const blockLocalhost = async (u) => (new URL(u).hostname === 'localhost' ? 'blocked-private' : null);
  const r2 = await crawl(B + '/sizinti', { ...opt, maxUrls: 1, guard: blockLocalhost, render: { ...opt.render, allowHosts: ['localhost'] } });
  if (process.env.SURE) console.log('    r2', pg(r2, '/sizinti').render.ms);
  await check('SSRF: izin listesindeki host da korumadan geçer (yönlendirmenin her adımı dahil)', () => {
    assert.ok(pg(r2, '/sizinti').rendered);
    assert.deepEqual(secretHits, []);
    assert.ok(pg(r2, '/sizinti').render.failed >= 5, `başarısız ${pg(r2, '/sizinti').render.failed}`);
  });
  await check('dış servis: engel listesi, izin listesi, etiket kimliği DOM\'dan okunur', () => {
    const p = pg(r1, '/dis-servis');
    const hosts = p.render.blockedHosts.map((h) => h.host);
    assert.ok(hosts.includes('www.googletagmanager.com') && hosts.includes('cdn.ornek.invalid'), hosts.join(','));
    assert.ok(p.tracking.includes('GTM-TEST123'));
    assert.ok(p.render.skipped >= 0);
  });
  await check('geç gelen içerik (ağ sessiz bekleme) ve Türkçe harf', () => {
    const p = pg(r1, '/gec');
    assert.equal(p.title, 'Geç gelen başlık: çğıöşü');
    assert.deepEqual(p.h1, ['Geç gelen H1']);
    assert.equal(p.raw.title, 'Yükleniyor');
  });
  await check('önbellek: aynı JS dosyası bir kez istenir', () => assert.equal(siteHits.filter((u) => u === '/app.js').length, 1));
  await check('robots.txt: engelli sayfa render edilmez', () => {
    assert.equal(pg(r1, '/yasak').blockedByRobots, true);
    assert.ok(!pg(r1, '/yasak').render && !siteHits.includes('/yasak'));
  });
  await check('staging şifresi sadece taranan siteye gider', async () => {
    secretHits.length = 0;
    const r4 = await crawl(B + '/sifreli', { ...opt, maxUrls: 1, auth: 'kullanici:sifre', render: { ...opt.render, allowHosts: ['localhost'] } });
    assert.ok(pg(r4, '/sifreli').rendered);
    assert.equal(authSeen['/app.js'], AUTH, 'aynı site şifreyi almadı');
    assert.deepEqual(secretHits, ['/dis.js'], 'izinli dış host istenmeli');
    assert.equal(secretAuth['/dis.js'], '', 'dış host şifreyi aldı');
  });
  await check('gövde sınırı alt isteklerde de geçerli', async () => {
    const r5 = await crawl(B + '/buyuk', { ...opt, maxUrls: 1, maxBodyBytes: 20 * 1024 });
    assert.ok(pg(r5, '/buyuk').rendered);
    assert.equal(pg(r5, '/buyuk').render.truncated, 1);
  });
  await check('render sayfa sınırı: sonrası ham okunur', async () => {
    const r6 = await crawl(B + '/', { ...opt, render: { limits: { ...opt.render.limits, maxPages: 2 } } });
    assert.ok(r6.meta.render.limitReached && r6.meta.render.pages === 2);
    const skip = r6.pages.filter((p) => p.render?.skipped === 'limit');
    assert.ok(skip.length >= 1 && skip.every((p) => !p.rendered && p.title));
  });
  secret.close(); site.close();
}

console.log(`\n${passed} kontrol geçti, ${failed} başarısız${skipped ? `, ${skipped} atlandı` : ''}.`);
if (failed) process.exitCode = 1;

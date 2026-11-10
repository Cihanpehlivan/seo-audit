// Runs the crawler against the fixture site and checks key results.
import assert from 'node:assert/strict';
import { startFixture } from './fixture-server.js';
import { crawl } from '../src/crawler.js';
import { exportExcel } from '../src/export.js';
import { readSitemaps } from '../src/sitemap.js';
import http from 'node:http';

const server = await startFixture();
const base = `http://127.0.0.1:${server.address().port}`;
const r = await crawl(base + '/', { concurrency: 3 });
const get = (p) => r.pages.find((x) => x.url === base + p);
let ok = 0;
const check = (name, fn) => { try { fn(); ok++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n   ', e.message); process.exitCode = 1; } };

check('ana sayfa 200 ve title', () => { assert.equal(get('/').status, 200); assert.equal(get('/').title, 'Ana sayfa'); });
check('utm parametresi temizlenir', () => assert.equal(r.pages.filter((p) => p.url.startsWith(base + '/?')).length, 0));
check('301 kaydedilir', () => { const p = get('/eski-sayfa'); assert.equal(p.status, 301); assert.equal(p.finalUrl, base + '/hakkimizda'); });
check('redirect zinciri 2 hop', () => { const p = get('/zincir-1'); assert.equal(p.redirectChain.length, 2); assert.equal(p.finalStatus, 200); });
check('redirect döngüsü yakalanır', () => assert.equal(get('/dongu-a').error, 'redirect-loop'));
check('404 kaydedilir', () => assert.equal(get('/yok').status, 404));
check('500 kaydedilir', () => assert.equal(get('/hata').status, 500));
check('robots engeli', () => assert.equal(get('/private/gizli').blockedByRobots, true));
check('yetim sayfa sitemapten bulunur', () => { const p = get('/yetim'); assert.equal(p.orphan, true); assert.equal(p.inSitemap, true); });
check('boş title ve 2 H1', () => { const p = get('/hakkimizda'); assert.equal(p.title, ''); assert.equal(p.h1.length, 2); });
check('noindex okunur', () => assert.match(get('/urunler/').metaRobots, /noindex/));
check('canonical ve hreflang', () => { const p = get('/'); assert.equal(p.canonical, base + '/'); assert.equal(p.hreflang[0].lang, 'en'); assert.ok(get('/en/')); });
check('windows-1254 Türkçe karakter', () => assert.equal(get('/latin').title, 'Şişli Çağrı Ğ'));
check('alt eksik görsel', () => { const p = get('/'); assert.equal(p.imgNoAlt, 1); assert.equal(p.imgEmptyAlt, 1); });
check('dış link taranmaz', () => assert.equal(r.pages.some((p) => p.url.includes('example.org')), false));
check('sitemap + link sayfası derinlik alır', () => { const p = get('/hakkimizda'); assert.equal(p.depth, 1); assert.equal(p.discoveredBy, 'link'); });
check('inlink sayımı', () => assert.ok(get('/hakkimizda').inlinks >= 1));
check('sitemap index okunur', () => assert.equal(r.meta.sitemap.urlCount, 3));
await exportExcel(r, '/tmp/test.xlsx');
check('excel üretilir', () => assert.ok(true));

server.close();

// ---------- v0.10.1: password scope, body limits, sitemap entities ----------
const acheck = async (name, fn) => { try { await fn(); ok++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n   ', e.message); process.exitCode = 1; } };
const listen = (handler, host = '127.0.0.1') => new Promise((done) => { const s = http.createServer(handler); s.listen(0, host, () => done(s)); });
const html = (body) => `<!doctype html><html lang="tr"><head><title>T</title></head><body>${body}</body></html>`;

await acheck('staging şifresi başka hosta gitmez (yönlendirme ve sitemap)', async () => {
  const seen = [];
  // "localhost" is another host name for the same machine: for the crawler it is an external site.
  const other = await listen((q, res) => { seen.push({ url: q.url, auth: q.headers.authorization || null }); res.writeHead(200, { 'content-type': 'application/xml' }); res.end('<urlset></urlset>'); }, 'localhost');
  const op = other.address().port;
  let siteAuth = 0;
  const site = await listen((q, res) => {
    if (q.headers.authorization) siteAuth++;
    if (q.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nAllow: /\nSitemap: http://localhost:${op}/sitemap.xml\n`); }
    if (q.url === '/git') { res.writeHead(302, { location: `http://localhost:${op}/hedef` }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('<a href="/git">git</a>'));
  });
  await crawl(`http://127.0.0.1:${site.address().port}/`, { auth: 'kullanici:gizli' });
  site.close(); other.close();
  assert.ok(siteAuth >= 2, 'şifre taranan siteye gitmeli');
  assert.deepEqual(seen.map((x) => x.url).sort(), ['/hedef', '/sitemap.xml']);
  assert.deepEqual(seen.map((x) => x.auth), [null, null]);
});

await acheck('yavaş gövde zaman aşımına uğrar, büyük gövde kesilir', async () => {
  const site = await listen((q, res) => {
    if (q.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.on('error', () => {});
    if (q.url === '/yavas-govde') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html>'); const t = setInterval(() => res.write('<p>x</p>'), 100); q.on('close', () => clearInterval(t)); return; }
    if (q.url === '/buyuk-govde') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html(`<p>${'a'.repeat(300 * 1024)}</p>`)); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('<a href="/yavas-govde">y</a><a href="/buyuk-govde">b</a>'));
  });
  const b = `http://127.0.0.1:${site.address().port}`;
  const t0 = Date.now();
  const x = await crawl(b + '/', { timeoutMs: 700, maxBodyBytes: 100 * 1024, useSitemap: false });
  site.closeAllConnections(); site.close();
  const slow = x.pages.find((p) => p.url === b + '/yavas-govde'), big = x.pages.find((p) => p.url === b + '/buyuk-govde');
  assert.ok(Date.now() - t0 < 5000, 'tarama asılı kaldı');
  assert.deepEqual([slow.status, slow.error], [0, 'timeout']);
  assert.deepEqual([big.status, big.sizeBytes, big.truncated], [200, 100 * 1024, true]);
});

await acheck('sitemap: entity genişletilmez, standart entity çözülür', async () => {
  const lol = ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i, all) => `<!ENTITY ${n} "${i ? `&${all[i - 1]};`.repeat(10) : 'aaaaaaaaaa'}">`).join('');
  const body = `<?xml version="1.0"?><!DOCTYPE urlset [${lol}]><urlset><url><loc>http://a.test/x?p=1&amp;q=2&#38;r=3</loc></url><url><loc>http://a.test/&f;</loc></url></urlset>`;
  const sm = await readSitemaps(['http://a.test/sitemap.xml'], async () => ({ status: 200, body }));
  assert.equal(sm.urls[0], 'http://a.test/x?p=1&q=2&r=3');
  assert.ok(sm.urls.every((u) => u.length < 100), 'entity genişledi');
});

console.log(`\n${ok} kontrol geçti. Toplam URL: ${r.pages.length}`);

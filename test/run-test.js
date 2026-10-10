// Runs the crawler against the fixture site and checks key results.
import assert from 'node:assert/strict';
import { startFixture } from './fixture-server.js';
import { crawl } from '../src/crawler.js';
import { exportExcel } from '../src/export.js';

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

console.log(`\n${ok} kontrol geçti. Toplam URL: ${r.pages.length}`);
server.close();

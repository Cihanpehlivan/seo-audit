// Checks that every rule fires on its fixture page and that the clean page has no issues.
import assert from 'node:assert/strict';
import { startRuleFixture, VARIANTS } from './fixture-rules.js';
import { startHttpsFixture } from './fixture-https.js';
import { crawl } from '../src/crawler.js';
import { runAudit, loadConfig, RULES } from '../src/rules/index.js';

const cfg = loadConfig();
cfg.thresholds = { ...cfg.thresholds, maxLinksPerPage: 30 };

const server = await startRuleFixture();
const base = `http://127.0.0.1:${server.address().port}`;
const t0 = Date.now();
const result = await crawl(base + '/', { concurrency: 6, timeoutMs: 1800, checks: { variants: VARIANTS.map((v) => base + v) } });
server.close();
const audit = runAudit(result, cfg);
const fired = (id) => audit.rules.find((r) => r.id === id)?.items || [];
const hits = (id, path) => fired(id).some((i) => i.url === base + path || (path === '*' && i));

// rule id -> page that must trigger it
const EXPECT = {
  'http-4xx': '/yok', 'http-5xx': '/hata', 'http-failed': '/yavas', 'robots-blocks-site': '*', 'ai-bots-blocked': '*',
  'noindex-in-sitemap': '/noindex', 'blocked-in-sitemap': '/private/x', 'sitemap-non200': '/eski', 'indexable-not-in-sitemap': '/ts',
  'orphan-page': '/yetim', 'deep-page': '/d5', 'soft-404': '/soft404',
  'redirect-chain': '/z1', 'redirect-loop': '/l1', 'redirect-broken': '/rb', 'redirect-temporary': '/gecici',
  'internal-link-to-redirect': '/', 'trailing-slash-duplicate': '/ts',
  'canonical-missing': '/nocanon', 'canonical-multiple': '/multicanon', 'canonicalized': '/canon-other', 'canonical-target-bad': '/canon-bad',
  'noindex-canonical-conflict': '/noindex-canon',
  'title-missing': '/notitle', 'title-too-long': '/longtitle', 'title-too-short': '/shorttitle', 'title-duplicate': '/dup-a',
  'title-multiple': '/multititle', 'title-equals-h1': '/title-h1', 'title-brand-inconsistent': '/nobrand',
  'desc-missing': '/nodesc', 'desc-too-long': '/longdesc', 'desc-too-short': '/shortdesc', 'desc-duplicate': '/dup-b', 'desc-multiple': '/multidesc',
  'h1-missing': '/noh1', 'h1-multiple': '/multih1', 'h1-duplicate': '/dup-a', 'heading-skip': '/skip', 'heading-empty': '/emptyh',
  'thin-content': '/thin', 'content-duplicate': '/kopya-a', 'content-near-duplicate': '/benzer-a', 'placeholder-text': '/lorem',
  'broken-internal-link': '/', 'internal-nofollow': '/nofollow', 'anchor-generic': '/generic', 'too-many-links': '/manylinks', 'staging-link': '/staging-link',
  'img-alt-missing': '/gorsel', 'img-alt-empty': '/gorsel', 'img-legacy-format': '/gorsel', 'img-no-dimensions': '/gorsel',
  'hreflang-invalid-code': '/hl-bad', 'hreflang-no-self': '/hl-noself', 'hreflang-no-return': '/hl-noreturn', 'hreflang-no-xdefault': '/hl-en',
  'hreflang-target-bad': '/hl-badtarget', 'hreflang-lang-mismatch': '/hl-en',
  'schema-parse-error': '/schema-bad', 'schema-missing-fields': '/schema-eksik', 'og-missing': '/noog', 'twitter-card-missing': '/noog',
  'slow-response': '/slow', 'large-html': '/big', 'render-blocking': '/blocking',
  'viewport-missing': '/noviewport', 'lang-missing': '/nolang', 'unnamed-controls': '/unnamed', 'favicon-missing': '/',
  'url-format': '/Buyuk_Harf', 'url-non-ascii': '/%C5%9Fehir-rehberi', 'url-long': '/uzun?a=1&b=2&c=3&d=4',
  // Sprint 2
  'broken-external-link': '/dis-link', 'img-broken': '/gorsel', 'img-too-large': '/buyuk-gorsel', 'compression-missing': '/sikistirmasiz',
  'llms-txt-missing': '*', 'host-variant-duplicate': '/varyant-ayni', 'host-variant-redirect': '/varyant-302',
};
// Rules that need HTTPS or a site without any schema: tested with synthetic data below.
const SYNTHETIC = ['http-internal-link', 'mixed-content', 'site-not-https', 'schema-none'];
// Rules that need an HTTPS server: tested on fixture-https.js below.
const HTTPS_RULES = ['ssl-invalid', 'ssl-expiring', 'hsts-missing', 'hsts-short'];

let ok = 0, fail = 0;
const check = (name, fn) => { try { fn(); ok++; } catch (e) { fail++; console.log('  ✗', name, '\n    ', e.message.split('\n')[0]); } };

console.log(`Kural testi: ${RULES.length} kural, ${result.pages.length} URL, tarama ${Date.now() - t0} ms (ek kontroller ${result.checks.ms} ms), denetim ${audit.ms} ms`);
for (const r of RULES) {
  if (SYNTHETIC.includes(r.id) || HTTPS_RULES.includes(r.id)) continue;
  check(r.id, () => {
    assert.ok(EXPECT[r.id], 'test beklentisi tanımlı değil');
    assert.ok(hits(r.id, EXPECT[r.id]), `${EXPECT[r.id]} sayfasında tetiklenmedi. Tetiklenen: ${fired(r.id).map((i) => i.url.replace(base, '')).join(', ') || '-'}`);
  });
}

// False-positive check: the clean page must have zero issues.
check('temiz sayfada sorun yok', () => {
  const on = audit.rules.filter((r) => r.items.some((i) => i.url === base + '/temiz')).map((r) => r.id);
  assert.deepEqual(on, []);
});
check('benzer içerik sadece benzer sayfalarda', () => assert.deepEqual(fired('content-near-duplicate').map((i) => i.url.replace(base, '')).sort(), ['/benzer-a', '/benzer-b']));
check('sağlık skoru site kritik hata ile en fazla 40', () => assert.ok(audit.score <= 40));

// Sprint 2: extra checks.
const urls = (id) => fired(id).map((i) => i.url.replace(base, '')).sort();
check('sıkıştırma sadece /sikistirmasiz sayfasında eksik', () => assert.deepEqual(urls('compression-missing'), ['/sikistirmasiz']));
check('doğru 301 varyant sorun vermez', () => assert.deepEqual(urls('host-variant-redirect'), ['/varyant-302', '/varyant-zincir']));
check('kopya varyant sadece /varyant-ayni', () => assert.deepEqual(urls('host-variant-duplicate'), ['/varyant-ayni']));
check('ölü alan adı tek kez sorgulanır', () => assert.ok(result.checks.resources.filter((r) => r.url.includes('ornek.invalid/') && r.ms === 0).length >= 35 - cfg.checks.concurrency));
check('büyük görsel boyutu okunur', () => assert.equal(result.checks.resources.find((r) => r.url === base + '/buyuk.webp').size, 250 * 1024));
check('eski taramada ek kontrol kuralı tetiklenmez', () => {
  const old = runAudit({ meta: result.meta, pages: result.pages.map(({ contentEncoding, ...p }) => p) }, cfg);
  const ids = ['broken-external-link', 'img-broken', 'img-too-large', 'compression-missing', 'llms-txt-missing', 'host-variant-duplicate', 'host-variant-redirect', ...HTTPS_RULES];
  assert.deepEqual(old.rules.filter((r) => ids.includes(r.id) && r.count).map((r) => r.id), []);
});
check('protokol hatası sertifika hatası sayılmaz', () => {
  const site = (error) => ({ ran: { site: true }, site: { home: 'https://ornek.com/', homeHops: 0, hsts: 'max-age=31536000', tls: null, llms: { ok: true },
    variants: [{ url: 'https://www.ornek.com/', hops: 0, chain: [], finalUrl: 'https://www.ornek.com/', finalStatus: 0, error }] }, resources: [] });
  const n = (error) => runAudit({ meta: result.meta, pages: [], checks: site(error) }, cfg).rules.find((r) => r.id === 'host-variant-redirect').count;
  assert.equal(n('ERR_SSL_PACKET_LENGTH_TOO_LONG'), 0);
  assert.equal(n('ECONNREFUSED'), 0);
  assert.equal(n('ERR_TLS_CERT_ALTNAME_INVALID'), 1);
});

// Sprint 2: HTTPS fixture with a self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // test only: the crawler must reach the self-signed server
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('NODE_TLS_REJECT_UNAUTHORIZED') ? undefined : emit.call(process, w, ...a));
const hs = await startHttpsFixture();
const hbase = `https://127.0.0.1:${hs.address().port}`;
const hopt = { maxUrls: 1, useSitemap: false, timeoutMs: 3000, checks: { external: false, images: false, variants: [] } };
const hcfg = { ...cfg, thresholds: { ...cfg.thresholds, sslExpiryDays: 100000 } };
const h1 = runAudit(await crawl(hbase + '/', hopt), hcfg);
const h2 = runAudit(await crawl(hbase + '/hsts-kisa', hopt), hcfg);
hs.close();
const hf = (a, id) => a.rules.find((r) => r.id === id)?.count > 0;
check('ssl-invalid', () => assert.ok(hf(h1, 'ssl-invalid'), 'kendinden imzalı sertifika yakalanmadı'));
check('ssl-expiring', () => assert.ok(hf(h1, 'ssl-expiring'), 'bitiş tarihi okunmadı'));
check('hsts-missing', () => assert.ok(hf(h1, 'hsts-missing')));
check('hsts-short', () => assert.ok(hf(h2, 'hsts-short') && !hf(h2, 'hsts-missing')));
check('llms.txt varsa kural tetiklenmez', () => assert.ok(!hf(h1, 'llms-txt-missing')));

// Synthetic HTTPS / site-level data.
const P = (o) => ({ status: 200, contentType: 'text/html', redirectChain: [], metaRobots: '', xRobotsTag: '', canonical: '', links: [], images: [], jsonld: [], hreflang: [], h1: ['x'], headings: [{ l: 1, t: 'x' }], title: 'x', metaDescription: '', ...o });
const syn = runAudit({
  meta: { host: 'ornek.com', startUrl: 'http://ornek.com/', robots: { status: 404 }, sitemap: { urlCount: 0 } },
  pages: [
    P({ url: 'http://ornek.com/' }),
    P({ url: 'https://ornek.com/a', mixed: ['http://ornek.com/x.jpg'], links: [{ url: 'http://ornek.com/b', internal: true }] }),
  ],
}, cfg);
const sh = (id) => syn.rules.find((r) => r.id === id)?.count > 0;
for (const id of SYNTHETIC) check(id, () => assert.ok(sh(id), 'sentetik veride tetiklenmedi'));

console.log(`\n${ok} kontrol geçti, ${fail} başarısız.`);
if (fail) process.exitCode = 1;

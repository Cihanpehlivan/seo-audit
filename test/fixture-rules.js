// Test site where each page breaks one or two SEO rules on purpose. /temiz breaks none.
import http from 'node:http';
import zlib from 'node:zlib';

const VOCAB = 'kahve masa pencere bahçe deniz rüzgar kitap kalem defter yol köprü şehir mahalle sokak ağaç yaprak çiçek toprak su ateş taş dağ vadi nehir göl ada liman gemi tren istasyon bilet yolcu harita pusula saat takvim gün gece sabah akşam öğle hafta ay yıl mevsim yaz kış bahar güz kar yağmur bulut güneş yıldız gökyüzü renk mavi yeşil kırmızı sarı mor turuncu beyaz siyah gri ses müzik şarkı ritim nota piyano gitar keman davul sahne perde oyun hikaye roman şiir yazar okur sayfa satır kelime harf cümle paragraf bölüm konu fikir düşünce soru cevap örnek deneme proje plan hedef adım süreç sonuç rapor tablo grafik veri bilgi kaynak arşiv kayıt dosya klasör ekran tuş fare kablo ağ sunucu istemci kod modül paket sürüm hata çözüm test kontrol'.split(' ');
function words(seed, n) {
  let x = 0; for (const ch of seed) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  const out = [];
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out.push(VOCAB[x % VOCAB.length]); }
  return out.join(' ');
}

const BRAND = 'Örnek Marka';
function page(path, o = {}) {
  const title = o.title !== undefined ? o.title : `Test sayfası ${path.replace(/\W+/g, ' ').trim() || 'ana'} başlığı | ${BRAND}`;
  const desc = o.desc !== undefined ? o.desc : `Bu ${path} sayfası için yazılmış benzersiz bir açıklama metnidir. Kullanıcıya sayfanın konusunu anlatır ve tıklamaya davet eder.`;
  const h1 = o.h1 !== undefined ? o.h1 : `Ana başlık ${path}`;
  const body = o.body !== undefined ? o.body : `<p>${words(path, 300)}</p>`;
  const head = [
    o.viewport === false ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    title === null ? '' : `<title>${title}</title>`,
    desc === null ? '' : `<meta name="description" content="${desc}">`,
    o.canonical === false ? '' : `<link rel="canonical" href="${o.canonical || path}">`,
    o.og === false ? '' : `<meta property="og:title" content="og ${path}"><meta property="og:description" content="og açıklama"><meta property="og:image" content="/og.jpg"><meta name="twitter:card" content="summary_large_image">`,
    o.favicon === false ? '' : '<link rel="icon" href="/favicon.ico">',
    o.schema === false ? '' : '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"x"}</script>',
    o.head || '',
  ].join('');
  const lang = o.lang === false ? '' : ` lang="${o.lang || 'tr'}"`;
  return `<!doctype html><html${lang}><head><meta charset="utf-8">${head}</head><body><header><nav><a href="/">Ana sayfa</a></nav></header><main>${h1 === null ? '' : `<h1>${h1}</h1>`}<h2>Alt başlık</h2>${body}</main><footer>© ${BRAND}</footer></body></html>`;
}

const dupText = `<p>${words('kopya', 300)}</p>`;
const nearA = words('benzer', 300);
const nearB = nearA.replace(/^(\S+ \S+ \S+) \S+/, '$1 farklıkelime');
const LINKED = ['/temiz', '/yok', '/hata', '/yavas', '/noindex', '/d1', '/soft404', '/z1', '/l1', '/rb', '/gecici', '/ts', '/ts/',
  '/nocanon', '/multicanon', '/canon-other', '/canon-bad', '/noindex-canon', '/notitle', '/longtitle', '/shorttitle', '/dup-a', '/dup-b',
  '/multititle', '/title-h1', '/nobrand', '/nodesc', '/longdesc', '/shortdesc', '/multidesc', '/noh1', '/multih1', '/skip', '/emptyh',
  '/thin', '/kopya-a', '/kopya-b', '/benzer-a', '/benzer-b', '/lorem', '/nofollow', '/generic', '/manylinks', '/staging-link', '/gorsel',
  '/hl-tr', '/hl-en', '/hl-noreturn', '/hl-noself', '/hl-badtarget', '/hl-bad', '/schema-bad', '/schema-eksik', '/noog', '/slow', '/big',
  '/blocking', '/noviewport', '/nolang', '/unnamed', '/Buyuk_Harf', '/%C5%9Fehir-rehberi', '/uzun?a=1&b=2&c=3&d=4',
  '/sikistirmasiz', '/dis-link', '/buyuk-gorsel'];
// Sprint 2: these are not linked. The test passes them as host variants of the site.
export const VARIANTS = ['/varyant-ayni', '/varyant-302', '/varyant-ok', '/varyant-zincir'];
const BIG_IMAGE = Buffer.alloc(250 * 1024, 7);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = {
  '/': () => page('/', { favicon: false, title: `Ana sayfa test sitesi | ${BRAND}`, body: `<p>${words('home', 300)}</p>` + LINKED.map((u) => `<a href="${u}">${u}</a>`).join(' ') }),
  '/temiz': () => page('/temiz'),
  '/hata': () => [500, 'err'],
  '/yavas': async () => { await sleep(2500); return page('/yavas'); },
  '/noindex': () => page('/noindex', { head: '<meta name="robots" content="noindex">' }),
  '/private/x': () => page('/private/x'),
  '/eski': () => [301, '', { location: '/temiz' }],
  '/yetim': () => page('/yetim'),
  '/d1': () => page('/d1', { body: `<p>${words('d1', 300)}</p><a href="/d2">d2</a>` }),
  '/d2': () => page('/d2', { body: `<p>${words('d2', 300)}</p><a href="/d3">d3</a>` }),
  '/d3': () => page('/d3', { body: `<p>${words('d3', 300)}</p><a href="/d4">d4</a>` }),
  '/d4': () => page('/d4', { body: `<p>${words('d4', 300)}</p><a href="/d5">d5</a>` }),
  '/d5': () => page('/d5'),
  '/soft404': () => page('/soft404', { title: `Sayfa bulunamadı | ${BRAND}`, h1: 'Aradığınız sayfa bulunamadı' }),
  '/z1': () => [301, '', { location: '/z2' }],
  '/z2': () => [301, '', { location: '/temiz' }],
  '/l1': () => [301, '', { location: '/l2' }],
  '/l2': () => [301, '', { location: '/l1' }],
  '/rb': () => [301, '', { location: '/yok2' }],
  '/gecici': () => [302, '', { location: '/temiz' }],
  '/ts': () => page('/ts'),
  '/ts/': () => page('/ts/', { body: `<p>${words('ts-slash', 300)}</p>` }),
  '/nocanon': () => page('/nocanon', { canonical: false }),
  '/multicanon': () => page('/multicanon', { head: '<link rel="canonical" href="/multicanon">' }),
  '/canon-other': () => page('/canon-other', { canonical: '/temiz' }),
  '/canon-bad': () => page('/canon-bad', { canonical: '/noindex' }),
  '/noindex-canon': () => page('/noindex-canon', { canonical: '/temiz', head: '<meta name="robots" content="noindex">' }),
  '/notitle': () => page('/notitle', { title: null }),
  '/longtitle': () => page('/longtitle', { title: `Bu çok uzun bir sayfa başlığıdır ve arama sonuçlarında kesinlikle kesilecektir | ${BRAND}` }),
  '/shorttitle': () => page('/shorttitle', { title: 'Kısa' }),
  '/dup-a': () => page('/dup-a', { title: `Aynı başlık burada yazıyor | ${BRAND}`, desc: 'Aynı açıklama iki sayfada da kullanılıyor ve bu yüzden kopya olarak işaretlenmeli, değil mi?', h1: 'Aynı H1' }),
  '/dup-b': () => page('/dup-b', { title: `Aynı başlık burada yazıyor | ${BRAND}`, desc: 'Aynı açıklama iki sayfada da kullanılıyor ve bu yüzden kopya olarak işaretlenmeli, değil mi?', h1: 'Aynı H1' }),
  '/multititle': () => page('/multititle', { head: '<title>İkinci title</title>' }),
  '/title-h1': () => page('/title-h1', { title: `Aynı metin title ve h1 | ${BRAND}`, h1: `Aynı metin title ve h1 | ${BRAND}` }),
  '/nobrand': () => page('/nobrand', { title: 'Marka eki olmayan uzunca bir sayfa başlığı' }),
  '/nodesc': () => page('/nodesc', { desc: null }),
  '/longdesc': () => page('/longdesc', { desc: 'Uzun açıklama. '.repeat(15) }),
  '/shortdesc': () => page('/shortdesc', { desc: 'Kısa açıklama.' }),
  '/multidesc': () => page('/multidesc', { head: '<meta name="description" content="ikinci açıklama">' }),
  '/noh1': () => page('/noh1', { h1: null }),
  '/multih1': () => page('/multih1', { body: `<h1>İkinci H1</h1><p>${words('multih1', 300)}</p>` }),
  '/skip': () => page('/skip', { body: `<h4>Atlanan seviye</h4><p>${words('skip', 300)}</p>` }),
  '/emptyh': () => page('/emptyh', { body: `<h3></h3><p>${words('emptyh', 300)}</p>` }),
  '/thin': () => page('/thin', { body: `<p>${words('thin', 50)}</p>` }),
  '/kopya-a': () => page('/kopya-a', { body: dupText, h1: 'Kopya ürün' }),
  '/kopya-b': () => page('/kopya-b', { body: dupText, h1: 'Kopya ürün' }),
  '/benzer-a': () => page('/benzer-a', { body: `<p>${nearA}</p>` }),
  '/benzer-b': () => page('/benzer-b', { body: `<p>${nearB}</p>` }),
  '/lorem': () => page('/lorem', { body: `<p>${words('lorem', 300)} Lorem ipsum dolor sit amet.</p>` }),
  '/nofollow': () => page('/nofollow', { body: `<p>${words('nofollow', 300)}</p><a href="/temiz" rel="nofollow">Temiz sayfa</a>` }),
  '/generic': () => page('/generic', { body: `<p>${words('generic', 300)}</p><a href="/temiz">Tıklayın</a>` }),
  '/manylinks': () => page('/manylinks', { body: `<p>${words('many', 300)}</p>` + Array.from({ length: 35 }, (_, i) => `<a href="https://ornek.invalid/${i}">Dış kaynak ${i}</a>`).join(' ') }),
  '/staging-link': () => page('/staging-link', { body: `<p>${words('stg', 300)}</p><a href="https://staging.ornek.invalid/urun">Ürün</a>` }),
  '/gorsel': () => page('/gorsel', { body: `<p>${words('gorsel', 300)}</p><img src="/a.jpg"><img src="/b.png" alt="" width="10" height="10"><img src="/c.webp" alt="ok" width="1" height="1">` }),
  '/hl-tr': () => page('/hl-tr', { head: '<link rel="alternate" hreflang="tr" href="/hl-tr"><link rel="alternate" hreflang="en" href="/hl-en"><link rel="alternate" hreflang="x-default" href="/hl-tr">' }),
  '/hl-en': () => page('/hl-en', { head: '<link rel="alternate" hreflang="en" href="/hl-en"><link rel="alternate" hreflang="tr" href="/hl-tr">' }),
  '/hl-noreturn': () => page('/hl-noreturn', { head: '<link rel="alternate" hreflang="tr" href="/hl-noreturn"><link rel="alternate" hreflang="en" href="/hl-en"><link rel="alternate" hreflang="x-default" href="/hl-noreturn">' }),
  '/hl-noself': () => page('/hl-noself', { head: '<link rel="alternate" hreflang="tr" href="/hl-tr"><link rel="alternate" hreflang="x-default" href="/hl-tr">' }),
  '/hl-badtarget': () => page('/hl-badtarget', { head: '<link rel="alternate" hreflang="tr" href="/hl-badtarget"><link rel="alternate" hreflang="en" href="/yok"><link rel="alternate" hreflang="x-default" href="/hl-badtarget">' }),
  '/hl-bad': () => page('/hl-bad', { head: '<link rel="alternate" hreflang="tr" href="/hl-bad"><link rel="alternate" hreflang="en-uk" href="/hl-en"><link rel="alternate" hreflang="x-default" href="/hl-bad">' }),
  '/schema-bad': () => page('/schema-bad', { head: '<script type="application/ld+json">{"@type": "Organization", "name": "x",}</script>' }),
  '/schema-eksik': () => page('/schema-eksik', { head: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","description":"x"}</script>' }),
  '/noog': () => page('/noog', { og: false }),
  '/slow': async () => { await sleep(1200); return page('/slow'); },
  '/big': () => page('/big', { body: `<p>${words('big', 300)}</p><!--${'x'.repeat(600 * 1024)}-->` }),
  '/blocking': () => page('/blocking', { head: Array.from({ length: 6 }, (_, i) => `<script src="/s${i}.js"></script>`).join('') }),
  '/noviewport': () => page('/noviewport', { viewport: false }),
  '/nolang': () => page('/nolang', { lang: false }),
  '/unnamed': () => page('/unnamed', { body: `<p>${words('unnamed', 300)}</p><a href="/temiz"><i class="icon"></i></a><button></button>` }),
  '/Buyuk_Harf': () => page('/Buyuk_Harf'),
  '/%C5%9Fehir-rehberi': () => page('/%C5%9Fehir-rehberi'),
  '/uzun': () => page('/uzun?a=1&b=2&c=3&d=4'),
  // Sprint 2
  '/sikistirmasiz': () => page('/sikistirmasiz'),
  '/dis-link': () => page('/dis-link', { body: `<p>${words('dis', 300)}</p><a href="https://kirik.invalid/sayfa">Kırık dış kaynak</a>` }),
  '/buyuk-gorsel': () => page('/buyuk-gorsel', { body: `<p>${words('buyukgorsel', 300)}</p><img src="/buyuk.webp" alt="Büyük görsel" width="1200" height="800">` }),
  '/buyuk.webp': () => [200, BIG_IMAGE, { 'content-type': 'image/webp', 'content-length': BIG_IMAGE.length }],
  '/varyant-ayni': () => page('/varyant-ayni'),
  '/varyant-302': () => [302, '', { location: '/' }],
  '/varyant-ok': () => [301, '', { location: '/' }],
  '/varyant-zincir': () => [301, '', { location: '/varyant-ok' }],
  '/robots.txt': () => [200, 'User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /\n\nSitemap: http://HOST/sitemap.xml\n', { 'content-type': 'text/plain' }],
  '/sitemap.xml': () => [200, `<?xml version="1.0"?><urlset>${['/', '/temiz', '/noindex', '/private/x', '/eski', '/yetim'].map((u) => `<url><loc>http://HOST${u}</loc></url>`).join('')}</urlset>`, { 'content-type': 'application/xml' }],
};

export function startRuleFixture(port = 0) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const r = R[u.pathname];
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html><head><title>404</title></head><body>yok</body></html>'); }
    let out = await r();
    if (typeof out === 'string') out = [200, out];
    let [status, body, headers = {}] = out;
    if (typeof body === 'string') body = body.replaceAll('HOST', req.headers.host);
    headers = { 'content-type': 'text/html; charset=utf-8', ...headers };
    // Every HTML page is gzipped like a real server, except /sikistirmasiz.
    if (body.length && /html/.test(headers['content-type']) && /gzip/.test(req.headers['accept-encoding'] || '') && u.pathname !== '/sikistirmasiz') {
      body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip';
    }
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

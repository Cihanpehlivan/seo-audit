// Small local test site with known SEO problems.
import http from 'node:http';

const page = (title, body, head = '') => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const W1254 = { 'Ğ': 0xD0, 'İ': 0xDD, 'Ş': 0xDE, 'ğ': 0xF0, 'ı': 0xFD, 'ş': 0xFE };
const enc1254 = (str) => Buffer.from([...str].map((ch) => W1254[ch] ?? ch.charCodeAt(0)));

export function startFixture(port = 0) {
  const routes = {
    '/': () => [200, page('Ana sayfa', `<h1>Hoş geldiniz</h1>
      <a href="/hakkimizda">Hakkımızda</a> <a href="/urunler/">Ürünler</a>
      <a href="/eski-sayfa">Eski</a> <a href="/zincir-1">Zincir</a> <a href="/dongu-a">Döngü</a>
      <a href="/yok">Kırık</a> <a href="/hata">Sunucu</a> <a href="/private/gizli">Gizli</a>
      <a href="/latin">Latin</a> <a href="/?utm_source=x#top">Self</a>
      <a href="https://example.org/dis">Dış</a> <a href="mailto:a@b.com">Mail</a>
      <img src="/a.png"><img src="/b.png" alt="">`,
      '<meta name="description" content="Test açıklaması"><link rel="canonical" href="/"><link rel="alternate" hreflang="en" href="/en/">')],
    '/hakkimizda': () => [200, page('', '<h1>Bir</h1><h1>İki</h1><p>Metin</p>')],
    '/urunler/': () => [200, page('Ürünler', '<h1>Ürünler</h1><a href="/urunler/a">A</a>', '<meta name="robots" content="noindex, follow">')],
    '/urunler/a': () => [200, page('Ürün A', '<h1>A</h1>', '<link rel="canonical" href="/urunler/">')],
    '/en/': () => [200, page('Home', '<h1>Welcome</h1>')],
    '/eski-sayfa': () => [301, '', { location: '/hakkimizda' }],
    '/zincir-1': () => [301, '', { location: '/zincir-2' }],
    '/zincir-2': () => [302, '', { location: '/zincir-3' }],
    '/zincir-3': () => [200, page('Zincir sonu', '<h1>Son</h1>')],
    '/dongu-a': () => [301, '', { location: '/dongu-b' }],
    '/dongu-b': () => [301, '', { location: '/dongu-a' }],
    '/hata': () => [500, 'err'],
    '/private/gizli': () => [200, page('Gizli', '<h1>Gizli</h1>')],
    '/yetim': () => [200, page('Yetim sayfa', '<h1>Kimse link vermiyor</h1>')],
    '/latin': () => [200, enc1254(page('Şişli Çağrı Ğ', '<h1>İstanbul</h1>').replace('utf-8', 'windows-1254')), { 'content-type': 'text/html; charset=windows-1254' }],
    '/robots.txt': () => [200, `User-agent: *\nDisallow: /private/\nSitemap: http://HOST/sitemap.xml\n`, { 'content-type': 'text/plain' }],
    '/sitemap.xml': () => [200, `<?xml version="1.0"?><sitemapindex><sitemap><loc>http://HOST/sm-1.xml</loc></sitemap></sitemapindex>`, { 'content-type': 'application/xml' }],
    '/sm-1.xml': () => [200, `<?xml version="1.0"?><urlset><url><loc>http://HOST/</loc></url><url><loc>http://HOST/yetim</loc></url><url><loc>http://HOST/hakkimizda</loc></url></urlset>`, { 'content-type': 'application/xml' }],
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const host = req.headers.host;
    const r = routes[u.pathname];
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(page('404', 'yok')); }
    let [status, body, headers = {}] = r();
    if (typeof body === 'string') body = body.replaceAll('HOST', host);
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

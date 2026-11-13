// Live sites for the live check test (v0.11.0). All on 127.0.0.1 and localhost, no network.
// The old domain after launch serves the new site (the heir). The Turkish site has its own live domain.
// bozuk:   the live old domain with every problem: missing, wrong, chained and temporary 301s, a target that fails,
//          a 301 to staging, a 404 instead of 410, a lost page, noindex, X-Robots-Tag, "Disallow: /",
//          a staging canonical, staging and foreign hosts in the sitemap, a 404 in the sitemap, no tags.
// trBozuk: the live Turkish site without tags and without sitemap.
// temiz, trTemiz: everything right. No work may come from them (the /temiz rule of the project).
// Old crawls and staging crawls are built in the test (they are files from before launch, not live sites).
import http from 'node:http';

export const STAGING = 'staging.ornek.test';
export const TR_STAGING = 'tr-staging.ornek.test';
export const TAGS = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XY34Z99"></script><script>gtm("GTM-AB12CD")</script>';
export const GSC = '<meta name="google-site-verification" content="eskiDeger123">';
const page = (title, head = '', body = '') => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title} açıklaması">${head}</head><body><h1>${title}</h1>${body}</body></html>`;
const html = (b, h = {}) => [200, b, { 'content-type': 'text/html; charset=utf-8', ...h }];
const go = (loc, status = 301) => [status, '', { location: loc }];
const text = (b) => [200, b, { 'content-type': 'text/plain' }];
const xml = (urls) => [200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`, { 'content-type': 'application/xml' }];

function serve(routes, host) {
  const srv = http.createServer((req, res) => {
    const self = `http://${req.headers.host}`;
    const r = routes[new URL(req.url, 'http://x').pathname];
    const [status, body, headers] = !r ? [404, 'yok', { 'content-type': 'text/html' }] : typeof r === 'function' ? r(self) : r;
    res.writeHead(status, headers);
    res.end(body);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => { srv.origin = `http://${host}:${srv.address().port}`; ok(srv); }));
}

export async function startVerifySites() {
  const o = {}; // origins, known after listen
  const trBozuk = await serve({ '/': html(page('TR')), '/a': html(page('TR A')), '/robots.txt': text('') }, 'localhost');
  const trTemiz = await serve({
    '/': html(page('TR', TAGS, '<a href="/a">A</a>')), '/a': html(page('TR A', TAGS)),
    '/robots.txt': (s) => text(`User-agent: *\nDisallow:\nSitemap: ${s}/sitemap.xml`),
    '/sitemap.xml': (s) => xml([`${s}/`, `${s}/a`]),
  }, 'localhost');
  o.trBozuk = trBozuk.origin; o.trTemiz = trTemiz.origin;

  const bozuk = await serve({
    '/': html(page('Ana sayfa', `<meta name="robots" content="noindex"><link rel="canonical" href="http://${STAGING}/">`, '<a href="/kahveler/a">A</a> <a href="/urun/g">G</a> <a href="/blog">Blog</a>')),
    '/urun/a': go('/kahveler/a'), '/kahveler/a': html(page('Kahve A'), { 'x-robots-tag': 'noindex' }),
    // /urun/b: no 301 (404)
    '/urun/c': go('/kahveler/x'), '/kahveler/x': go('/kahveler/c'), '/kahveler/c': html(page('Kahve C')),
    '/urun/d': go('/kahveler/d', 302), '/kahveler/d': html(page('Kahve D')),
    '/urun/e': go('/'),
    '/urun/f': go('/kahveler/f'), // target 404
    '/urun/g': html(page('Eski ürün G')),
    '/urun/h': go(`http://${STAGING}/kahveler/h`),
    '/eski-haber': [410, '', {}], // /eski-kampanya: 404 instead of 410
    '/tr/a': () => go(`${o.trBozuk}/a`),
    '/blog/y': go('/blog'), '/blog': html(page('Blog')), // /blog/x: lost (no decision, 404)
    '/gizli': [403, '', {}],
    // /hakkimizda: 404 (was on staging)
    '/robots.txt': (s) => text(`User-agent: *\nDisallow: /\nSitemap: ${s}/sitemap.xml`),
    '/sitemap.xml': (s) => xml([`${s}/`, `${s}/hakkimizda`, `http://${STAGING}/x`, 'http://diger.ornek.example/y']),
  }, '127.0.0.1');

  const temiz = await serve({
    '/': html(page('Ana sayfa', TAGS + GSC + '<link rel="canonical" href="/">', '<a href="/kahveler/a">A</a> <a href="/blog">Blog</a>')),
    '/kahveler/a': html(page('Kahve A', TAGS)), '/blog': html(page('Blog', TAGS)),
    '/urun/a': go('/kahveler/a'), '/eski': [410, '', {}], '/tr/a': () => go(`${o.trTemiz}/a`),
    '/robots.txt': (s) => text(`User-agent: *\nDisallow:\nSitemap: ${s}/sitemap.xml`),
    '/sitemap.xml': (s) => xml([`${s}/`, `${s}/kahveler/a`, `${s}/blog`]),
  }, '127.0.0.1');
  return { bozuk, trBozuk, temiz, trTemiz };
}

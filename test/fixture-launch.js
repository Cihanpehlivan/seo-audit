// Small sites for the launch list test (v0.10.0). All on 127.0.0.1, no network.
// old:   the live site today. GTM and GA4 tags, Search Console meta tag.
// kirli: staging with every launch problem (noindex, X-Robots-Tag, Disallow, staging addresses, no tags).
// acik:  staging without password, noindex or Disallow (open to Google). Another GA4 ID.
// temiz: staging behind a password. Relative links, canonical and sitemap on the live domain, the same tags.
//        No launch item may come from it (the /temiz rule of the project).
import http from 'node:http';

export const LIVE = 'https://www.eski.com';
const TAGS = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XY34Z99"></script><script>(function(w){w.dataLayer=w.dataLayer||[];})(window);gtm("GTM-AB12CD")</script>';
const GSC = '<meta name="google-site-verification" content="eskiDeger123">';
const page = ({ title, head = '', body = '' }) => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title} açıklaması">${head}</head><body><h1>${title}</h1>${body}<p>G-METIN123 sayfa metnidir, etiket değildir.</p></body></html>`;
const html = (b, h = {}) => [200, b, { 'content-type': 'text/html; charset=utf-8', ...h }];
const text = (b) => [200, b, { 'content-type': 'text/plain' }];
const xml = (urls) => [200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`, { 'content-type': 'application/xml' }];

function serve(routes, { auth } = {}) {
  const srv = http.createServer((req, res) => {
    if (auth && req.headers.authorization !== 'Basic ' + Buffer.from(auth).toString('base64')) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="staging"' }); return res.end();
    }
    const self = `http://${req.headers.host}`; // the address the crawler used
    const r = routes[new URL(req.url, 'http://x').pathname];
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('yok'); }
    const [status, body, headers] = typeof r === 'function' ? r(self) : r;
    res.writeHead(status, headers);
    res.end(body);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

export const AUTH = 'ekip:gizli-sifre';
export async function startLaunchSites() {
  const old = await serve({
    '/': html(page({ title: 'Ana sayfa', head: TAGS + GSC, body: '<a href="/a">A</a> <a href="/b">B</a>' })),
    '/a': html(page({ title: 'A', head: TAGS })), '/b': html(page({ title: 'B', head: TAGS })),
    '/robots.txt': text(''),
  });
  const kirli = await serve({
    '/': (s) => html(page({ title: 'Ana sayfa', head: `<meta name="robots" content="noindex, nofollow"><link rel="canonical" href="${s}/"><link rel="alternate" hreflang="tr" href="${s}/tr">`,
      body: `<a href="${s}/a">A</a> <a href="/b">B</a> <img src="${s}/logo.png" alt="Logo">` })),
    '/a': (s) => html(page({ title: 'A', head: `<link rel="canonical" href="${s}/a">` })),
    '/b': html(page({ title: 'B', head: '<link rel="canonical" href="/b">' }), { 'x-robots-tag': 'noindex' }),
    '/tr': html(page({ title: 'TR' })),
    '/robots.txt': (s) => text(`User-agent: *\nDisallow: /\nSitemap: ${s}/sitemap.xml`),
    '/sitemap.xml': (s) => xml([`${s}/`, `${s}/a`, `${s}/b`]),
  });
  const acik = await serve({
    '/': html(page({ title: 'Ana sayfa', head: '<script async src="https://www.googletagmanager.com/gtag/js?id=G-YENI1234"></script>', body: '<a href="/a">A</a>' })),
    '/a': html(page({ title: 'A' })),
    '/robots.txt': text('User-agent: *\nDisallow: /admin/'),
  });
  const temiz = await serve({
    '/': html(page({ title: 'Ana sayfa', head: `${TAGS}${GSC}<link rel="canonical" href="${LIVE}/"><link rel="alternate" hreflang="tr" href="https://tr.eski.com/">`, body: '<a href="/a">A</a> <a href="/b">B</a> <a href="https://www.instagram.com/x">IG</a>' })),
    '/a': html(page({ title: 'A', head: `${TAGS}<link rel="canonical" href="${LIVE}/a">` })),
    '/b': html(page({ title: 'B', head: `${TAGS}<link rel="canonical" href="/b">` })),
    '/robots.txt': text('User-agent: *\nDisallow:'), // no Sitemap line: the crawler would fetch the live domain (no network in tests)
    '/sitemap.xml': xml([`${LIVE}/`, `${LIVE}/a`, `${LIVE}/b`]),
  }, { auth: AUTH });
  return { old, kirli, acik, temiz };
}

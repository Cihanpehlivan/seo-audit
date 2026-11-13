// Two small sites for the migration project test.
// Old site: English at the root, Turkish under /tr/, French under /fr/.
// Heir (the site that takes the old domain): English only. It 301s the old Turkish paths to the Turkish site.
import http from 'node:http';

const page = (title, body = '') => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title} açıklaması"></head><body><h1>${title}</h1>${body}</body></html>`;
const serve = (routes) => http.createServer((req, res) => {
  const r = routes[new URL(req.url, 'http://x').pathname];
  if (!r) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page('Bulunamadı')); }
  const [status, body, headers = {}] = r;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
});
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));

export const TR_HOST = 'tr.ornek.test';
export function startMigrationSites() {
  const links = ['/about', '/tr/', '/tr/a', '/tr/b', '/tr/c', '/fr/x', '/fr/y', '/fr/z'].map((p) => `<a href="${p}">${p}</a>`).join(' ');
  const old = serve({
    '/': [200, page('Ana sayfa', links)], '/about': [200, page('Hakkında')],
    '/tr/': [200, page('Türkçe')], '/tr/a': [200, page('A')], '/tr/b': [200, page('B')], '/tr/c': [200, page('C')],
    '/fr/x': [200, page('X')], '/fr/y': [200, page('Y')], '/fr/z': [200, page('Z')],
    '/robots.txt': [200, '', { 'content-type': 'text/plain' }],
    // v0.12.0: pages without links (no sitemap). Only the old address list finds them (test/urllist-test.js).
    '/eski-kampanya': [200, page('Hakkında kampanya')],
    '/eski-indirim': [301, '', { location: '/about' }],
    '/disari': [301, '', { location: 'http://baska.example/x' }], // another host: list mode must not ask it
    '/notlar': [200, 'düz metin', { 'content-type': 'text/plain; charset=utf-8' }],
    // v0.12.1: a page without links that only a list added after launch names (late address, test/urllist-test.js).
    '/gec-sayfa': [200, page('Geç sayfa')],
    // /eski-katalog: 404
  });
  const heir = serve({
    '/': [200, page('Ana sayfa', '<a href="/about">About</a>')], '/about': [200, page('Hakkında')],
    '/tr': [301, '', { location: `https://${TR_HOST}/` }],
    '/tr/a': [301, '', { location: `https://${TR_HOST}/a` }],
    '/tr/b': [301, '', { location: '/tr/b2' }], '/tr/b2': [301, '', { location: `https://${TR_HOST}/b` }], // chain
    '/robots.txt': [200, '', { 'content-type': 'text/plain' }],
    // /tr/c: no 301 (404). /fr/*: 404.
  });
  return Promise.all([listen(old), listen(heir)]);
}

// v0.12.2: old redirects (test/redirects-test.js). Old site: redirects found by links and redirects only a list names.
// Heir (staging): the campaign page has a new address; some old redirect addresses are already set up there.
export const STG_HOST = 'staging.ornek.test'; // a staging host (suffix .test): the old site must not send a 301 there
export function startRedirectSites() {
  const links = ['/kampanya', '/urun', '/hakkimizda', '/eski-link', '/eski-zincir', '/eski-kirik', '/eski-dis', '/eski-stg',
    '/eski-ana', '/eski-sil', '/eski-var', '/eski-kurulu', '/eski-yanlis'].map((p) => `<a href="${p}">${p}</a>`).join(' ');
  const r301 = (to) => [301, '', { location: to }];
  const old = serve({
    '/': [200, page('Ana sayfa', links)], '/kampanya': [200, page('Kampanya')], '/urun': [200, page('Ürün')], '/hakkimizda': [200, page('Hakkımızda')],
    '/eski-link': r301('/kampanya'), // found by a link
    '/eski-zincir': r301('/ara'), '/ara': [302, '', { location: '/urun' }], // chain of two hops
    '/eski-kirik': r301('/yok'), // the target gives 404: no row
    '/eski-dis': r301('http://baska.invalid/x'), // another domain
    '/eski-stg': r301(`http://${STG_HOST}/x`), // a staging domain
    '/eski-ana': r301('/'), // the home page
    '/eski-sil': r301('/hakkimizda'), // the target gets 410 in the map
    '/eski-var': r301('/urun'), // the heir serves this address as a page: no row
    '/eski-kurulu': r301('/kampanya'), '/eski-yanlis': r301('/kampanya'), // the heir already redirects them
    // Without links: only the old address list names them.
    '/eski-indirim': r301('/kampanya'),
    '/eski-gizli': r301('/gizli'), '/gizli': [200, page('Gizli kampanya')], // the target is no old page
    '/eski-dis-liste': r301('http://baska.example/y'), // list mode does not ask another domain
    '/robots.txt': [200, '', { 'content-type': 'text/plain' }],
  });
  const hlinks = ['/yeni/kampanya', '/urun', '/gizli-kampanya', '/eski-var', '/eski-kurulu', '/eski-yanlis'].map((p) => `<a href="${p}">${p}</a>`).join(' ');
  const heir = serve({
    '/': [200, page('Ana sayfa', hlinks)], '/yeni/kampanya': [200, page('Kampanya')], '/urun': [200, page('Ürün')],
    '/gizli-kampanya': [200, page('Gizli kampanya')], '/eski-var': [200, page('Eski var')],
    '/eski-kurulu': [301, '', { location: '/yeni/kampanya' }], '/eski-yanlis': [301, '', { location: '/urun' }],
    '/robots.txt': [200, '', { 'content-type': 'text/plain' }],
  });
  return Promise.all([listen(old), listen(heir)]);
}

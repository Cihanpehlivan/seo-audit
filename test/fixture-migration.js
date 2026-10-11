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

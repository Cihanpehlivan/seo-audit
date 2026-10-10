// Optional checks after the crawl: host variants, HSTS, SSL certificate, llms.txt,
// external links and images. Limits come from config/rules.json → checks.
import tls from 'node:tls';
import net from 'node:net';
import { bareHost } from './normalize.js';

const DNS_DEAD = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME']);

// http/https and www/non-www versions of the site root, except the real one.
export function variantsOf(finalUrl) {
  const u = new URL(finalUrl);
  const h = u.hostname;
  const hosts = h === 'localhost' || net.isIP(h.replace(/^\[|\]$/g, '')) ? [h] : [bareHost(h), 'www.' + bareHost(h)];
  const out = [];
  for (const proto of ['http:', 'https:']) {
    for (const host of hosts) {
      const v = `${proto}//${host}${u.port ? ':' + u.port : ''}/`;
      if (v !== `${u.origin}/`) out.push(v);
    }
  }
  return out;
}

// Reads the certificate without trusting it, so expired or self-signed certs are reported too.
export function readCert(host, port = 443, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate() || {};
      const validTo = c.valid_to ? new Date(c.valid_to) : null;
      finish({
        host, port,
        validTo: validTo ? validTo.toISOString() : null,
        daysLeft: validTo ? Math.floor((validTo - Date.now()) / 864e5) : null,
        issuer: c.issuer?.O || c.issuer?.CN || '',
        subject: c.subject?.CN || '',
        authorized: s.authorized,
        error: s.authorized ? null : String(s.authorizationError || 'doğrulanamadı'),
      });
      s.end();
    });
    s.setTimeout(timeoutMs, () => { s.destroy(); finish({ host, port, error: 'timeout', connectFailed: true }); });
    s.on('error', (e) => finish({ host, port, error: e.code || e.message, connectFailed: true }));
  });
}

async function pool(items, n, signal, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length && !signal?.aborted) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

export async function runChecks({ start, root, pages, fetchWithChain, headers, cfg, enabled, variants, guard, signal, onProgress }) {
  const t0 = Date.now();
  const out = { ran: { site: !!enabled.site, external: !!enabled.external, images: !!enabled.images }, site: null, resources: [], limited: { external: 0, images: 0 }, ms: 0 };

  // ---------- Site checks ----------
  if (enabled.site) {
    onProgress?.({ step: 'site', done: 0, total: 0 });
    const byUrl = new Map(pages.map((p) => [p.url, p]));
    let startRec = byUrl.get(start);
    if (startRec?.redirectChain?.length) startRec = byUrl.get(startRec.finalUrl) || startRec;
    const finalStart = startRec?.finalUrl || start;
    const origin = new URL(finalStart).origin;
    const rootRes = await fetchWithChain(origin + '/', { wantBody: false });
    const home = rootRes.status ? rootRes.finalUrl : origin + '/';
    const isHttps = home.startsWith('https:');

    const vList = variants ?? variantsOf(home);
    const vRes = await Promise.all(vList.map(async (url) => {
      const r = await fetchWithChain(url, { wantBody: false });
      return { url, hops: r.chain.length, chain: r.chain.map((h) => h.status), finalUrl: r.finalUrl, finalStatus: r.status, error: r.error || null };
    }));

    let cert = null;
    if (isHttps && !(guard && await guard(home))) { const u = new URL(home); cert = await readCert(u.hostname, +(u.port || 443), cfg.timeoutMs); }

    const llmsUrl = origin + '/llms.txt';
    const lr = await fetchWithChain(llmsUrl);
    const llmsOk = lr.status === 200 && !/html/i.test(lr.contentType || '') && !!lr.body && !lr.body.trimStart().startsWith('<');

    out.site = {
      home, homeHops: rootRes.chain.length,
      variants: vRes,
      hsts: isHttps ? (startRec?.hsts ?? rootRes.hsts ?? '') : null,
      tls: cert,
      llms: { url: llmsUrl, status: lr.status, contentType: lr.contentType || '', ok: llmsOk, bytes: llmsOk ? lr.size : 0 },
    };
  }

  // ---------- External links and images ----------
  const wanted = new Map(); // url -> Set(kind)
  const counts = { external: 0, images: 0 };
  const add = (url, kind, cap, key) => {
    if (!/^https?:/i.test(url)) return;
    if (!wanted.has(url)) {
      if (counts[key] >= cap) { out.limited[key]++; return; }
      counts[key]++;
      wanted.set(url, new Set());
    }
    wanted.get(url).add(kind);
  };
  for (const p of pages) {
    if (enabled.external) for (const l of p.links || []) if (!l.internal) add(l.url, 'link', cfg.maxExternalLinks, 'external');
    if (enabled.images) for (const img of p.images || []) if (img.src && img.src !== 'data:') add(img.src, 'image', cfg.maxImages, 'images');
  }

  const list = [...wanted];
  const deadHosts = new Map();
  const rootBare = bareHost(root.hostname);
  let done = 0;

  // Redirects are followed by hand: every hop is checked by the guard and gets its own headers.
  async function req(url, method, range) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    const t = Date.now();
    try {
      let cur = url;
      for (let hop = 0; hop <= 5; hop++) {
        if (guard) { const why = await guard(cur); if (why) return { status: 0, error: why, ms: Date.now() - t }; }
        // Staging password goes only to the crawled site, never to other hosts.
        const h = bareHost(new URL(cur).hostname) === rootBare ? { ...headers } : { 'user-agent': headers['user-agent'] };
        h.accept = '*/*';
        if (range) h.range = 'bytes=0-0';
        const res = await fetch(cur, { method, headers: h, redirect: 'manual', signal: ctrl.signal });
        res.body?.cancel?.();
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).href; continue; }
        const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1];
        const len = res.headers.get('content-length');
        const size = total ? +total : (res.status !== 206 && len != null ? +len : null);
        return { status: res.status, finalUrl: cur, size, contentType: res.headers.get('content-type') || '', ms: Date.now() - t };
      }
      return { status: 0, error: 'too-many-redirects', ms: Date.now() - t };
    } catch (e) {
      return { status: 0, error: e.name === 'AbortError' ? 'timeout' : e.cause?.code || e.message, ms: Date.now() - t };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  onProgress?.({ step: 'resources', done: 0, total: list.length });
  await pool(list, cfg.concurrency, signal, async ([url, kinds]) => {
    const host = new URL(url).hostname;
    let r;
    if (deadHosts.has(host)) r = { status: 0, error: deadHosts.get(host), ms: 0 };
    else {
      r = await req(url, 'HEAD');
      // Some servers reject HEAD. Ask for one byte with GET before calling the URL broken.
      if (r.status >= 400) { const g = await req(url, 'GET', true); if (g.status) r = g; }
      else if (r.status && r.size == null && kinds.has('image')) { const g = await req(url, 'GET', true); if (g.status && g.status < 400) r = { ...r, size: g.size }; }
      if (DNS_DEAD.has(r.error)) deadHosts.set(host, r.error);
    }
    out.resources.push({
      url, kinds: [...kinds], status: r.status, size: r.size ?? null, contentType: r.contentType || '',
      ...(r.finalUrl && r.finalUrl !== url ? { finalUrl: r.finalUrl } : {}),
      error: r.error || null, ms: r.ms,
    });
    done++;
    onProgress?.({ step: 'resources', done, total: list.length, url });
  });

  out.ms = Date.now() - t0;
  return out;
}

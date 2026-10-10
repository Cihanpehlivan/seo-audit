// URL normalization and scope helpers.
const TRACKING = /^(utm_|gclid$|fbclid$|msclkid$|yclid$|_ga$|mc_)/i;

export function normalizeUrl(raw, base) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}

// www.example.com and example.com count as the same site.
export function bareHost(host) {
  return host.toLowerCase().replace(/^www\./, '');
}

export function isInternal(url, rootHost) {
  try { return bareHost(new URL(url).hostname) === bareHost(rootHost); } catch { return false; }
}

const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|bmp|avif|mp4|webm|mp3|wav|zip|rar|7z|gz|pdf|docx?|xlsx?|pptx?|css|js|json|xml|txt|woff2?|ttf|eot)(\?.*)?$/i;
export function looksLikeAsset(url) {
  try { return SKIP_EXT.test(new URL(url).pathname); } catch { return false; }
}
